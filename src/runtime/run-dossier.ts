import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { LoadedHarnessConfig } from "../types/config.js";
import type {
  CommandLogRecord,
  RunChecksSummary,
  RunLifecycleStatus,
  RunManifest,
  RunPromptReference,
  RunResult,
  StructuredMessageRecord,
} from "../types/run.js";
import {
  DEFAULT_PROMPT_VERSION,
  DEFAULT_SCHEMA_VERSION,
} from "../versioning.js";
import { appendJsonLine } from "../artifacts/logs.js";
import {
  buildRunDossierPaths,
  DOSSIER_FILE_KINDS,
} from "../artifacts/paths.js";
import type { DossierFileKey, RunDossierPaths } from "../artifacts/paths.js";
import { assertValidRunId, createRunId } from "../artifacts/run-id.js";
import { writeJsonFile } from "../artifacts/json.js";
import { validateRunResult } from "./run-result.js";

export interface InitializeRunDossierOptions {
  createdAt?: Date;
  promptReferences?: readonly RunPromptReference[];
  promptVersion?: string;
  runId?: string;
  schemaVersion?: string;
}

export interface RunDossier {
  manifest: RunManifest;
  paths: RunDossierPaths;
}

export class RunDossierError extends Error {
  readonly runId: string;

  constructor(runId: string, message: string) {
    super(message);

    this.name = "RunDossierError";
    this.runId = runId;
  }
}

export async function initializeRunDossier(
  loadedConfig: LoadedHarnessConfig,
  options: InitializeRunDossierOptions = {},
): Promise<RunDossier> {
  const createdAtDate = options.createdAt ?? new Date();
  const runId = options.runId ?? createRunId({ date: createdAtDate });
  const promptVersion = options.promptVersion ?? DEFAULT_PROMPT_VERSION;
  const schemaVersion = options.schemaVersion ?? DEFAULT_SCHEMA_VERSION;
  const createdAt = createdAtDate.toISOString();

  assertValidRunId(runId);

  const paths = buildRunDossierPaths({
    artifactsRootDir: loadedConfig.config.artifacts.rootDir,
    projectRoot: loadedConfig.projectRoot,
    runId,
    runsDir: loadedConfig.config.artifacts.runsDir,
  });

  assertRunDossierPaths(paths);
  await ensureDirectory(
    paths.runId,
    paths.artifactsRootAbsolutePath,
    "artifact root",
  );
  await ensureDirectory(
    paths.runId,
    paths.runsDirAbsolutePath,
    "runs directory",
  );

  try {
    await mkdir(paths.runDirAbsolutePath);
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;

    if (maybeNodeError.code === "EEXIST") {
      throw new RunDossierError(
        runId,
        `Run dossier already exists at ${paths.runDirRelativePath}. Use a new run ID.`,
      );
    }

    throw error;
  }

  for (const key of orderedArtifactKeys()) {
    if (key === "run") {
      continue;
    }

    await writeInitialArtifactFile(paths, key);
  }

  const manifest = createRunManifest({
    createdAt,
    paths,
    promptReferences:
      options.promptReferences ?? getDefaultPromptReferences(promptVersion),
    promptVersion,
    schemaVersion,
    status: "initialized",
  });

  await writeRunManifest(paths, manifest);
  await appendRunEvent(paths, {
    promptVersion,
    prompts: manifest.prompts,
    schemaVersion,
    timestamp: createdAt,
    type: "run-initialized",
  });

  return {
    manifest: await readRunManifest(paths),
    paths,
  };
}

export async function readRunManifest(
  paths: RunDossierPaths,
): Promise<RunManifest> {
  let rawManifest: string;

  try {
    rawManifest = await readFile(paths.files.run.absolutePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new RunDossierError(
      paths.runId,
      `Could not read run manifest at ${paths.files.run.relativePath}: ${message}`,
    );
  }

  let parsedManifest: unknown;

  try {
    parsedManifest = JSON.parse(rawManifest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new RunDossierError(
      paths.runId,
      `Run manifest at ${paths.files.run.relativePath} is not valid JSON: ${message}`,
    );
  }

  if (!isPlainObject(parsedManifest) || parsedManifest.runId !== paths.runId) {
    throw new RunDossierError(
      paths.runId,
      `Run manifest at ${paths.files.run.relativePath} does not describe run ${paths.runId}.`,
    );
  }

  return parsedManifest as unknown as RunManifest;
}

export async function appendRunEvent(
  paths: RunDossierPaths,
  event: Record<string, unknown>,
): Promise<RunManifest> {
  await appendJsonLine(paths.files.events.absolutePath, event);
  return updateRunManifest(paths, {
    updatedAt: getEventTimestamp(event),
  });
}

export async function appendStructuredMessage(
  paths: RunDossierPaths,
  message: StructuredMessageRecord,
): Promise<RunManifest> {
  return appendRunEvent(paths, {
    content: message.content,
    format: message.format ?? "text",
    metadata: message.metadata,
    role: message.role,
    timestamp: message.timestamp,
    type: "message",
  });
}

export async function appendModelEvent(
  paths: RunDossierPaths,
  event: Record<string, unknown>,
): Promise<RunManifest> {
  return appendRunEvent(paths, event);
}

export async function appendCommandLog(
  paths: RunDossierPaths,
  commandLog: CommandLogRecord,
): Promise<RunManifest> {
  await appendJsonLine(paths.files.commandLog.absolutePath, commandLog);
  return updateRunManifest(paths, {
    updatedAt: commandLog.timestamp,
  });
}

export async function writeArchitectPlan(
  paths: RunDossierPaths,
  markdown: string,
  timestamp: string = new Date().toISOString(),
): Promise<RunManifest> {
  await writeTextArtifact(paths, "architectPlan", markdown);
  return updateRunManifest(paths, { updatedAt: timestamp });
}

export async function writeEngineerTask(
  paths: RunDossierPaths,
  markdown: string,
  timestamp: string = new Date().toISOString(),
): Promise<RunManifest> {
  await writeTextArtifact(paths, "engineerTask", markdown);
  return updateRunManifest(paths, { updatedAt: timestamp });
}

export async function writeArchitectReview(
  paths: RunDossierPaths,
  markdown: string,
  timestamp: string = new Date().toISOString(),
): Promise<RunManifest> {
  await writeTextArtifact(paths, "architectReview", markdown);
  return updateRunManifest(paths, { updatedAt: timestamp });
}

export async function writeChecks(
  paths: RunDossierPaths,
  checks: RunChecksSummary,
  timestamp: string = checks.recordedAt ?? new Date().toISOString(),
): Promise<RunManifest> {
  await writeJsonFile(paths.files.checks.absolutePath, checks);
  return updateRunManifest(paths, { updatedAt: timestamp });
}

export async function writeDiff(
  paths: RunDossierPaths,
  diff: string,
  timestamp: string = new Date().toISOString(),
): Promise<RunManifest> {
  await writeTextArtifact(paths, "diff", diff);
  return updateRunManifest(paths, { updatedAt: timestamp });
}

export async function writeFailureNotes(
  paths: RunDossierPaths,
  markdown: string,
  timestamp: string = new Date().toISOString(),
): Promise<RunManifest> {
  await writeTextArtifact(paths, "failureNotes", markdown);
  return updateRunManifest(paths, { updatedAt: timestamp });
}

export async function writeFinalReport(
  paths: RunDossierPaths,
  markdown: string,
  timestamp: string = new Date().toISOString(),
): Promise<RunManifest> {
  await writeTextArtifact(paths, "finalReport", markdown);
  return updateRunManifest(paths, { updatedAt: timestamp });
}

export async function writeRunResult(
  paths: RunDossierPaths,
  result: RunResult,
  timestamp: string = new Date().toISOString(),
): Promise<RunManifest> {
  const validatedResult = await validateRunResult(result);
  await writeJsonFile(paths.files.result.absolutePath, validatedResult);
  return updateRunManifest(paths, {
    status: validatedResult.status,
    updatedAt: timestamp,
  });
}

function createRunManifest(options: {
  createdAt: string;
  paths: RunDossierPaths;
  promptReferences: readonly RunPromptReference[];
  promptVersion: string;
  schemaVersion: string;
  status: RunLifecycleStatus;
}): RunManifest {
  const { createdAt, paths, promptReferences, promptVersion, schemaVersion } =
    options;

  return {
    artifactsRootDir: paths.artifactsRootRelativePath,
    createdAt,
    files: {
      architectPlan: buildManifestFileReference(paths, "architectPlan"),
      architectReview: buildManifestFileReference(paths, "architectReview"),
      checks: buildManifestFileReference(paths, "checks"),
      commandLog: buildManifestFileReference(paths, "commandLog"),
      diff: buildManifestFileReference(paths, "diff"),
      engineerTask: buildManifestFileReference(paths, "engineerTask"),
      events: buildManifestFileReference(paths, "events"),
      failureNotes: buildManifestFileReference(paths, "failureNotes"),
      finalReport: buildManifestFileReference(paths, "finalReport"),
      result: buildManifestFileReference(paths, "result"),
      run: buildManifestFileReference(paths, "run"),
    },
    promptVersion,
    prompts: [...promptReferences],
    runDir: paths.runDirRelativePath,
    runId: paths.runId,
    runsDir: paths.runsDirRelativePath,
    schemaVersion,
    schemas: {
      runResult: {
        id: "run-result",
        sourcePath: `schemas/${schemaVersion}/run-result.schema.json`,
        sourceRoot: "package",
        version: schemaVersion,
      },
    },
    status: options.status,
    updatedAt: createdAt,
  };
}

function buildManifestFileReference(
  paths: RunDossierPaths,
  key: DossierFileKey,
) {
  return {
    fileName: paths.files[key].fileName,
    kind: DOSSIER_FILE_KINDS[key],
    relativePath: paths.files[key].relativePath,
    root: "project" as const,
  };
}

function getDefaultPromptReferences(version: string): RunPromptReference[] {
  return [
    {
      id: "architect-system",
      sourcePath: `prompts/${version}/architect/system.md`,
      sourceRoot: "package",
      version,
    },
    {
      id: "architect-planning",
      sourcePath: `prompts/${version}/architect/planning.md`,
      sourceRoot: "package",
      version,
    },
    {
      id: "architect-review",
      sourcePath: `prompts/${version}/architect/review.md`,
      sourceRoot: "package",
      version,
    },
    {
      id: "engineer-system",
      sourcePath: `prompts/${version}/engineer/system.md`,
      sourceRoot: "package",
      version,
    },
    {
      id: "engineer-execute",
      sourcePath: `prompts/${version}/engineer/execute.md`,
      sourceRoot: "package",
      version,
    },
  ];
}

async function writeInitialArtifactFile(
  paths: RunDossierPaths,
  key: Exclude<DossierFileKey, "run">,
): Promise<void> {
  switch (key) {
    case "checks":
      await writeJsonFile(paths.files.checks.absolutePath, { checks: [] });
      return;
    case "result":
      await writeJsonFile(paths.files.result.absolutePath, {
        status: "stopped",
        summary: "Run initialized. Final result pending.",
      });
      return;
    default:
      await writeFile(paths.files[key].absolutePath, "", "utf8");
  }
}

async function writeTextArtifact(
  paths: RunDossierPaths,
  key:
    | "architectPlan"
    | "architectReview"
    | "diff"
    | "engineerTask"
    | "failureNotes"
    | "finalReport",
  contents: string,
): Promise<void> {
  const normalizedContents =
    contents.length > 0 && !contents.endsWith("\n")
      ? `${contents}\n`
      : contents;

  await writeFile(paths.files[key].absolutePath, normalizedContents, "utf8");
}

async function writeRunManifest(
  paths: RunDossierPaths,
  manifest: RunManifest,
): Promise<void> {
  await writeJsonFile(paths.files.run.absolutePath, manifest);
}

async function updateRunManifest(
  paths: RunDossierPaths,
  updates: {
    status?: RunLifecycleStatus;
    updatedAt: string;
  },
): Promise<RunManifest> {
  const manifest = await readRunManifest(paths);
  const nextManifest: RunManifest = {
    ...manifest,
    status: updates.status ?? manifest.status,
    updatedAt: updates.updatedAt,
  };

  await writeRunManifest(paths, nextManifest);
  return nextManifest;
}

function getEventTimestamp(event: Record<string, unknown>): string {
  const timestamp = event.timestamp;

  return typeof timestamp === "string" ? timestamp : new Date().toISOString();
}

function orderedArtifactKeys(): DossierFileKey[] {
  return [
    "events",
    "architectPlan",
    "engineerTask",
    "architectReview",
    "commandLog",
    "checks",
    "diff",
    "failureNotes",
    "result",
    "finalReport",
    "run",
  ];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRunDossierPaths(paths: RunDossierPaths): void {
  if (!isPathWithin(paths.projectRoot, paths.artifactsRootAbsolutePath)) {
    throw new RunDossierError(
      paths.runId,
      `Artifact root ${paths.artifactsRootAbsolutePath} must stay within the project root ${paths.projectRoot}.`,
    );
  }

  if (
    !isPathWithin(paths.artifactsRootAbsolutePath, paths.runsDirAbsolutePath)
  ) {
    throw new RunDossierError(
      paths.runId,
      `Runs directory ${paths.runsDirAbsolutePath} must stay within artifact root ${paths.artifactsRootAbsolutePath}.`,
    );
  }

  if (!isPathWithin(paths.runsDirAbsolutePath, paths.runDirAbsolutePath)) {
    throw new RunDossierError(
      paths.runId,
      `Run directory ${paths.runDirAbsolutePath} must stay within runs directory ${paths.runsDirAbsolutePath}.`,
    );
  }
}

async function ensureDirectory(
  runId: string,
  directoryPath: string,
  label: string,
): Promise<void> {
  try {
    await mkdir(directoryPath, { recursive: true });
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;

    if (maybeNodeError.code === "EEXIST" || maybeNodeError.code === "ENOTDIR") {
      throw new RunDossierError(
        runId,
        `Cannot create ${label} at ${directoryPath} because a non-directory path is in the way.`,
      );
    }

    const message = error instanceof Error ? error.message : String(error);

    throw new RunDossierError(
      runId,
      `Could not create ${label} at ${directoryPath}: ${message}`,
    );
  }
}

function isPathWithin(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);

  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}
