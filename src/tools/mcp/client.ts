import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { JsonValue } from "../../types/run.js";
import type {
  McpAvailableTool,
  McpToolCallRequest,
  McpToolCallResult,
  McpToolResponseContent,
} from "../types.js";
import { McpServerUnavailableError, McpToolCallError } from "../errors.js";
import type { ResolvedMcpServerDefinition } from "./registry.js";

const CLIENT_INFO = {
  name: "architect-engineer-agentic-harness",
  version: "0.1.0",
} as const;

export interface McpServerClientLike {
  close(): Promise<void>;
  connect(): Promise<void>;
  getStderrSummary(): string | undefined;
  listTools(): Promise<McpAvailableTool[]>;
  runTool(request: McpToolCallRequest): Promise<McpToolCallResult>;
}

export type CreateMcpServerClient = (
  server: ResolvedMcpServerDefinition,
) => McpServerClientLike;

export function createMcpServerClient(
  server: ResolvedMcpServerDefinition,
): McpServerClientLike {
  return new SdkMcpServerClient(server);
}

class SdkMcpServerClient implements McpServerClientLike {
  readonly #client = new Client(CLIENT_INFO, { capabilities: {} });
  readonly #server: ResolvedMcpServerDefinition;
  readonly #stderrChunks: string[] = [];
  readonly #transport: StdioClientTransport;
  #connected = false;

  constructor(server: ResolvedMcpServerDefinition) {
    this.#server = server;
    this.#transport = new StdioClientTransport({
      args: server.args,
      command: server.command,
      cwd: server.cwd,
      ...(server.env === undefined ? {} : { env: server.env }),
      stderr: "pipe",
    });
    this.#transport.stderr?.on("data", (chunk) => {
      this.#stderrChunks.push(String(chunk));

      while (this.#stderrChunks.join("").length > 4_000) {
        this.#stderrChunks.shift();
      }
    });
  }

  async connect(): Promise<void> {
    if (this.#connected) {
      return;
    }

    try {
      await this.#client.connect(this.#transport, {
        timeout: this.#server.startupTimeoutMs,
      });
      this.#connected = true;
    } catch (error) {
      throw new McpServerUnavailableError(
        formatUnavailableMessage(
          this.#server.id,
          `Could not start MCP server \`${this.#server.id}\` via \`${this.#server.command}\`: ${describeUnknownError(error)}`,
          this.getStderrSummary(),
        ),
        error instanceof Error ? { cause: error } : undefined,
      );
    }
  }

  async listTools(): Promise<McpAvailableTool[]> {
    await this.connect();

    try {
      const response = await this.#client.listTools(undefined, {
        timeout: this.#server.toolTimeoutMs,
      });

      return response.tools.map((tool) => ({
        description: tool.description,
        name: tool.name,
        server: this.#server.id,
      }));
    } catch (error) {
      throw new McpServerUnavailableError(
        formatUnavailableMessage(
          this.#server.id,
          `MCP server \`${this.#server.id}\` did not answer \`listTools\`: ${describeUnknownError(error)}`,
          this.getStderrSummary(),
        ),
        error instanceof Error ? { cause: error } : undefined,
      );
    }
  }

  async runTool(request: McpToolCallRequest): Promise<McpToolCallResult> {
    await this.connect();

    try {
      const response = await this.#client.callTool(
        {
          ...(request.arguments === undefined
            ? {}
            : { arguments: request.arguments }),
          name: request.name,
        },
        undefined,
        {
          timeout: this.#server.toolTimeoutMs,
        },
      );

      return {
        content:
          "content" in response && Array.isArray(response.content)
            ? response.content.map(normalizeToolContent)
            : [
                {
                  text: JSON.stringify(
                    "toolResult" in response ? response.toolResult : response,
                    null,
                    2,
                  ),
                  type: "text",
                },
              ],
        isError:
          "isError" in response &&
          typeof response.isError === "boolean" &&
          response.isError,
        name: request.name,
        server: this.#server.id,
        ...(hasStructuredContent(response)
          ? {
              structuredContent: normalizeStructuredContent(
                response.structuredContent,
              ),
            }
          : {}),
        toolName: "mcp.call",
      };
    } catch (error) {
      throw new McpToolCallError(
        formatUnavailableMessage(
          this.#server.id,
          `MCP tool \`${this.#server.id}.${request.name}\` failed: ${describeUnknownError(error)}`,
          this.getStderrSummary(),
        ),
        error instanceof Error ? { cause: error } : undefined,
      );
    }
  }

  async close(): Promise<void> {
    try {
      await this.#client.close();
    } catch {
      // Best effort shutdown only.
    }
  }

  getStderrSummary(): string | undefined {
    const stderr = this.#stderrChunks.join("").trim();

    return stderr.length === 0 ? undefined : stderr;
  }
}

function normalizeToolContent(content: {
  [key: string]: unknown;
  type: string;
}): McpToolResponseContent {
  switch (content.type) {
    case "text":
      return {
        text: typeof content.text === "string" ? content.text : "",
        type: "text",
      };
    case "image":
    case "audio":
      return {
        data: typeof content.data === "string" ? content.data : "",
        mimeType:
          typeof content.mimeType === "string"
            ? content.mimeType
            : "application/octet-stream",
        type: content.type,
      };
    case "resource":
      return {
        ...(typeof content.resource === "object" &&
        content.resource !== null &&
        "blob" in content.resource &&
        typeof content.resource.blob === "string"
          ? { blob: content.resource.blob }
          : {}),
        ...(typeof content.resource === "object" &&
        content.resource !== null &&
        "mimeType" in content.resource &&
        typeof content.resource.mimeType === "string"
          ? { mimeType: content.resource.mimeType }
          : {}),
        ...(typeof content.resource === "object" &&
        content.resource !== null &&
        "text" in content.resource &&
        typeof content.resource.text === "string"
          ? { text: content.resource.text }
          : {}),
        type: "resource",
        uri:
          typeof content.resource === "object" &&
          content.resource !== null &&
          "uri" in content.resource &&
          typeof content.resource.uri === "string"
            ? content.resource.uri
            : "",
      };
    case "resource_link":
      return {
        ...(typeof content.description === "string"
          ? { description: content.description }
          : {}),
        ...(typeof content.mimeType === "string"
          ? { mimeType: content.mimeType }
          : {}),
        name: typeof content.name === "string" ? content.name : "",
        ...(typeof content.title === "string" ? { title: content.title } : {}),
        type: "resource_link",
        uri: typeof content.uri === "string" ? content.uri : "",
      };
    default:
      return {
        text: JSON.stringify(content, null, 2),
        type: "text",
      };
  }
}

function hasStructuredContent(value: { [key: string]: unknown }): value is {
  structuredContent: Record<string, unknown>;
} {
  return (
    "structuredContent" in value &&
    typeof value.structuredContent === "object" &&
    value.structuredContent !== null &&
    !Array.isArray(value.structuredContent)
  );
}

function normalizeStructuredContent(
  value: Record<string, unknown>,
): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      toJsonValue(nestedValue),
    ]),
  );
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        toJsonValue(nestedValue),
      ]),
    );
  }

  return String(value);
}

function formatUnavailableMessage(
  serverId: string,
  message: string,
  stderrSummary?: string,
): string {
  return stderrSummary === undefined
    ? message
    : `${message} Server stderr for \`${serverId}\`: ${stderrSummary}`;
}

function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
