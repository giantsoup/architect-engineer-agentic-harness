import type { BuiltInToolName } from "./types.js";

export type BuiltInToolErrorCode =
  | "command-failed"
  | "git-failed"
  | "invalid-input"
  | "invalid-state"
  | "path-violation"
  | "permission-denied";

export type McpToolErrorCode =
  | "mcp-call-failed"
  | "mcp-not-allowed"
  | "mcp-server-unavailable"
  | "mcp-tool-not-found";

export class BuiltInToolError extends Error {
  readonly code: BuiltInToolErrorCode;
  readonly toolName: BuiltInToolName;

  constructor(
    toolName: BuiltInToolName,
    code: BuiltInToolErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);

    this.name = "BuiltInToolError";
    this.code = code;
    this.toolName = toolName;
  }
}

export class BuiltInToolInputError extends BuiltInToolError {
  constructor(
    toolName: BuiltInToolName,
    message: string,
    options?: ErrorOptions,
  ) {
    super(toolName, "invalid-input", message, options);

    this.name = "BuiltInToolInputError";
  }
}

export class BuiltInToolPermissionError extends BuiltInToolError {
  constructor(
    toolName: BuiltInToolName,
    message: string,
    options?: ErrorOptions,
  ) {
    super(toolName, "permission-denied", message, options);

    this.name = "BuiltInToolPermissionError";
  }
}

export class BuiltInToolPathError extends BuiltInToolError {
  constructor(
    toolName: BuiltInToolName,
    message: string,
    options?: ErrorOptions,
  ) {
    super(toolName, "path-violation", message, options);

    this.name = "BuiltInToolPathError";
  }
}

export class BuiltInToolStateError extends BuiltInToolError {
  constructor(
    toolName: BuiltInToolName,
    message: string,
    options?: ErrorOptions,
  ) {
    super(toolName, "invalid-state", message, options);

    this.name = "BuiltInToolStateError";
  }
}

export class BuiltInToolCommandError extends BuiltInToolError {
  constructor(
    toolName: BuiltInToolName,
    message: string,
    options?: ErrorOptions,
  ) {
    super(toolName, "command-failed", message, options);

    this.name = "BuiltInToolCommandError";
  }
}

export class BuiltInToolGitError extends BuiltInToolError {
  constructor(
    toolName: BuiltInToolName,
    message: string,
    options?: ErrorOptions,
  ) {
    super(toolName, "git-failed", message, options);

    this.name = "BuiltInToolGitError";
  }
}

export class McpToolError extends Error {
  readonly code: McpToolErrorCode;
  readonly toolName: "mcp.call";

  constructor(code: McpToolErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);

    this.name = "McpToolError";
    this.code = code;
    this.toolName = "mcp.call";
  }
}

export class McpToolNotAllowedError extends McpToolError {
  constructor(message: string, options?: ErrorOptions) {
    super("mcp-not-allowed", message, options);

    this.name = "McpToolNotAllowedError";
  }
}

export class McpServerUnavailableError extends McpToolError {
  constructor(message: string, options?: ErrorOptions) {
    super("mcp-server-unavailable", message, options);

    this.name = "McpServerUnavailableError";
  }
}

export class McpToolNotFoundError extends McpToolError {
  constructor(message: string, options?: ErrorOptions) {
    super("mcp-tool-not-found", message, options);

    this.name = "McpToolNotFoundError";
  }
}

export class McpToolCallError extends McpToolError {
  constructor(message: string, options?: ErrorOptions) {
    super("mcp-call-failed", message, options);

    this.name = "McpToolCallError";
  }
}
