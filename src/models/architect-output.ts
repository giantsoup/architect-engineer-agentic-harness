import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { DEFAULT_SCHEMA_VERSION } from "../versioning.js";
import type {
  ArchitectControlAction,
  ArchitectPlanAction,
  ArchitectReviewAction,
  ArchitectStructuredOutputKind,
  ArchitectStructuredOutputSchema,
} from "./types.js";
import { validateEngineerControlOutput } from "./engineer-output.js";

type ArchitectActionByKind = {
  plan: ArchitectPlanAction | ArchitectToolAction;
  review: ArchitectReviewAction | ArchitectToolAction;
};

type ArchitectToolAction = Extract<ArchitectControlAction, { type: "tool" }>;

export class ArchitectControlOutputValidationError extends Error {
  readonly issues: readonly string[];
  readonly schemaPath: string;

  constructor(schemaPath: string, issues: readonly string[]) {
    super(
      [
        `Invalid Architect control output for schema ${schemaPath}:`,
        ...issues.map((issue) => `- ${issue}`),
      ].join("\n"),
    );

    this.name = "ArchitectControlOutputValidationError";
    this.issues = issues;
    this.schemaPath = schemaPath;
  }
}

const schemaCache = new Map<string, Promise<Record<string, unknown>>>();

export interface ArchitectControlOutputOptions {
  schemaVersion?: string;
}

export async function loadArchitectControlSchema(
  kind: ArchitectStructuredOutputKind,
  options: ArchitectControlOutputOptions = {},
): Promise<Record<string, unknown>> {
  const schemaVersion = options.schemaVersion ?? DEFAULT_SCHEMA_VERSION;
  const cacheKey = `${schemaVersion}:${kind}`;

  const cachedSchema = schemaCache.get(cacheKey);

  if (cachedSchema !== undefined) {
    return cachedSchema;
  }

  const loadingSchema = loadSchemaFromDisk(kind, schemaVersion);
  schemaCache.set(cacheKey, loadingSchema);

  return loadingSchema;
}

export async function createArchitectStructuredOutputFormat<
  TKind extends ArchitectStructuredOutputKind,
>(
  kind: TKind,
  options: ArchitectControlOutputOptions = {},
): Promise<ArchitectStructuredOutputSchema<ArchitectActionByKind[TKind]>> {
  const schema = await loadArchitectControlSchema(kind, options);

  return {
    allowProviderFallback: true,
    formatDescription:
      kind === "plan"
        ? "Architect planning control message."
        : "Architect review control message.",
    formatName: kind === "plan" ? "architect_plan" : "architect_review",
    schema,
    validate: (value: unknown) =>
      validateArchitectControlOutput(kind, value, options),
  };
}

export async function validateArchitectControlOutput<
  TKind extends ArchitectStructuredOutputKind,
>(
  kind: TKind,
  value: unknown,
  options: ArchitectControlOutputOptions = {},
): Promise<ArchitectActionByKind[TKind]> {
  const schemaVersion = options.schemaVersion ?? DEFAULT_SCHEMA_VERSION;
  const schemaPath = await resolveArchitectControlSchemaPath(
    kind,
    schemaVersion,
  );
  await loadArchitectControlSchema(kind, { schemaVersion });

  const issues: string[] = [];

  if (!isPlainObject(value)) {
    throw new ArchitectControlOutputValidationError(schemaPath, [
      `${kind}: Expected an object.`,
    ]);
  }

  const actionType = value.type;

  if (actionType === "tool") {
    await validateArchitectToolAction(value, kind, issues);
  } else if (kind === "plan") {
    validateArchitectPlanAction(value, issues);
  } else {
    validateArchitectReviewAction(value, issues);
  }

  if (issues.length > 0) {
    throw new ArchitectControlOutputValidationError(schemaPath, issues);
  }

  return value as unknown as ArchitectActionByKind[TKind];
}

async function loadSchemaFromDisk(
  kind: ArchitectStructuredOutputKind,
  schemaVersion: string,
): Promise<Record<string, unknown>> {
  const schemaUrl = await resolveArchitectControlSchemaUrl(kind, schemaVersion);
  const schemaContents = await readFile(schemaUrl, "utf8");

  return JSON.parse(schemaContents) as Record<string, unknown>;
}

async function resolveArchitectControlSchemaPath(
  kind: ArchitectStructuredOutputKind,
  schemaVersion: string,
): Promise<string> {
  return fileURLToPath(
    await resolveArchitectControlSchemaUrl(kind, schemaVersion),
  );
}

async function resolveArchitectControlSchemaUrl(
  kind: ArchitectStructuredOutputKind,
  schemaVersion: string,
): Promise<URL> {
  const candidates = getArchitectControlSchemaCandidates(kind, schemaVersion);

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
        `Could not load Architect schema at ${schemaPath}: ${message}`,
      );
    }
  }

  throw new Error(
    `Could not find Architect ${kind} schema for ${schemaVersion}. Looked for: ${candidates.map((candidate) => fileURLToPath(candidate)).join(", ")}`,
  );
}

function getArchitectControlSchemaCandidates(
  kind: ArchitectStructuredOutputKind,
  schemaVersion: string,
): URL[] {
  const schemaFileName =
    kind === "plan"
      ? "architect-plan.schema.json"
      : "architect-review.schema.json";

  return [
    new URL(
      `../../schemas/${schemaVersion}/${schemaFileName}`,
      import.meta.url,
    ),
    new URL(`../schemas/${schemaVersion}/${schemaFileName}`, import.meta.url),
  ];
}

function validateArchitectPlanAction(
  value: Record<string, unknown>,
  issues: string[],
): void {
  const allowedKeys = new Set([
    "acceptanceCriteria",
    "steps",
    "summary",
    "type",
  ]);

  pushUnexpectedProperties("plan", value, allowedKeys, issues);

  if (value.type !== undefined && value.type !== "plan") {
    issues.push('plan.type: Expected `"plan"`.');
  }

  validateNonEmptyString(value.summary, "plan.summary", issues);
  validateStringArray(value.steps, "plan.steps", issues);

  if (value.acceptanceCriteria !== undefined) {
    validateStringArray(
      value.acceptanceCriteria,
      "plan.acceptanceCriteria",
      issues,
    );
  }
}

function validateArchitectReviewAction(
  value: Record<string, unknown>,
  issues: string[],
): void {
  const allowedKeys = new Set(["decision", "nextActions", "summary", "type"]);

  pushUnexpectedProperties("review", value, allowedKeys, issues);

  if (value.type !== undefined && value.type !== "review") {
    issues.push('review.type: Expected `"review"`.');
  }

  validateNonEmptyString(value.summary, "review.summary", issues);

  if (typeof value.decision !== "string") {
    issues.push("review.decision: Expected a string.");
  } else if (!["approve", "fail", "revise"].includes(value.decision)) {
    issues.push(
      'review.decision: Expected one of "approve", "revise", or "fail".',
    );
  }

  if (value.nextActions !== undefined) {
    validateStringArray(value.nextActions, "review.nextActions", issues);
  }
}

async function validateArchitectToolAction(
  value: Record<string, unknown>,
  kind: ArchitectStructuredOutputKind,
  issues: string[],
): Promise<void> {
  const allowedKeys = new Set(["request", "summary", "type"]);

  pushUnexpectedProperties(kind, value, allowedKeys, issues);
  validateNonEmptyString(value.summary, `${kind}.summary`, issues);

  try {
    await validateEngineerControlOutput({
      request: value.request,
      summary: String(value.summary ?? ""),
      type: "tool",
    });
  } catch (error) {
    if (error instanceof Error) {
      for (const line of error.message.split("\n")) {
        if (line.startsWith("- engineer_action.request")) {
          issues.push(
            line.replace("- engineer_action.request", `${kind}.request`).trim(),
          );
        }
      }
    }
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
