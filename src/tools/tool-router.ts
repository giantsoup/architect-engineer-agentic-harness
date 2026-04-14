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
  McpServerUnavailableError,
  McpToolCallError,
  McpToolError,
  McpToolNotAllowedError,
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
  #builtInCallCount = 0;
  #closed = false;

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
      this.#builtInCallCount += 1;
      return this.#builtInExecutor.execute(context, request);
    }

    return this.#executeMcpTool(context, request);
  }

  getExecutionSummary(): ToolExecutionSummary {
    const catalog = this.#buildCatalog();

    return {
      ...catalog,
      builtInCallCount: this.#builtInCallCount,
      mcpCallCount: this.#mcpCalls.length,
      mcpCalls: [...this.#mcpCalls],
    };
  }

  async #executeMcpTool(
    context: ToolExecutionContext,
    request: McpToolCallRequest,
  ): Promise<ToolResult> {
    const startedAt = process.hrtime.bigint();
    const timestamp = this.#now().toISOString();

    try {
      if (context.role !== "engineer") {
        throw new McpToolNotAllowedError(
          `${context.role} cannot invoke MCP tools. MCP is restricted to the Engineer tool path.`,
        );
      }

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
