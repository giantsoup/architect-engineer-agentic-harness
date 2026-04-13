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

  const allowedKeys = new Set(["artifacts", "status", "summary"]);

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

  if (issues.length > 0) {
    throw new RunResultValidationError(schemaPath, issues);
  }

  const validatedArtifacts = Array.isArray(artifacts)
    ? ([...artifacts] as string[])
    : undefined;

  return {
    artifacts: validatedArtifacts,
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
