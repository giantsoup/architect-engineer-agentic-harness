import type { RunDossierPaths } from "../artifacts/paths.js";
import { appendToolCall } from "../runtime/run-dossier.js";
import type { LoadedHarnessConfig } from "../types/config.js";
import type { JsonValue, ToolCallRecord } from "../types/run.js";
import {
  createBuiltInToolExecutor,
  type BuiltInToolExecutor,
  type CreateBuiltInToolExecutorOptions,
} from "./built-in-tools.js";
import {
  BuiltInToolError,
  BuiltInToolStateError,
  McpServerUnavailableError,
  McpToolCallError,
  McpToolError,
  McpToolNotFoundError,
} from "./errors.js";
import {
  assertMcpServerAllowed,
  getAllowlistedMcpServerIds,
} from "./mcp/allowlist.js";
import {
  createMcpServerClient,
  type CreateMcpServerClient,
  type McpServerClientLike,
} from "./mcp/client.js";
import {
  listConfiguredMcpServerIds,
  resolveConfiguredMcpServers,
  type ResolvedMcpServerDefinition,
} from "./mcp/registry.js";
import type {
  BuiltInToolName,
  McpAvailableTool,
  McpServerAvailability,
  McpToolCallRequest,
  ToolCatalog,
  ToolExecutionContext,
  ToolExecutionSummary,
  ToolRequest,
  ToolResult,
} from "./types.js";

const BUILT_IN_TOOL_NAMES: BuiltInToolName[] = [
  "command.execute",
  "file.search",
  "file.read_many",
  "file.list",
  "file.read",
  "file.write",
  "git.diff",
  "git.status",
];

export interface CreateToolRouterOptions extends CreateBuiltInToolExecutorOptions {
  mcpClientFactory?: CreateMcpServerClient;
}

interface PreparedMcpServerState {
  client?: McpServerClientLike | undefined;
  message?: string | undefined;
  tools: McpAvailableTool[];
}

interface CachedRepoFact {
  summary: string;
}

export class ToolRouter {
  readonly #builtInExecutor: BuiltInToolExecutor;
  readonly #dossierPaths: RunDossierPaths | undefined;
  readonly #loadedConfig: LoadedHarnessConfig;
  readonly #mcpClientFactory: CreateMcpServerClient;
  readonly #mcpPreparedState = new Map<string, PreparedMcpServerState>();
  readonly #mcpServers: Map<string, ResolvedMcpServerDefinition>;
  readonly #now: () => Date;
  readonly #summaryBase: {
    builtInTools: BuiltInToolName[];
    configuredServers: string[];
  };
  readonly #mcpCalls: ToolExecutionSummary["mcpCalls"] = [];
  readonly #listFacts = new Map<string, CachedRepoFact>();
  readonly #readFacts = new Map<string, CachedRepoFact>();
  #builtInCallCount = 0;
  #closed = false;
  #duplicateExplorationSuppressions = 0;
  #repeatedListingCount = 0;
  #repeatedReadCount = 0;
  #repoMemoryHits = 0;

  constructor(options: CreateToolRouterOptions) {
    this.#builtInExecutor =
      "projectCommandRunner" in options &&
      options.projectCommandRunner !== undefined
        ? createBuiltInToolExecutor(options)
        : createBuiltInToolExecutor(options);
    this.#dossierPaths = options.dossierPaths;
    this.#loadedConfig = options.loadedConfig;
    this.#mcpClientFactory = options.mcpClientFactory ?? createMcpServerClient;
    this.#mcpServers = new Map(
      resolveConfiguredMcpServers(this.#loadedConfig).map((server) => [
        server.id,
        server,
      ]),
    );
    this.#now = options.now ?? (() => new Date());
    this.#summaryBase = {
      builtInTools: [...BUILT_IN_TOOL_NAMES],
      configuredServers: listConfiguredMcpServerIds(this.#loadedConfig),
    };
  }

  async close(reason?: string): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#builtInExecutor.close(reason);
    await Promise.all(
      [...this.#mcpPreparedState.values()].map((state) =>
        state.client?.close(),
      ),
    );
  }

  async prepare(): Promise<ToolCatalog> {
    this.#assertOpen("prepare");
    await Promise.all(
      getAllowlistedMcpServerIds(this.#loadedConfig).map((serverId) =>
        this.#prepareMcpServer(serverId),
      ),
    );

    return this.#buildCatalog();
  }

  async execute(
    context: ToolExecutionContext,
    request: ToolRequest,
  ): Promise<ToolResult> {
    this.#assertOpen(request.toolName);

    if (request.toolName !== "mcp.call") {
      const startedAt = process.hrtime.bigint();
      const timestamp = this.#now().toISOString();
      this.#builtInCallCount += 1;
      const duplicateExplorationError =
        this.#maybeCreateDuplicateExplorationError(request, context.role);

      if (duplicateExplorationError !== undefined) {
        await this.#appendToolCall({
          durationMs: getDurationMs(startedAt),
          error: {
            code: duplicateExplorationError.code,
            message: duplicateExplorationError.message,
            name: duplicateExplorationError.name,
          },
          request: summarizeBuiltInRequest(request),
          role: context.role,
          status: "failed",
          timestamp,
          toolName: request.toolName,
        });
        throw duplicateExplorationError;
      }

      if (isWorkspaceMutationRequest(request)) {
        this.#clearRepoMemory();
      }

      const result = await this.#builtInExecutor.execute(context, request);
      this.#rememberRepoFacts(result);
      return result;
    }

    return this.#executeMcpTool(context, request);
  }

  getExecutionSummary(): ToolExecutionSummary {
    const catalog = this.#buildCatalog();

    return {
      ...catalog,
      builtInCallCount: this.#builtInCallCount,
      duplicateExplorationSuppressions: this.#duplicateExplorationSuppressions,
      mcpCallCount: this.#mcpCalls.length,
      mcpCalls: [...this.#mcpCalls],
      repeatedListingCount: this.#repeatedListingCount,
      repeatedReadCount: this.#repeatedReadCount,
      repoMemoryHits: this.#repoMemoryHits,
    };
  }

  #maybeCreateDuplicateExplorationError(
    request: Exclude<ToolRequest, McpToolCallRequest>,
    role: ToolExecutionContext["role"],
  ): BuiltInToolStateError | undefined {
    if (role !== "engineer" && role !== "agent") {
      return undefined;
    }

    switch (request.toolName) {
      case "file.read": {
        const fact = this.#readFacts.get(request.path);

        if (fact === undefined) {
          return undefined;
        }

        this.#duplicateExplorationSuppressions += 1;
        this.#repeatedReadCount += 1;
        this.#repoMemoryHits += 1;
        return new BuiltInToolStateError(
          request.toolName,
          [
            `Repeated read for \`${request.path}\` was suppressed.`,
            fact.summary,
            "Reuse the earlier file contents unless the workspace changed.",
          ].join(" "),
        );
      }
      case "file.read_many": {
        const cachedFacts = request.paths.map((requestedPath) =>
          this.#readFacts.get(requestedPath),
        );

        if (cachedFacts.some((fact) => fact === undefined)) {
          return undefined;
        }

        this.#duplicateExplorationSuppressions += 1;
        this.#repeatedReadCount += 1;
        this.#repoMemoryHits += 1;
        return new BuiltInToolStateError(
          request.toolName,
          [
            `Repeated batch read for ${formatInlineCodeList(request.paths)} was suppressed.`,
            cachedFacts
              .map((fact) => (fact as CachedRepoFact).summary)
              .join(" "),
            "Reuse the earlier file contents unless the workspace changed.",
          ].join(" "),
        );
      }
      case "file.list": {
        const listPath = request.path ?? ".";
        const fact = this.#listFacts.get(listPath);

        if (fact === undefined) {
          return undefined;
        }

        this.#duplicateExplorationSuppressions += 1;
        this.#repeatedListingCount += 1;
        this.#repoMemoryHits += 1;
        return new BuiltInToolStateError(
          request.toolName,
          [
            `Repeated directory listing for \`${listPath}\` was suppressed.`,
            fact.summary,
            "Reuse the earlier directory snapshot unless the workspace changed.",
          ].join(" "),
        );
      }
      default:
        return undefined;
    }
  }

  #clearRepoMemory(): void {
    this.#listFacts.clear();
    this.#readFacts.clear();
  }

  #rememberRepoFacts(result: ToolResult): void {
    switch (result.toolName) {
      case "file.list":
        this.#listFacts.set(result.path, {
          summary: summarizeListFact(result),
        });
        break;
      case "file.read":
        this.#readFacts.set(result.path, {
          summary: summarizeReadFact(result.path, result.byteLength),
        });
        break;
      case "file.read_many":
        for (const file of result.files) {
          this.#readFacts.set(file.path, {
            summary: summarizeReadFact(file.path, file.byteLength),
          });
        }
        break;
      default:
        break;
    }
  }

  async #executeMcpTool(
    context: ToolExecutionContext,
    request: McpToolCallRequest,
  ): Promise<ToolResult> {
    const startedAt = process.hrtime.bigint();
    const timestamp = this.#now().toISOString();

    try {
      assertMcpServerAllowed(this.#loadedConfig, request.server);
      const state = await this.#prepareMcpServer(request.server);

      if (state.client === undefined) {
        throw new McpServerUnavailableError(
          state.message ??
            `MCP server \`${request.server}\` is unavailable and cannot run \`${request.name}\`.`,
        );
      }

      const availableToolNames = new Set(state.tools.map((tool) => tool.name));

      if (!availableToolNames.has(request.name)) {
        throw new McpToolNotFoundError(
          `MCP tool \`${request.server}.${request.name}\` was not exposed by the configured server.`,
        );
      }

      const result = await state.client.runTool(request);
      this.#mcpCalls.push({
        name: request.name,
        server: request.server,
        status: "completed",
      });
      await this.#appendToolCall({
        durationMs: getDurationMs(startedAt),
        request: summarizeMcpRequest(request),
        result: summarizeMcpResult(result),
        role: context.role,
        status: "completed",
        timestamp,
        toolName: request.toolName,
      });

      return result;
    } catch (error) {
      const normalizedError = normalizeMcpToolError(error, request);

      this.#mcpCalls.push({
        name: request.name,
        server: request.server,
        status: "failed",
      });
      await this.#appendToolCall({
        durationMs: getDurationMs(startedAt),
        error: {
          code: normalizedError.code,
          message: normalizedError.message,
          name: normalizedError.name,
        },
        request: summarizeMcpRequest(request),
        role: context.role,
        status: "failed",
        timestamp,
        toolName: request.toolName,
      });

      throw normalizedError;
    }
  }

  async #prepareMcpServer(serverId: string): Promise<PreparedMcpServerState> {
    const cachedState = this.#mcpPreparedState.get(serverId);

    if (cachedState !== undefined) {
      return cachedState;
    }

    const resolvedServer = this.#mcpServers.get(serverId);

    if (resolvedServer === undefined) {
      const missingState = {
        message: `MCP server \`${serverId}\` is not configured in ${this.#loadedConfig.configPath}.`,
        tools: [],
      } satisfies PreparedMcpServerState;
      this.#mcpPreparedState.set(serverId, missingState);
      return missingState;
    }

    try {
      const client = this.#mcpClientFactory(resolvedServer);
      const tools = await client.listTools();
      const nextState = {
        client,
        tools,
      } satisfies PreparedMcpServerState;

      this.#mcpPreparedState.set(serverId, nextState);
      return nextState;
    } catch (error) {
      const message =
        error instanceof McpToolError
          ? error.message
          : `MCP server \`${serverId}\` is unavailable: ${describeUnknownError(error)}`;
      const nextState = {
        message,
        tools: [],
      } satisfies PreparedMcpServerState;

      this.#mcpPreparedState.set(serverId, nextState);
      return nextState;
    }
  }

  #buildCatalog(): ToolCatalog {
    const allowlistedServers = getAllowlistedMcpServerIds(this.#loadedConfig);
    const available: string[] = [];
    const unavailable: McpServerAvailability["unavailable"] = [];
    const mcpTools: McpAvailableTool[] = [];

    for (const serverId of allowlistedServers) {
      const state = this.#mcpPreparedState.get(serverId);

      if (state?.client !== undefined) {
        available.push(serverId);
        mcpTools.push(...state.tools);
        continue;
      }

      if (state?.message !== undefined) {
        unavailable.push({
          message: state.message,
          server: serverId,
        });
      }
    }

    return {
      builtInTools: [...this.#summaryBase.builtInTools],
      mcpServers: {
        available,
        configured: [...this.#summaryBase.configuredServers],
        unavailable,
      },
      mcpTools: [...mcpTools].sort(
        (left, right) =>
          left.server.localeCompare(right.server, "en") ||
          left.name.localeCompare(right.name, "en"),
      ),
    };
  }

  async #appendToolCall(record: ToolCallRecord): Promise<void> {
    if (this.#dossierPaths === undefined) {
      return;
    }

    await appendToolCall(this.#dossierPaths, record);
  }

  #assertOpen(action: string): void {
    if (this.#closed) {
      throw new Error(`Tool router is closed and cannot ${action}.`);
    }
  }
}

export function createToolRouter(options: CreateToolRouterOptions): ToolRouter {
  return new ToolRouter(options);
}

function summarizeMcpRequest(
  request: McpToolCallRequest,
): Record<string, JsonValue | undefined> {
  return {
    arguments: request.arguments,
    name: request.name,
    server: request.server,
  };
}

function summarizeBuiltInRequest(
  request: Exclude<ToolRequest, McpToolCallRequest>,
): Record<string, JsonValue | undefined> {
  switch (request.toolName) {
    case "command.execute":
      return {
        accessMode: request.accessMode,
        command: request.command,
        workingDirectory: request.workingDirectory,
      };
    case "file.search":
      return {
        limit: request.limit,
        path: request.path,
        query: request.query,
      };
    case "file.read_many":
      return {
        paths: request.paths,
      };
    case "file.list":
      return {
        path: request.path ?? ".",
      };
    case "file.read":
    case "file.write":
      return {
        path: request.path,
      };
    case "git.diff":
      return {
        staged: request.staged,
      };
    case "git.status":
      return {};
  }
}

function isWorkspaceMutationRequest(
  request: Exclude<ToolRequest, McpToolCallRequest>,
): boolean {
  return (
    request.toolName === "file.write" ||
    (request.toolName === "command.execute" && request.accessMode !== "inspect")
  );
}

function summarizeReadFact(path: string, byteLength: number): string {
  return `Stable repo fact: \`${path}\` was already read (${byteLength} bytes).`;
}

function summarizeListFact(
  result: Extract<ToolResult, { toolName: "file.list" }>,
): string {
  const visibleEntries = result.entries
    .slice(0, 4)
    .map((entry) => `\`${entry.path}\``);
  const entrySummary =
    visibleEntries.length === 0 ? "no entries" : visibleEntries.join(", ");

  return `Stable repo fact: \`${result.path}\` was already listed (${result.entries.length} entries; sample: ${entrySummary}).`;
}

function formatInlineCodeList(values: string[]): string {
  return values.map((value) => `\`${value}\``).join(", ");
}

function summarizeMcpResult(
  result: Extract<ToolResult, { toolName: "mcp.call" }>,
): Record<string, JsonValue | undefined> {
  return {
    content: result.content.map((entry) => ({ ...entry })),
    isError: result.isError,
    name: result.name,
    server: result.server,
    structuredContent: result.structuredContent,
  };
}

function normalizeMcpToolError(
  error: unknown,
  request: McpToolCallRequest,
): McpToolError {
  if (error instanceof McpToolError) {
    return error;
  }

  if (error instanceof BuiltInToolError) {
    return new McpToolCallError(
      `Unexpected built-in tool failure while routing \`${request.toolName}\`: ${error.message}`,
      { cause: error },
    );
  }

  return new McpToolCallError(
    `Unexpected MCP failure while executing \`${request.server}.${request.name}\`: ${describeUnknownError(error)}`,
    { cause: error instanceof Error ? error : undefined },
  );
}

function getDurationMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
