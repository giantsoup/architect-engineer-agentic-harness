import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { DEFAULT_SCHEMA_VERSION } from "../versioning.js";
import type { ToolRequest } from "../tools/types.js";
import type {
  ModelStructuredOutputSpec,
  ModelToolCall,
  ModelToolDefinition,
} from "./types.js";

export interface EngineerToolAction {
  request: ToolRequest;
  stopWhenSuccessful?: boolean | undefined;
  summary: string;
  type: "tool";
}

export interface EngineerFinalAction {
  blockers?: string[] | undefined;
  outcome: "blocked" | "complete";
  summary: string;
  type: "final";
}

export type EngineerAction = EngineerFinalAction | EngineerToolAction;

export interface EngineerControlOutputOptions {
  schemaVersion?: string;
}

interface NormalizeEngineerToolRequestOptions {
  dropUnexpectedProperties?: boolean;
}

export interface EngineerToolCallAction extends EngineerToolAction {
  toolCallId: string;
}

export type EngineerTurn = EngineerFinalAction | EngineerToolCallAction;

export class EngineerTurnValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      [
        "Engineer response did not match the required tool-call/final protocol:",
        ...issues.map((issue) => `- ${issue}`),
      ].join("\n"),
    );

    this.name = "EngineerTurnValidationError";
    this.issues = issues;
  }
}

export class EngineerControlOutputValidationError extends Error {
  readonly issues: readonly string[];
  readonly schemaPath: string;

  constructor(schemaPath: string, issues: readonly string[]) {
    super(
      [
        `Invalid Engineer control output for schema ${schemaPath}:`,
        ...issues.map((issue) => `- ${issue}`),
      ].join("\n"),
    );

    this.name = "EngineerControlOutputValidationError";
    this.issues = issues;
    this.schemaPath = schemaPath;
  }
}

const schemaCache = new Map<string, Promise<Record<string, unknown>>>();
const SUPPORTED_TOOL_NAMES = new Set([
  "command.execute",
  "file.list",
  "file.read_many",
  "file.read",
  "file.search",
  "file.write",
  "git.diff",
  "git.status",
  "mcp.call",
]);

const ENGINEER_TOOL_DEFINITIONS: readonly ModelToolDefinition[] = Object.freeze(
  [
    {
      description:
        "Run a project command. Use this for checks, tests, or build steps.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          accessMode: {
            enum: ["inspect", "mutate"],
          },
          command: {
            minLength: 1,
            type: "string",
          },
          environment: {
            additionalProperties: {
              type: ["boolean", "number", "string"],
            },
            type: "object",
          },
          timeoutMs: {
            minimum: 1,
            type: "integer",
          },
          workingDirectory: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["command"],
        type: "object",
      },
      name: "command.execute",
    },
    {
      description:
        "List files in a directory when search-first inspection is not enough.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          path: {
            minLength: 1,
            type: "string",
          },
        },
        type: "object",
      },
      name: "file.list",
    },
    {
      description: "Read a single file.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          path: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["path"],
        type: "object",
      },
      name: "file.read",
    },
    {
      description: "Read a small batch of files together.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          paths: {
            items: {
              minLength: 1,
              type: "string",
            },
            maxItems: 8,
            minItems: 1,
            type: "array",
          },
        },
        required: ["paths"],
        type: "object",
      },
      name: "file.read_many",
    },
    {
      description: "Search the repository for a symbol, string, or pattern.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          limit: {
            maximum: 20,
            minimum: 1,
            type: "integer",
          },
          path: {
            minLength: 1,
            type: "string",
          },
          query: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["query"],
        type: "object",
      },
      name: "file.search",
    },
    {
      description: "Write a file with the provided contents.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          content: {
            type: "string",
          },
          path: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["content", "path"],
        type: "object",
      },
      name: "file.write",
    },
    {
      description: "Show the current git diff.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          staged: {
            type: "boolean",
          },
        },
        type: "object",
      },
      name: "git.diff",
    },
    {
      description: "Show the current git status.",
      inputSchema: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
      name: "git.status",
    },
    {
      description:
        "Call an allowlisted MCP tool by server and tool name when built-in tools are not enough.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          arguments: {
            type: "object",
          },
          name: {
            minLength: 1,
            type: "string",
          },
          server: {
            minLength: 1,
            type: "string",
          },
        },
        required: ["name", "server"],
        type: "object",
      },
      name: "mcp.call",
    },
  ],
);

export async function loadEngineerControlSchema(
  options: EngineerControlOutputOptions = {},
): Promise<Record<string, unknown>> {
  const schemaVersion = options.schemaVersion ?? DEFAULT_SCHEMA_VERSION;
  const cachedSchema = schemaCache.get(schemaVersion);

  if (cachedSchema !== undefined) {
    return cachedSchema;
  }

  const loadingSchema = loadSchemaFromDisk(schemaVersion);
  schemaCache.set(schemaVersion, loadingSchema);
  return loadingSchema;
}

export async function createEngineerStructuredOutputFormat(
  options: EngineerControlOutputOptions = {},
): Promise<ModelStructuredOutputSpec<EngineerAction>> {
  const schema = await loadEngineerControlSchema(options);

  return {
    allowProviderFallback: true,
    formatDescription: "Engineer execution control message.",
    formatName: "engineer_action",
    schema,
    validate: (value: unknown) => validateEngineerControlOutput(value, options),
  };
}

export async function validateEngineerControlOutput(
  value: unknown,
  options: EngineerControlOutputOptions = {},
): Promise<EngineerAction> {
  const schemaVersion = options.schemaVersion ?? DEFAULT_SCHEMA_VERSION;
  const schemaPath = await resolveEngineerControlSchemaPath(schemaVersion);
  await loadEngineerControlSchema({ schemaVersion });

  const issues: string[] = [];
  const normalizedValue = normalizeEngineerActionCandidate(value);

  if (!isPlainObject(normalizedValue)) {
    throw new EngineerControlOutputValidationError(schemaPath, [
      "engineer_action: Expected an object.",
    ]);
  }

  const type = normalizedValue.type;

  if (type !== "final" && type !== "tool") {
    issues.push('engineer_action.type: Expected `"tool"` or `"final"`.');
  } else if (type === "tool") {
    validateToolAction(normalizedValue, issues);
  } else {
    validateFinalAction(normalizedValue, issues);
  }

  if (issues.length > 0) {
    throw new EngineerControlOutputValidationError(schemaPath, issues);
  }

  return normalizedValue as unknown as EngineerAction;
}

export function createEngineerToolDefinitions(): readonly ModelToolDefinition[] {
  return ENGINEER_TOOL_DEFINITIONS;
}

export async function resolveEngineerTurn(options: {
  rawContent: string;
  toolCalls?: readonly ModelToolCall[] | undefined;
}): Promise<EngineerTurn> {
  if ((options.toolCalls?.length ?? 0) > 0) {
    return parseEngineerToolTurn(options);
  }

  const finalTurn = parseEngineerFinalResponse(options.rawContent);

  if (finalTurn !== undefined) {
    return finalTurn;
  }

  const legacyAction = await parseLegacyEngineerAction(options.rawContent);

  if (legacyAction !== undefined) {
    if (legacyAction.type === "tool") {
      return {
        ...legacyAction,
        toolCallId: "legacy-engineer-action",
      };
    }

    return legacyAction;
  }

  const textualToolTurn = await parseTextualEngineerToolTurn(
    options.rawContent,
  );

  if (textualToolTurn !== undefined) {
    return textualToolTurn;
  }

  throw new EngineerTurnValidationError([
    "Call exactly one tool through the native tool interface, or return `COMPLETE:` / `BLOCKED:` as plain text.",
  ]);
}

export async function validateEngineerToolRequest(
  value: unknown,
  path: string = "tool_call.arguments",
): Promise<ToolRequest> {
  const normalizedValue = normalizeEngineerToolRequestCandidate(value);
  const issues: string[] = [];

  validateToolRequest(normalizedValue, path, issues);

  if (issues.length > 0) {
    throw new EngineerTurnValidationError(issues);
  }

  return normalizedValue as ToolRequest;
}

export function normalizeEngineerToolRequestCandidate(
  value: unknown,
  options: NormalizeEngineerToolRequestOptions = {},
): unknown {
  if (!isPlainObject(value)) {
    return value;
  }

  const toolName = normalizeRequiredTrimmedString(value.toolName);

  if (toolName === undefined) {
    return value;
  }

  switch (toolName) {
    case "file.search": {
      const normalized = createNormalizedToolRequestRecord(
        value,
        toolName,
        options,
      );
      const normalizedLimit = normalizeIntegerLike(value.limit);
      const normalizedPath = normalizeOptionalTrimmedString(value.path);

      if (normalizedLimit !== undefined) {
        normalized.limit = normalizedLimit;
      }

      if (typeof value.path === "string") {
        if (normalizedPath === undefined) {
          delete normalized.path;
        } else {
          normalized.path = normalizedPath;
        }
      }

      if (typeof value.query === "string") {
        normalized.query = normalizeRequiredTrimmedString(value.query);
      }

      return normalized;
    }
    case "file.read_many": {
      const normalized = createNormalizedToolRequestRecord(
        value,
        toolName,
        options,
      );
      const normalizedPaths = normalizeStringList(value.paths);

      if (normalizedPaths !== undefined) {
        normalized.paths = normalizedPaths;
      }

      return normalized;
    }
    case "file.read": {
      const normalized = createNormalizedToolRequestRecord(
        value,
        toolName,
        options,
      );

      if (typeof value.path === "string") {
        normalized.path = normalizeRequiredTrimmedString(value.path);
      }

      return normalized;
    }
    case "file.write": {
      const normalized = createNormalizedToolRequestRecord(
        value,
        toolName,
        options,
      );

      if (typeof value.path === "string") {
        normalized.path = normalizeRequiredTrimmedString(value.path);
      }

      return normalized;
    }
    case "file.list": {
      const normalized = createNormalizedToolRequestRecord(
        value,
        toolName,
        options,
      );
      const normalizedPath = normalizeOptionalTrimmedString(value.path);

      if (typeof value.path === "string") {
        if (normalizedPath === undefined) {
          delete normalized.path;
        } else {
          normalized.path = normalizedPath;
        }
      }

      return normalized;
    }
    case "command.execute": {
      const normalized = createNormalizedToolRequestRecord(
        value,
        toolName,
        options,
      );
      const normalizedAccessMode = normalizeCommandAccessMode(value.accessMode);
      const normalizedTimeoutMs = normalizeIntegerLike(value.timeoutMs);
      const normalizedWorkingDirectory = normalizeOptionalTrimmedString(
        value.workingDirectory,
      );

      if (normalizedAccessMode !== undefined) {
        normalized.accessMode = normalizedAccessMode;
      }

      if (typeof value.command === "string") {
        normalized.command = normalizeRequiredTrimmedString(value.command);
      }

      if (normalizedTimeoutMs !== undefined) {
        normalized.timeoutMs = normalizedTimeoutMs;
      }

      if (typeof value.workingDirectory === "string") {
        if (normalizedWorkingDirectory === undefined) {
          delete normalized.workingDirectory;
        } else {
          normalized.workingDirectory = normalizedWorkingDirectory;
        }
      }

      return normalized;
    }
    case "git.status":
      return createNormalizedToolRequestRecord(value, toolName, options);
    case "git.diff": {
      const normalized = createNormalizedToolRequestRecord(
        value,
        toolName,
        options,
      );
      const normalizedStaged = normalizeBooleanLike(value.staged);

      if (normalizedStaged !== undefined) {
        normalized.staged = normalizedStaged;
      }

      return normalized;
    }
    case "mcp.call": {
      const normalized = createNormalizedToolRequestRecord(
        value,
        toolName,
        options,
      );

      if (typeof value.name === "string") {
        normalized.name = normalizeRequiredTrimmedString(value.name);
      }

      if (typeof value.server === "string") {
        normalized.server = normalizeRequiredTrimmedString(value.server);
      }

      return normalized;
    }
    default:
      return {
        ...value,
        toolName,
      };
  }
}

async function loadSchemaFromDisk(
  schemaVersion: string,
): Promise<Record<string, unknown>> {
  const schemaUrl = await resolveEngineerControlSchemaUrl(schemaVersion);
  const schemaContents = await readFile(schemaUrl, "utf8");

  return JSON.parse(schemaContents) as Record<string, unknown>;
}

async function resolveEngineerControlSchemaPath(
  schemaVersion: string,
): Promise<string> {
  return fileURLToPath(await resolveEngineerControlSchemaUrl(schemaVersion));
}

async function resolveEngineerControlSchemaUrl(
  schemaVersion: string,
): Promise<URL> {
  const candidates = getEngineerControlSchemaCandidates(schemaVersion);

  for (const schemaUrl of candidates) {
    try {
      await readFile(schemaUrl, "utf8");
      return schemaUrl;
    } catch (error) {
      const maybeNodeError = error as NodeJS.ErrnoException;

      if (maybeNodeError.code === "ENOENT") {
        continue;
      }

      const schemaPath = fileURLToPath(schemaUrl);
      const message = error instanceof Error ? error.message : String(error);

      throw new Error(
        `Could not load Engineer schema at ${schemaPath}: ${message}`,
      );
    }
  }

  throw new Error(
    `Could not find Engineer action schema for ${schemaVersion}. Looked for: ${candidates.map((candidate) => fileURLToPath(candidate)).join(", ")}`,
  );
}

function getEngineerControlSchemaCandidates(schemaVersion: string): URL[] {
  return [
    new URL(
      `../../schemas/${schemaVersion}/engineer-action.schema.json`,
      import.meta.url,
    ),
    new URL(
      `../schemas/${schemaVersion}/engineer-action.schema.json`,
      import.meta.url,
    ),
  ];
}

function validateToolAction(
  value: Record<string, unknown>,
  issues: string[],
): void {
  pushUnexpectedProperties(
    "engineer_action",
    value,
    new Set(["request", "stopWhenSuccessful", "summary", "type"]),
    issues,
  );
  validateNonEmptyString(value.summary, "engineer_action.summary", issues);

  if (
    value.stopWhenSuccessful !== undefined &&
    typeof value.stopWhenSuccessful !== "boolean"
  ) {
    issues.push("engineer_action.stopWhenSuccessful: Expected a boolean.");
  }

  validateToolRequest(value.request, "engineer_action.request", issues);
}

function validateFinalAction(
  value: Record<string, unknown>,
  issues: string[],
): void {
  pushUnexpectedProperties(
    "engineer_action",
    value,
    new Set(["blockers", "outcome", "summary", "type"]),
    issues,
  );
  validateNonEmptyString(value.summary, "engineer_action.summary", issues);

  if (typeof value.outcome !== "string") {
    issues.push("engineer_action.outcome: Expected a string.");
  } else if (!["blocked", "complete"].includes(value.outcome)) {
    issues.push(
      'engineer_action.outcome: Expected `"complete"` or `"blocked"`.',
    );
  }

  if (value.blockers !== undefined) {
    validateStringArray(value.blockers, "engineer_action.blockers", issues);
  }
}

function normalizeEngineerActionCandidate(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value;
  }

  const normalizedType = normalizeLowercaseString(value.type);

  if (normalizedType === "tool") {
    const normalized: Record<string, unknown> = {
      ...value,
      request: normalizeEngineerToolRequestCandidate(value.request),
      summary:
        typeof value.summary === "string"
          ? normalizeRequiredTrimmedString(value.summary)
          : value.summary,
      type: normalizedType,
    };
    const normalizedStopWhenSuccessful = normalizeBooleanLike(
      value.stopWhenSuccessful,
    );

    if (normalizedStopWhenSuccessful !== undefined) {
      normalized.stopWhenSuccessful = normalizedStopWhenSuccessful;
    }

    return normalized;
  }

  if (normalizedType === "final") {
    const normalized: Record<string, unknown> = {
      ...value,
      outcome:
        typeof value.outcome === "string"
          ? normalizeLowercaseString(value.outcome)
          : value.outcome,
      summary:
        typeof value.summary === "string"
          ? normalizeRequiredTrimmedString(value.summary)
          : value.summary,
      type: normalizedType,
    };
    const normalizedBlockers = normalizeStringList(value.blockers);

    if (normalizedBlockers !== undefined) {
      normalized.blockers = normalizedBlockers;
    }

    return normalized;
  }

  return value;
}

function validateToolRequest(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!isPlainObject(value)) {
    issues.push(`${path}: Expected an object.`);
    return;
  }

  const toolName = value.toolName;

  if (typeof toolName !== "string") {
    issues.push(`${path}.toolName: Expected a string.`);
    return;
  }

  if (!SUPPORTED_TOOL_NAMES.has(toolName)) {
    issues.push(`${path}.toolName: Unsupported tool.`);
    return;
  }

  switch (toolName) {
    case "file.search":
      pushUnexpectedProperties(
        path,
        value,
        new Set(["limit", "path", "query", "toolName"]),
        issues,
      );
      validateNonEmptyString(value.query, `${path}.query`, issues);

      if (value.path !== undefined) {
        validateNonEmptyString(value.path, `${path}.path`, issues);
      }

      if (
        value.limit !== undefined &&
        (typeof value.limit !== "number" ||
          !Number.isInteger(value.limit) ||
          value.limit <= 0 ||
          value.limit > 20)
      ) {
        issues.push(`${path}.limit: Expected an integer between 1 and 20.`);
      }

      return;
    case "file.read_many":
      pushUnexpectedProperties(
        path,
        value,
        new Set(["paths", "toolName"]),
        issues,
      );

      if (!Array.isArray(value.paths) || value.paths.length === 0) {
        issues.push(
          `${path}.paths: Expected a non-empty array of relative file paths.`,
        );
      } else if (value.paths.length > 8) {
        issues.push(`${path}.paths: Expected at most 8 file paths.`);
      } else {
        for (const [index, item] of value.paths.entries()) {
          validateNonEmptyString(item, `${path}.paths[${index}]`, issues);
        }
      }

      return;
    case "file.read":
      pushUnexpectedProperties(
        path,
        value,
        new Set(["path", "toolName"]),
        issues,
      );
      validateNonEmptyString(value.path, `${path}.path`, issues);
      return;
    case "file.write":
      pushUnexpectedProperties(
        path,
        value,
        new Set(["content", "path", "toolName"]),
        issues,
      );
      validateString(value.content, `${path}.content`, issues);
      validateNonEmptyString(value.path, `${path}.path`, issues);
      return;
    case "file.list":
      pushUnexpectedProperties(
        path,
        value,
        new Set(["path", "toolName"]),
        issues,
      );

      if (value.path !== undefined) {
        validateNonEmptyString(value.path, `${path}.path`, issues);
      }

      return;
    case "command.execute":
      pushUnexpectedProperties(
        path,
        value,
        new Set([
          "accessMode",
          "command",
          "environment",
          "timeoutMs",
          "toolName",
          "workingDirectory",
        ]),
        issues,
      );
      validateNonEmptyString(value.command, `${path}.command`, issues);

      if (
        value.accessMode !== undefined &&
        value.accessMode !== "inspect" &&
        value.accessMode !== "mutate"
      ) {
        issues.push(`${path}.accessMode: Expected \`inspect\` or \`mutate\`.`);
      }

      if (
        value.timeoutMs !== undefined &&
        (typeof value.timeoutMs !== "number" ||
          !Number.isInteger(value.timeoutMs) ||
          value.timeoutMs <= 0)
      ) {
        issues.push(`${path}.timeoutMs: Expected a positive integer.`);
      }

      if (value.workingDirectory !== undefined) {
        validateNonEmptyString(
          value.workingDirectory,
          `${path}.workingDirectory`,
          issues,
        );
      }

      if (value.environment !== undefined) {
        validateEnvironmentObject(
          value.environment,
          `${path}.environment`,
          issues,
        );
      }

      return;
    case "git.status":
      pushUnexpectedProperties(path, value, new Set(["toolName"]), issues);
      return;
    case "git.diff":
      pushUnexpectedProperties(
        path,
        value,
        new Set(["staged", "toolName"]),
        issues,
      );

      if (value.staged !== undefined && typeof value.staged !== "boolean") {
        issues.push(`${path}.staged: Expected a boolean.`);
      }

      return;
    case "mcp.call":
      pushUnexpectedProperties(
        path,
        value,
        new Set(["arguments", "name", "server", "toolName"]),
        issues,
      );
      validateNonEmptyString(value.server, `${path}.server`, issues);
      validateNonEmptyString(value.name, `${path}.name`, issues);

      if (value.arguments !== undefined) {
        validateJsonObject(value.arguments, `${path}.arguments`, issues);
      }

      return;
  }
}

function parseEngineerToolTurn(options: {
  rawContent: string;
  toolCalls?: readonly ModelToolCall[] | undefined;
}): Promise<EngineerToolCallAction> {
  const toolCalls = options.toolCalls ?? [];

  if (toolCalls.length !== 1) {
    throw new EngineerTurnValidationError([
      `Expected exactly one tool call, but received ${toolCalls.length}.`,
    ]);
  }

  return toEngineerToolTurn(toolCalls[0]!, options.rawContent);
}

async function toEngineerToolTurn(
  toolCall: ModelToolCall,
  rawContent: string,
): Promise<EngineerToolCallAction> {
  const request = await validateEngineerToolRequest(
    {
      ...toolCall.arguments,
      toolName: toolCall.name,
    },
    `tool_call.${toolCall.name}`,
  );
  const note = parseEngineerToolCallNote(rawContent, toolCall.name);

  return {
    request,
    stopWhenSuccessful: note.stopWhenSuccessful,
    summary: note.summary,
    toolCallId: toolCall.id,
    type: "tool",
  };
}

function parseEngineerToolCallNote(
  rawContent: string,
  toolName: string,
): { stopWhenSuccessful?: boolean | undefined; summary: string } {
  const normalizedLines = rawContent
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const stopWhenSuccessful = normalizedLines.some(
    (line) => line.toUpperCase() === "STOP_ON_SUCCESS",
  );
  const summary =
    normalizedLines.find((line) => line.toUpperCase() !== "STOP_ON_SUCCESS") ??
    `Call \`${toolName}\`.`;

  return stopWhenSuccessful ? { stopWhenSuccessful, summary } : { summary };
}

function parseEngineerFinalResponse(
  rawContent: string,
): EngineerFinalAction | undefined {
  const trimmed = rawContent.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  const lines = trimmed
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const matchedLineIndex = lines.findIndex((line) =>
    /^(COMPLETE|BLOCKED)\s*:?\s*(.*)$/iu.test(line),
  );

  if (matchedLineIndex === -1) {
    return undefined;
  }

  const matchedPrefix = /^(COMPLETE|BLOCKED)\s*:?\s*(.*)$/iu.exec(
    lines[matchedLineIndex]!,
  );

  if (matchedPrefix === null) {
    return undefined;
  }

  const outcome =
    matchedPrefix[1]!.toLowerCase() === "blocked" ? "blocked" : "complete";
  const summaryParts = [
    matchedPrefix[2]!,
    ...lines
      .slice(matchedLineIndex + 1)
      .filter((line) => !line.startsWith("- ")),
  ];
  const summary = summaryParts.join(" ").trim();

  if (summary.length === 0) {
    throw new EngineerTurnValidationError([
      `Final ${matchedPrefix[1]!.toUpperCase()} response must include a short summary.`,
    ]);
  }

  const blockers =
    outcome === "blocked"
      ? lines
          .slice(matchedLineIndex + 1)
          .filter((line) => line.startsWith("- "))
          .map((line) => line.slice(2).trim())
          .filter((line) => line.length > 0)
      : undefined;

  return blockers === undefined || blockers.length === 0
    ? {
        outcome,
        summary,
        type: "final",
      }
    : {
        blockers,
        outcome,
        summary,
        type: "final",
      };
}

async function parseLegacyEngineerAction(
  rawContent: string,
): Promise<EngineerAction | undefined> {
  const candidates = collectJsonObjectCandidates(rawContent);

  for (const candidate of candidates) {
    try {
      const parsedCandidate = JSON.parse(candidate);
      return await validateEngineerControlOutput(parsedCandidate);
    } catch {
      continue;
    }
  }

  return undefined;
}

async function parseTextualEngineerToolTurn(
  rawContent: string,
): Promise<EngineerToolCallAction | undefined> {
  const textualToolCall = extractTextualToolCall(rawContent);

  if (textualToolCall === undefined) {
    return undefined;
  }

  const request = await validateEngineerToolRequest(
    {
      ...textualToolCall.arguments,
      toolName: textualToolCall.toolName,
    },
    `text_tool_call.${textualToolCall.toolName}`,
  );
  const summary = summarizeTextualEngineerToolCall(rawContent, textualToolCall);

  return {
    request,
    ...(summary.stopWhenSuccessful === true
      ? { stopWhenSuccessful: true }
      : {}),
    summary: summary.summary,
    toolCallId: "textual-engineer-tool-call",
    type: "tool",
  };
}

function collectJsonObjectCandidates(rawContent: string): string[] {
  const fencedCandidate = extractJsonFence(rawContent);

  if (fencedCandidate !== undefined) {
    return [fencedCandidate, ...collectBalancedJsonObjects(rawContent)];
  }

  return collectBalancedJsonObjects(rawContent);
}

function extractJsonFence(rawContent: string): string | undefined {
  const fencedMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(
    rawContent.trim(),
  );

  return fencedMatch?.[1];
}

function collectBalancedJsonObjects(rawContent: string): string[] {
  const candidates: string[] = [];

  for (let index = 0; index < rawContent.length; index += 1) {
    if (rawContent[index] !== "{") {
      continue;
    }

    const endIndex = findBalancedJsonEnd(rawContent, index);

    if (endIndex === undefined) {
      continue;
    }

    candidates.push(rawContent.slice(index, endIndex + 1));
    index = endIndex;
  }

  return candidates;
}

function findBalancedJsonEnd(
  rawContent: string,
  startIndex: number,
): number | undefined {
  const stack = [rawContent[startIndex]];
  let inString = false;
  let isEscaped = false;

  for (let index = startIndex + 1; index < rawContent.length; index += 1) {
    const character = rawContent[index];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (character === "\\") {
        isEscaped = true;
        continue;
      }

      if (character === '"') {
        inString = false;
      }

      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === "{") {
      stack.push(character);
      continue;
    }

    if (character !== "}") {
      continue;
    }

    stack.pop();

    if (stack.length === 0) {
      return index;
    }
  }

  return undefined;
}

function validateEnvironmentObject(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!isPlainObject(value)) {
    issues.push(`${path}: Expected an object.`);
    return;
  }

  for (const [key, entryValue] of Object.entries(value)) {
    if (
      typeof entryValue !== "boolean" &&
      typeof entryValue !== "number" &&
      typeof entryValue !== "string"
    ) {
      issues.push(
        `${path}.${key}: Expected a string, number, or boolean value.`,
      );
    }
  }
}

function validateJsonObject(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!isPlainObject(value)) {
    issues.push(`${path}: Expected an object.`);
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    validateJsonValue(nestedValue, `${path}.${key}`, issues);
  }
}

function validateJsonValue(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateJsonValue(item, `${path}[${index}]`, issues),
    );
    return;
  }

  if (isPlainObject(value)) {
    for (const [key, nestedValue] of Object.entries(value)) {
      validateJsonValue(nestedValue, `${path}.${key}`, issues);
    }
    return;
  }

  issues.push(`${path}: Expected JSON-compatible data.`);
}

function validateString(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== "string") {
    issues.push(`${path}: Expected a string.`);
  }
}

function validateNonEmptyString(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (typeof value !== "string") {
    issues.push(`${path}: Expected a string.`);
    return;
  }

  if (value.length === 0) {
    issues.push(`${path}: Expected at least 1 character.`);
  }
}

function validateStringArray(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!Array.isArray(value)) {
    issues.push(`${path}: Expected an array.`);
    return;
  }

  for (const [index, item] of value.entries()) {
    validateNonEmptyString(item, `${path}[${index}]`, issues);
  }
}

function normalizeRequiredTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmedValue = value.trim();

  return trimmedValue.length === 0 ? "" : trimmedValue;
}

function normalizeLowercaseString(value: unknown): string | undefined {
  const normalized = normalizeRequiredTrimmedString(value);

  return normalized === undefined ? undefined : normalized.toLowerCase();
}

function normalizeOptionalTrimmedString(value: unknown): string | undefined {
  const normalized = normalizeRequiredTrimmedString(value);

  return normalized === "" ? undefined : normalized;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const normalized = normalizeRequiredTrimmedString(value);

    return normalized === undefined ? undefined : [normalized];
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.map((entry) =>
    typeof entry === "string" ? entry.trim() : entry,
  ) as string[];
}

function normalizeIntegerLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value !== "string" || !/^-?\d+$/u.test(value.trim())) {
    return undefined;
  }

  return Number.parseInt(value.trim(), 10);
}

function normalizeBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case "true":
      return true;
    case "false":
      return false;
    default:
      return undefined;
  }
}

function normalizeKeywordLiteral(value: unknown): string | undefined {
  const normalized = normalizeRequiredTrimmedString(value);

  if (normalized === undefined) {
    return undefined;
  }

  return normalized.replace(/^[`"'“”‘’\s]+|[`"'“”‘’\s.,;:!?]+$/gu, "");
}

function normalizeCommandAccessMode(
  value: unknown,
): "inspect" | "mutate" | undefined {
  const normalized = normalizeKeywordLiteral(value);

  if (normalized === "inspect" || normalized === "mutate") {
    return normalized;
  }

  return undefined;
}

function createNormalizedToolRequestRecord(
  value: Record<string, unknown>,
  toolName: string,
  options: NormalizeEngineerToolRequestOptions,
): Record<string, unknown> {
  return options.dropUnexpectedProperties === true
    ? { toolName }
    : { ...value, toolName };
}

function pushUnexpectedProperties(
  objectName: string,
  value: Record<string, unknown>,
  allowedKeys: Set<string>,
  issues: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(`${objectName}.${key}: Unexpected property.`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractTextualToolCall(rawContent: string):
  | {
      arguments: Record<string, unknown>;
      markerIndex: number;
      toolName: string;
    }
  | undefined {
  const markerMatch = /tool\s+call\s*:\s*([a-z0-9_.-]+)/iu.exec(rawContent);

  if (markerMatch === null) {
    return undefined;
  }

  const toolName = markerMatch[1]!;
  const markerIndex = markerMatch.index;
  const trailingContent = rawContent.slice(
    markerMatch.index + markerMatch[0].length,
  );
  const objectStartOffset = trailingContent.indexOf("{");

  if (objectStartOffset === -1) {
    return {
      arguments: {},
      markerIndex,
      toolName,
    };
  }

  const objectStartIndex =
    markerMatch.index + markerMatch[0].length + objectStartOffset;
  const objectEndIndex = findBalancedJsonEnd(rawContent, objectStartIndex);

  if (objectEndIndex === undefined) {
    return undefined;
  }

  try {
    const parsedArguments = JSON.parse(
      rawContent.slice(objectStartIndex, objectEndIndex + 1),
    );

    if (!isPlainObject(parsedArguments)) {
      return undefined;
    }

    return {
      arguments: parsedArguments,
      markerIndex,
      toolName,
    };
  } catch {
    return undefined;
  }
}

function summarizeTextualEngineerToolCall(
  rawContent: string,
  options: { markerIndex: number; toolName: string },
): { stopWhenSuccessful?: boolean | undefined; summary: string } {
  const prefix = rawContent.slice(0, options.markerIndex).trim();
  const normalizedLines = prefix
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const stopWhenSuccessful = normalizedLines.some(
    (line) => line.toUpperCase() === "STOP_ON_SUCCESS",
  );
  const summary =
    normalizedLines
      .filter((line) => line.toUpperCase() !== "STOP_ON_SUCCESS")
      .join(" ")
      .trim() || `Call \`${options.toolName}\`.`;

  return stopWhenSuccessful ? { stopWhenSuccessful, summary } : { summary };
}
