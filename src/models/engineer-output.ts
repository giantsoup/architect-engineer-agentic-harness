import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { DEFAULT_SCHEMA_VERSION } from "../versioning.js";
import type { ToolRequest } from "../tools/types.js";
import type { ModelStructuredOutputSpec } from "./types.js";

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

  if (!isPlainObject(value)) {
    throw new EngineerControlOutputValidationError(schemaPath, [
      "engineer_action: Expected an object.",
    ]);
  }

  const type = value.type;

  if (type !== "final" && type !== "tool") {
    issues.push('engineer_action.type: Expected `"tool"` or `"final"`.');
  } else if (type === "tool") {
    validateToolAction(value, issues);
  } else {
    validateFinalAction(value, issues);
  }

  if (issues.length > 0) {
    throw new EngineerControlOutputValidationError(schemaPath, issues);
  }

  return value as unknown as EngineerAction;
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
