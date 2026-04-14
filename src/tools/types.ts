import type { HarnessModelRole } from "../models/types.js";
import type {
  ContainerCommandEnvironment,
  ContainerCommandResult,
} from "../sandbox/container-session.js";

export type BuiltInToolName =
  | "command.execute"
  | "file.list"
  | "file.read"
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

export interface FileWriteToolRequest {
  content: string;
  path: string;
  toolName: "file.write";
}

export interface FileWriteToolResult {
  byteLength: number;
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
  | FileReadToolRequest
  | FileWriteToolRequest
  | GitDiffToolRequest
  | GitStatusToolRequest;

export type BuiltInToolResult =
  | CommandExecutionToolResult
  | FileListToolResult
  | FileReadToolResult
  | FileWriteToolResult
  | GitDiffToolResult
  | GitStatusToolResult;

export interface BuiltInToolExecutionContext {
  role: HarnessModelRole;
}
