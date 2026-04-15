import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { RunResult } from "../types/run.js";
import { DEFAULT_SCHEMA_VERSION } from "../versioning.js";

interface RunResultSchema {
  $id?: string;
  title?: string;
}

export interface ValidateRunResultOptions {
  schemaVersion?: string;
}

export class RunResultValidationError extends Error {
  readonly issues: readonly string[];
  readonly schemaPath: string;

  constructor(schemaPath: string, issues: readonly string[]) {
    super(
      [
        `Invalid run result for schema ${schemaPath}:`,
        ...issues.map((issue) => `- ${issue}`),
      ].join("\n"),
    );

    this.name = "RunResultValidationError";
    this.issues = issues;
    this.schemaPath = schemaPath;
  }
}

export async function validateRunResult(
  value: unknown,
  options: ValidateRunResultOptions = {},
): Promise<RunResult> {
  const schemaVersion = options.schemaVersion ?? DEFAULT_SCHEMA_VERSION;
  const schemaPath = await resolveRunResultSchemaPath(schemaVersion);
  await loadRunResultSchema(schemaVersion);

  const issues: string[] = [];

  if (!isPlainObject(value)) {
    throw new RunResultValidationError(schemaPath, [
      "result: Expected an object.",
    ]);
  }

  const allowedKeys = new Set([
    "artifacts",
    "convergence",
    "git",
    "status",
    "summary",
  ]);

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(`result.${key}: Unexpected property.`);
    }
  }

  const status = value.status;

  if (typeof status !== "string") {
    issues.push("result.status: Expected a string.");
  } else if (!["success", "failed", "stopped"].includes(status)) {
    issues.push(
      'result.status: Expected one of "success", "failed", or "stopped".',
    );
  }

  const summary = value.summary;

  if (typeof summary !== "string") {
    issues.push("result.summary: Expected a string.");
  } else if (summary.length === 0) {
    issues.push("result.summary: Expected at least 1 character.");
  }

  const artifacts = value.artifacts;

  if (artifacts !== undefined) {
    if (!Array.isArray(artifacts)) {
      issues.push("result.artifacts: Expected an array.");
    } else {
      for (const [index, artifact] of artifacts.entries()) {
        if (typeof artifact !== "string") {
          issues.push(`result.artifacts[${index}]: Expected a string.`);
          continue;
        }

        if (artifact.length === 0) {
          issues.push(
            `result.artifacts[${index}]: Expected at least 1 character.`,
          );
        }
      }
    }
  }

  const git = value.git;
  const convergence = value.convergence;

  if (git !== undefined) {
    validateGitMetadata(git, issues);
  }

  if (convergence !== undefined) {
    validateConvergenceMetrics(convergence, issues);
  }

  if (issues.length > 0) {
    throw new RunResultValidationError(schemaPath, issues);
  }

  const validatedArtifacts = Array.isArray(artifacts)
    ? ([...artifacts] as string[])
    : undefined;
  const validatedConvergence =
    convergence === undefined ? undefined : value.convergence;
  const validatedGit =
    git === undefined ? undefined : (git as RunResult["git"]);

  return {
    artifacts: validatedArtifacts,
    ...(validatedConvergence === undefined
      ? {}
      : { convergence: validatedConvergence as RunResult["convergence"] }),
    ...(validatedGit === undefined ? {} : { git: validatedGit }),
    status: status as RunResult["status"],
    summary: summary as string,
  };
}

async function loadRunResultSchema(
  schemaVersion: string,
): Promise<RunResultSchema> {
  const schemaUrl = await resolveRunResultSchemaUrl(schemaVersion);
  const schemaContents = await readFile(schemaUrl, "utf8");
  return JSON.parse(schemaContents) as RunResultSchema;
}

async function resolveRunResultSchemaPath(
  schemaVersion: string,
): Promise<string> {
  return fileURLToPath(await resolveRunResultSchemaUrl(schemaVersion));
}

async function resolveRunResultSchemaUrl(schemaVersion: string): Promise<URL> {
  for (const schemaUrl of getRunResultSchemaCandidates(schemaVersion)) {
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
        `Could not load run result schema at ${schemaPath}: ${message}`,
      );
    }
  }

  const attemptedPaths = getRunResultSchemaCandidates(schemaVersion).map(
    (url) => fileURLToPath(url),
  );

  throw new Error(
    `Could not find run result schema for ${schemaVersion}. Looked for: ${attemptedPaths.join(", ")}`,
  );
}

function getRunResultSchemaCandidates(schemaVersion: string): URL[] {
  return [
    new URL(
      `../../schemas/${schemaVersion}/run-result.schema.json`,
      import.meta.url,
    ),
    new URL(
      `../schemas/${schemaVersion}/run-result.schema.json`,
      import.meta.url,
    ),
  ];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateGitMetadata(value: unknown, issues: string[]): void {
  if (!isPlainObject(value)) {
    issues.push("result.git: Expected an object.");
    return;
  }

  const allowedKeys = new Set([
    "createdCommits",
    "dirtyWorkingTreeOutcome",
    "dirtyWorkingTreePolicy",
    "errors",
    "finalCommit",
    "initialWorkingTree",
    "runBranch",
    "startingBranch",
    "startingCommit",
    "warnings",
  ]);

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(`result.git.${key}: Unexpected property.`);
    }
  }

  if (value.dirtyWorkingTreePolicy !== "stop") {
    issues.push('result.git.dirtyWorkingTreePolicy: Expected "stop".');
  }

  if (
    value.dirtyWorkingTreeOutcome !== undefined &&
    value.dirtyWorkingTreeOutcome !== "clean" &&
    value.dirtyWorkingTreeOutcome !== "stopped"
  ) {
    issues.push(
      'result.git.dirtyWorkingTreeOutcome: Expected "clean" or "stopped".',
    );
  }

  validateOptionalString(
    value.startingBranch,
    "result.git.startingBranch",
    issues,
  );
  validateOptionalString(
    value.startingCommit,
    "result.git.startingCommit",
    issues,
  );
  validateOptionalString(value.runBranch, "result.git.runBranch", issues);
  validateOptionalString(value.finalCommit, "result.git.finalCommit", issues);
  validateStringArray(value.warnings, "result.git.warnings", issues);
  validateStringArray(value.errors, "result.git.errors", issues);

  if (!Array.isArray(value.createdCommits)) {
    issues.push("result.git.createdCommits: Expected an array.");
  } else {
    for (const [index, commit] of value.createdCommits.entries()) {
      validateGitCommitSummary(
        commit,
        `result.git.createdCommits[${index}]`,
        issues,
      );
    }
  }

  if (value.initialWorkingTree !== undefined) {
    validateGitWorkingTreeSummary(
      value.initialWorkingTree,
      "result.git.initialWorkingTree",
      issues,
    );
  }
}

function validateConvergenceMetrics(value: unknown, issues: string[]): void {
  if (!isPlainObject(value)) {
    issues.push("result.convergence: Expected an object.");
    return;
  }

  const allowedKeys = new Set([
    "duplicateExplorationSuppressions",
    "explorationBudget",
    "explorationBudgetExhaustedAtStep",
    "repeatedListingCount",
    "repeatedReadCount",
    "repoMemoryHits",
    "stepsToFirstCheck",
    "stepsToFirstEdit",
  ]);

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(`result.convergence.${key}: Unexpected property.`);
    }
  }

  validateRequiredInteger(
    value,
    "duplicateExplorationSuppressions",
    issues,
    "result.convergence",
  );
  validateRequiredInteger(
    value,
    "explorationBudget",
    issues,
    "result.convergence",
  );
  validateOptionalIntegerOrNull(
    value,
    "explorationBudgetExhaustedAtStep",
    issues,
    "result.convergence",
  );
  validateRequiredInteger(
    value,
    "repeatedListingCount",
    issues,
    "result.convergence",
  );
  validateRequiredInteger(
    value,
    "repeatedReadCount",
    issues,
    "result.convergence",
  );
  validateRequiredInteger(
    value,
    "repoMemoryHits",
    issues,
    "result.convergence",
  );
  validateOptionalIntegerOrNull(
    value,
    "stepsToFirstCheck",
    issues,
    "result.convergence",
  );
  validateOptionalIntegerOrNull(
    value,
    "stepsToFirstEdit",
    issues,
    "result.convergence",
  );
}

function validateRequiredInteger(
  value: Record<string, unknown>,
  key: string,
  issues: string[],
  prefix: string,
): void {
  if (!Number.isInteger(value[key])) {
    issues.push(`${prefix}.${key}: Expected an integer.`);
  }
}

function validateOptionalIntegerOrNull(
  value: Record<string, unknown>,
  key: string,
  issues: string[],
  prefix: string,
): void {
  const entry = value[key];

  if (entry !== null && entry !== undefined && !Number.isInteger(entry)) {
    issues.push(`${prefix}.${key}: Expected an integer or null.`);
  }
}

function validateGitCommitSummary(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!isPlainObject(value)) {
    issues.push(`${path}: Expected an object.`);
    return;
  }

  const allowedKeys = new Set(["commitHash", "message", "phase", "recordedAt"]);

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(`${path}.${key}: Unexpected property.`);
    }
  }

  validateRequiredString(value.commitHash, `${path}.commitHash`, issues);
  validateRequiredString(value.message, `${path}.message`, issues);
  validateRequiredString(value.recordedAt, `${path}.recordedAt`, issues);

  if (value.phase !== "engineer-milestone" && value.phase !== "final-state") {
    issues.push(
      `${path}.phase: Expected "engineer-milestone" or "final-state".`,
    );
  }
}

function validateGitWorkingTreeSummary(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!isPlainObject(value)) {
    issues.push(`${path}: Expected an object.`);
    return;
  }

  const allowedKeys = new Set([
    "changedPaths",
    "hasStagedChanges",
    "hasUnstagedChanges",
    "hasUntrackedChanges",
    "isDirty",
  ]);

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(`${path}.${key}: Unexpected property.`);
    }
  }

  if (!Array.isArray(value.changedPaths)) {
    issues.push(`${path}.changedPaths: Expected an array.`);
  } else {
    for (const [index, changedPath] of value.changedPaths.entries()) {
      if (typeof changedPath !== "string" || changedPath.length === 0) {
        issues.push(
          `${path}.changedPaths[${index}]: Expected a non-empty string.`,
        );
      }
    }
  }

  validateRequiredBoolean(
    value.hasStagedChanges,
    `${path}.hasStagedChanges`,
    issues,
  );
  validateRequiredBoolean(
    value.hasUnstagedChanges,
    `${path}.hasUnstagedChanges`,
    issues,
  );
  validateRequiredBoolean(
    value.hasUntrackedChanges,
    `${path}.hasUntrackedChanges`,
    issues,
  );
  validateRequiredBoolean(value.isDirty, `${path}.isDirty`, issues);
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
    if (typeof item !== "string") {
      issues.push(`${path}[${index}]: Expected a string.`);
      continue;
    }

    if (item.length === 0) {
      issues.push(`${path}[${index}]: Expected at least 1 character.`);
    }
  }
}

function validateOptionalString(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (value === undefined) {
    return;
  }

  validateRequiredString(value, path, issues);
}

function validateRequiredString(
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

function validateRequiredBoolean(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (typeof value !== "boolean") {
    issues.push(`${path}: Expected a boolean.`);
  }
}
