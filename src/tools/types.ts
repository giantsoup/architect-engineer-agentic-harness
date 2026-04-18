import type { HarnessModelRole } from "../models/types.js";
import type {
  ContainerCommandEnvironment,
  ContainerCommandResult,
} from "../sandbox/container-session.js";
import type { JsonValue } from "../types/run.js";

export type BuiltInToolName =
  | "command.execute"
  | "file.list"
  | "file.read_many"
  | "file.read"
  | "file.search"
  | "file.write"
  | "git.diff"
  | "git.status";

export interface FileReadToolRequest {
  path: string;
  toolName: "file.read";
}

export interface FileReadToolResult {
  byteLength: number;
  content: string;
  path: string;
  toolName: "file.read";
}

export interface FileReadManyToolRequest {
  paths: string[];
  toolName: "file.read_many";
}

export interface FileReadManyToolResultEntry {
  byteLength: number;
  content: string;
  path: string;
  truncatedCharCount?: number | undefined;
}

export interface FileReadManyToolResult {
  files: FileReadManyToolResultEntry[];
  hiddenPathCount?: number | undefined;
  requestedPathCount: number;
  toolName: "file.read_many";
}

export interface FileWriteToolRequest {
  content: string;
  path: string;
  toolName: "file.write";
}

export interface FileWriteToolResult {
  byteLength: number;
  changed: boolean;
  created: boolean;
  path: string;
  toolName: "file.write";
}

export interface FileListToolRequest {
  path?: string;
  toolName: "file.list";
}

export interface FileListEntry {
  kind: "directory" | "file" | "other" | "symlink";
  name: string;
  path: string;
}

export interface FileListToolResult {
  entries: FileListEntry[];
  path: string;
  toolName: "file.list";
}

export interface FileSearchToolRequest {
  limit?: number;
  path?: string;
  query: string;
  toolName: "file.search";
}

export interface FileSearchToolResultHit {
  line: number;
  preview: string;
}

export interface FileSearchToolResultEntry {
  hits: FileSearchToolResultHit[];
  matchCount: number;
  path: string;
}

export interface FileSearchToolResult {
  hiddenResultCount?: number | undefined;
  path: string;
  query: string;
  results: FileSearchToolResultEntry[];
  searchedFileCount: number;
  skippedFileCount?: number | undefined;
  toolName: "file.search";
}

export interface CommandExecutionToolRequest {
  accessMode?: "inspect" | "mutate";
  command: string;
  environment?: ContainerCommandEnvironment;
  timeoutMs?: number;
  toolName: "command.execute";
  workingDirectory?: string;
}

export interface CommandExecutionToolResult extends ContainerCommandResult {
  toolName: "command.execute";
}

export interface GitStatusToolRequest {
  toolName: "git.status";
}

export interface GitStatusBranchSummary {
  ahead: number;
  behind: number;
  detached: boolean;
  head: string;
  upstream?: string;
}

export interface GitStatusEntry {
  indexStatus: string;
  originalPath?: string;
  path: string;
  workingTreeStatus: string;
}

export interface GitStatusToolResult {
  branch: GitStatusBranchSummary;
  entries: GitStatusEntry[];
  isClean: boolean;
  toolName: "git.status";
}

export interface GitDiffToolRequest {
  staged?: boolean;
  toolName: "git.diff";
}

export interface GitDiffToolResult {
  byteLength: number;
  diff: string;
  isEmpty: boolean;
  staged: boolean;
  toolName: "git.diff";
}

export type BuiltInToolRequest =
  | CommandExecutionToolRequest
  | FileListToolRequest
  | FileReadManyToolRequest
  | FileReadToolRequest
  | FileSearchToolRequest
  | FileWriteToolRequest
  | GitDiffToolRequest
  | GitStatusToolRequest;

export type BuiltInToolResult =
  | CommandExecutionToolResult
  | FileListToolResult
  | FileReadManyToolResult
  | FileReadToolResult
  | FileSearchToolResult
  | FileWriteToolResult
  | GitDiffToolResult
  | GitStatusToolResult;

export interface McpToolCallRequest {
  arguments?: Record<string, JsonValue> | undefined;
  name: string;
  server: string;
  toolName: "mcp.call";
}

export type McpToolResponseContent =
  | {
      text: string;
      type: "text";
    }
  | {
      data: string;
      mimeType: string;
      type: "audio" | "image";
    }
  | {
      blob?: string | undefined;
      mimeType?: string | undefined;
      text?: string | undefined;
      type: "resource";
      uri: string;
    }
  | {
      description?: string | undefined;
      mimeType?: string | undefined;
      name: string;
      title?: string | undefined;
      type: "resource_link";
      uri: string;
    };

export interface McpToolCallResult {
  content: McpToolResponseContent[];
  isError: boolean;
  name: string;
  server: string;
  structuredContent?: Record<string, JsonValue> | undefined;
  toolName: "mcp.call";
}

export interface McpAvailableTool {
  description?: string | undefined;
  name: string;
  server: string;
}

export interface McpServerAvailability {
  available: string[];
  configured: string[];
  unavailable: Array<{
    message: string;
    server: string;
  }>;
}

export interface ToolCatalog {
  builtInTools: BuiltInToolName[];
  mcpServers: McpServerAvailability;
  mcpTools: McpAvailableTool[];
}

export interface ToolExecutionSummary extends ToolCatalog {
  builtInCallCount: number;
  duplicateExplorationSuppressions: number;
  mcpCallCount: number;
  mcpCalls: Array<{
    name: string;
    server: string;
    status: "completed" | "failed";
  }>;
  repeatedListingCount: number;
  repeatedReadCount: number;
  repoMemoryHits: number;
}

export type ToolRequest = BuiltInToolRequest | McpToolCallRequest;

export type ToolResult = BuiltInToolResult | McpToolCallResult;

export interface ToolExecutionContext {
  role: HarnessModelRole;
  signal?: AbortSignal | undefined;
}

export type BuiltInToolExecutionContext = ToolExecutionContext;
