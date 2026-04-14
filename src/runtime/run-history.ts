import { readdir, readFile, stat } from "node:fs/promises";

import {
  buildRunDossierPaths,
  type DossierFileKey,
  type RunDossierPaths,
} from "../artifacts/paths.js";
import { isValidRunId } from "../artifacts/run-id.js";
import type { LoadedHarnessConfig } from "../types/config.js";
import type {
  CommandLogRecord,
  DossierArtifactKind,
  RunCheckResult,
  RunChecksSummary,
  RunLifecycleStatus,
  RunManifest,
  RunResult,
} from "../types/run.js";

export interface RunArtifactPresence {
  absolutePath: string;
  exists: boolean;
  fileName: string;
  key: DossierFileKey;
  kind: DossierArtifactKind;
  relativePath: string;
  written: boolean;
}

export interface RunInspection {
  activeRole: "architect" | "engineer" | "system";
  artifacts: Record<DossierFileKey, RunArtifactPresence>;
  commandStatus: string;
  createdAt: string;
  currentObjective: string;
  elapsedMs: number;
  latestCheck?: RunCheckResult;
  latestDecision: string;
  manifest: RunManifest;
  phase: string;
  primaryArtifacts: RunArtifactPresence[];
  result?: RunResult;
  runDirAbsolutePath: string;
  runDirRelativePath: string;
  runId: string;
  status: RunLifecycleStatus | RunResult["status"];
  stopReason?: string;
  summary: string;
  task?: string;
  updatedAt: string;
}

interface DerivedRunState {
  activeRole: RunInspection["activeRole"];
  currentObjective: string;
  latestDecision: string;
  pendingTool: PendingTool | undefined;
  phase: string;
  requiredCheckCommand: string | undefined;
  stopReason: string | undefined;
  summary: string | undefined;
  task: string | undefined;
}

interface PendingTool {
  description: string;
  isRequiredCheck: boolean;
  timestamp: string;
}

type JsonRecord = Record<string, unknown>;

export class RunHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunHistoryError";
  }
}

export async function listRecordedRunIds(
  loadedConfig: LoadedHarnessConfig,
): Promise<string[]> {
  const runsDirAbsolutePath = buildRunsDirectoryPath(loadedConfig);

  try {
    const entries = await readdir(runsDirAbsolutePath, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isDirectory() && isValidRunId(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, "en"));
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;

    if (maybeNodeError.code === "ENOENT") {
      return [];
    }

    throw new RunHistoryError(
      `Could not read runs directory ${loadedConfig.config.artifacts.runsDir}: ${describeError(error)}`,
    );
  }
}

export async function resolveRunDossierPaths(
  loadedConfig: LoadedHarnessConfig,
  runId?: string,
): Promise<RunDossierPaths> {
  const resolvedRunId = runId ?? (await resolveLatestRunId(loadedConfig));

  if (!isValidRunId(resolvedRunId)) {
    throw new RunHistoryError(
      `Invalid run ID \`${resolvedRunId}\`. Expected format YYYYMMDDTHHMMSS.mmmZ-abcdef.`,
    );
  }

  return buildRunDossierPaths({
    artifactsRootDir: loadedConfig.config.artifacts.rootDir,
    projectRoot: loadedConfig.projectRoot,
    runId: resolvedRunId,
    runsDir: loadedConfig.config.artifacts.runsDir,
  });
}

export async function readRunInspection(
  paths: RunDossierPaths,
  options: { now?: Date } = {},
): Promise<RunInspection> {
  const manifest = await readRequiredJsonFile<RunManifest>(
    paths.files.run.absolutePath,
    `run manifest at ${paths.files.run.relativePath}`,
  );
  const result = await readOptionalJsonFile<RunResult>(
    paths.files.result.absolutePath,
  );
  const checks = await readOptionalJsonFile<RunChecksSummary>(
    paths.files.checks.absolutePath,
  );
  const events = await readJsonLines(paths.files.events.absolutePath);
  const commands = await readJsonLines(paths.files.commandLog.absolutePath);
  const artifacts = await readArtifactPresence(paths);
  const latestCheck = getLatestCheck(checks);
  const derivedState = deriveRunState(events, manifest.status);
  const updatedAt = manifest.updatedAt;
  const currentTimestamp =
    manifest.status === "running"
      ? (options.now ?? new Date()).toISOString()
      : updatedAt;
  const elapsedMs = Math.max(
    0,
    Date.parse(currentTimestamp) - Date.parse(manifest.createdAt),
  );

  return {
    activeRole: derivedState.activeRole,
    artifacts,
    commandStatus: deriveCommandStatus(
      commands,
      latestCheck,
      derivedState.pendingTool,
      derivedState.requiredCheckCommand,
    ),
    createdAt: manifest.createdAt,
    currentObjective:
      derivedState.currentObjective.length > 0
        ? derivedState.currentObjective
        : "Waiting for run activity.",
    elapsedMs,
    ...(latestCheck === undefined ? {} : { latestCheck }),
    latestDecision:
      derivedState.latestDecision.length > 0
        ? derivedState.latestDecision
        : "No high-level decision recorded yet.",
    manifest,
    phase: deriveDisplayedPhase(manifest.status, result?.status, derivedState),
    primaryArtifacts: selectPrimaryArtifacts(artifacts, manifest.status),
    ...(result === undefined ? {} : { result }),
    runDirAbsolutePath: paths.runDirAbsolutePath,
    runDirRelativePath: paths.runDirRelativePath,
    runId: paths.runId,
    status: result?.status ?? manifest.status,
    ...(derivedState.stopReason === undefined
      ? {}
      : { stopReason: derivedState.stopReason }),
    summary:
      result?.summary ??
      derivedState.summary ??
      summarizeLifecycleStatus(manifest.status),
    ...(derivedState.task === undefined ? {} : { task: derivedState.task }),
    updatedAt,
  };
}

async function resolveLatestRunId(
  loadedConfig: LoadedHarnessConfig,
): Promise<string> {
  const runIds = await listRecordedRunIds(loadedConfig);

  if (runIds.length === 0) {
    throw new RunHistoryError(
      `No runs found in ${loadedConfig.config.artifacts.runsDir}.`,
    );
  }

  return runIds[0]!;
}

function buildRunsDirectoryPath(loadedConfig: LoadedHarnessConfig): string {
  return buildRunDossierPaths({
    artifactsRootDir: loadedConfig.config.artifacts.rootDir,
    projectRoot: loadedConfig.projectRoot,
    runId: "20000101T000000.000Z-000000",
    runsDir: loadedConfig.config.artifacts.runsDir,
  }).runsDirAbsolutePath;
}

async function readArtifactPresence(
  paths: RunDossierPaths,
): Promise<Record<DossierFileKey, RunArtifactPresence>> {
  const artifactEntries = await Promise.all(
    (Object.keys(paths.files) as DossierFileKey[]).map(async (key) => {
      const file = paths.files[key];
      const presence = await getArtifactPresence(file.absolutePath);

      return [
        key,
        {
          absolutePath: file.absolutePath,
          exists: presence.exists,
          fileName: file.fileName,
          key,
          kind: file.kind,
          relativePath: file.relativePath,
          written: presence.written,
        },
      ] as const;
    }),
  );

  return Object.fromEntries(artifactEntries) as Record<
    DossierFileKey,
    RunArtifactPresence
  >;
}

async function getArtifactPresence(filePath: string): Promise<{
  exists: boolean;
  written: boolean;
}> {
  try {
    const stats = await stat(filePath);
    return {
      exists: true,
      written: stats.size > 0,
    };
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;

    if (maybeNodeError.code === "ENOENT") {
      return {
        exists: false,
        written: false,
      };
    }

    throw new RunHistoryError(
      `Could not read artifact metadata for ${filePath}: ${describeError(error)}`,
    );
  }
}

async function readRequiredJsonFile<T>(
  filePath: string,
  description: string,
): Promise<T> {
  const rawContents = await readTextFile(filePath, description);

  try {
    return JSON.parse(rawContents) as T;
  } catch (error) {
    throw new RunHistoryError(
      `Could not parse ${description} as JSON: ${describeError(error)}`,
    );
  }
}

async function readOptionalJsonFile<T>(
  filePath: string,
): Promise<T | undefined> {
  let rawContents: string;

  try {
    rawContents = await readFile(filePath, "utf8");
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;

    if (maybeNodeError.code === "ENOENT") {
      return undefined;
    }

    throw new RunHistoryError(
      `Could not read ${filePath}: ${describeError(error)}`,
    );
  }

  if (rawContents.trim().length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(rawContents) as T;
  } catch (error) {
    throw new RunHistoryError(
      `Could not parse ${filePath} as JSON: ${describeError(error)}`,
    );
  }
}

async function readJsonLines(filePath: string): Promise<JsonRecord[]> {
  let rawContents: string;

  try {
    rawContents = await readFile(filePath, "utf8");
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;

    if (maybeNodeError.code === "ENOENT") {
      return [];
    }

    throw new RunHistoryError(
      `Could not read ${filePath}: ${describeError(error)}`,
    );
  }

  const lines = rawContents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  try {
    return lines.map((line) => JSON.parse(line) as JsonRecord);
  } catch (error) {
    throw new RunHistoryError(
      `Could not parse JSONL file ${filePath}: ${describeError(error)}`,
    );
  }
}

async function readTextFile(
  filePath: string,
  description: string,
): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    throw new RunHistoryError(
      `Could not read ${description}: ${describeError(error)}`,
    );
  }
}

function getLatestCheck(
  checks: RunChecksSummary | undefined,
): RunCheckResult | undefined {
  return checks?.checks.at(-1);
}

function deriveRunState(
  events: readonly JsonRecord[],
  manifestStatus: RunLifecycleStatus,
): DerivedRunState {
  const state: DerivedRunState = {
    activeRole: manifestStatus === "running" ? "system" : "system",
    currentObjective: "",
    latestDecision: "",
    pendingTool: undefined,
    phase:
      manifestStatus === "running"
        ? "Preparing"
        : summarizeLifecycleStatus(manifestStatus),
    requiredCheckCommand: undefined,
    stopReason: undefined,
    summary: undefined,
    task: undefined,
  };

  for (const event of events) {
    const eventType = getOptionalString(event, "type");

    switch (eventType) {
      case "architect-engineer-run-started":
      case "engineer-run-started":
        state.task = getOptionalString(event, "task") ?? state.task;
        state.requiredCheckCommand =
          getOptionalString(event, "requiredCheckCommand") ??
          state.requiredCheckCommand;
        if (state.currentObjective.length === 0 && state.task !== undefined) {
          state.currentObjective = state.task;
        }
        state.phase =
          eventType === "architect-engineer-run-started"
            ? "Preparing"
            : "Execution";
        state.activeRole = "system";
        break;
      case "architect-action-selected":
        state.phase =
          getOptionalString(event, "phase") === "architect-review"
            ? "Review"
            : "Planning";
        state.activeRole = "architect";
        state.currentObjective =
          getOptionalString(event, "summary") ?? state.currentObjective;
        state.pendingTool = readPendingTool(event, state.requiredCheckCommand);
        break;
      case "architect-plan-created": {
        const planSummary = getOptionalString(event, "summary");
        const firstStep = getStringArray(event, "steps")[0];

        state.phase = "Execution";
        state.activeRole = "engineer";
        state.pendingTool = undefined;
        if (planSummary !== undefined) {
          state.latestDecision = planSummary;
          state.currentObjective = firstStep ?? planSummary;
        }
        break;
      }
      case "engineer-iteration-started":
        state.phase = "Execution";
        state.activeRole = "engineer";
        break;
      case "engineer-action-selected":
        state.phase = "Execution";
        state.activeRole = "engineer";
        state.currentObjective =
          getOptionalString(event, "summary") ?? state.currentObjective;
        state.pendingTool = readPendingTool(event, state.requiredCheckCommand);
        break;
      case "architect-review-created": {
        const reviewSummary = getOptionalString(event, "summary");
        const decision = getOptionalString(event, "decision");
        const nextAction = getStringArray(event, "nextActions")[0];

        state.phase = decision === "approve" ? "Finalizing" : "Execution";
        state.activeRole = decision === "approve" ? "system" : "engineer";
        state.pendingTool = undefined;
        if (reviewSummary !== undefined) {
          state.latestDecision = reviewSummary;
          state.currentObjective = nextAction ?? reviewSummary;
        }
        break;
      }
      case "engineer-run-finished":
      case "architect-engineer-run-finished":
        state.pendingTool = undefined;
        state.activeRole = "system";
        state.phase = summarizeFinalPhase(getOptionalString(event, "status"));
        state.stopReason =
          getOptionalString(event, "stopReason") ?? state.stopReason;
        state.summary = getOptionalString(event, "summary") ?? state.summary;
        if (state.summary !== undefined) {
          state.latestDecision = state.summary;
          state.currentObjective = state.summary;
        }
        break;
      case "tool-call":
        state.pendingTool = undefined;
        break;
    }
  }

  if (state.currentObjective.length === 0 && state.task !== undefined) {
    state.currentObjective = state.task;
  }

  return state;
}

function readPendingTool(
  event: JsonRecord,
  requiredCheckCommand?: string,
): PendingTool | undefined {
  const toolRequest = getOptionalRecord(event, "toolRequest");

  if (toolRequest === undefined) {
    return undefined;
  }

  const toolName = getOptionalString(toolRequest, "toolName");
  const timestamp = getOptionalString(event, "timestamp");

  if (toolName === undefined || timestamp === undefined) {
    return undefined;
  }

  if (toolName === "command.execute") {
    const command = getOptionalString(toolRequest, "command");

    if (command === undefined) {
      return undefined;
    }

    return {
      description: command,
      isRequiredCheck:
        requiredCheckCommand !== undefined &&
        normalizeCommand(command) === normalizeCommand(requiredCheckCommand),
      timestamp,
    };
  }

  if (toolName === "mcp.call") {
    const server = getOptionalString(toolRequest, "server");
    const name = getOptionalString(toolRequest, "name");

    if (server === undefined || name === undefined) {
      return undefined;
    }

    return {
      description: `${server}.${name}`,
      isRequiredCheck: false,
      timestamp,
    };
  }

  const path = getOptionalString(toolRequest, "path");

  return {
    description: path === undefined ? toolName : `${toolName} ${path}`,
    isRequiredCheck: false,
    timestamp,
  };
}

function deriveCommandStatus(
  commands: readonly JsonRecord[],
  latestCheck: RunCheckResult | undefined,
  pendingTool: PendingTool | undefined,
  requiredCheckCommand: string | undefined,
): string {
  const lastCommandRecord = toLatestCommandLog(commands);
  const lastCommandTimestamp =
    lastCommandRecord === undefined
      ? undefined
      : Date.parse(lastCommandRecord.timestamp);
  const pendingTimestamp =
    pendingTool === undefined ? undefined : Date.parse(pendingTool.timestamp);

  if (
    pendingTool !== undefined &&
    pendingTimestamp !== undefined &&
    (lastCommandTimestamp === undefined ||
      pendingTimestamp >= lastCommandTimestamp)
  ) {
    return pendingTool.isRequiredCheck
      ? `Running required check: ${pendingTool.description}`
      : `Running tool: ${pendingTool.description}`;
  }

  if (lastCommandRecord !== undefined) {
    const isRequiredCheck =
      requiredCheckCommand !== undefined &&
      normalizeCommand(lastCommandRecord.command) ===
        normalizeCommand(requiredCheckCommand);

    if (isRequiredCheck) {
      return formatCheckStatus(
        latestCheck,
        lastCommandRecord.command,
        lastCommandRecord.status,
        lastCommandRecord.exitCode,
      );
    }

    return formatCommandStatus(lastCommandRecord);
  }

  if (latestCheck !== undefined) {
    return formatCheckStatus(
      latestCheck,
      latestCheck.command,
      undefined,
      latestCheck.exitCode,
    );
  }

  return "No commands or checks recorded yet.";
}

function toLatestCommandLog(
  commands: readonly JsonRecord[],
): CommandLogRecord | undefined {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const commandRecord = commands[index];

    if (commandRecord === undefined) {
      continue;
    }

    const command = getOptionalString(commandRecord, "command");
    const timestamp = getOptionalString(commandRecord, "timestamp");

    if (command === undefined || timestamp === undefined) {
      continue;
    }

    const nextRecord: CommandLogRecord = {
      command,
      durationMs: getOptionalNumber(commandRecord, "durationMs") ?? 0,
      exitCode: getOptionalIntegerOrNull(commandRecord, "exitCode") ?? null,
      timestamp,
    };

    const accessMode = getOptionalCommandAccessMode(
      commandRecord,
      "accessMode",
    );

    if (accessMode !== undefined) {
      nextRecord.accessMode = accessMode;
    }

    const containerName = getOptionalString(commandRecord, "containerName");

    if (containerName !== undefined) {
      nextRecord.containerName = containerName;
    }

    const executionTarget = getOptionalExecutionTarget(
      commandRecord,
      "executionTarget",
    );

    if (executionTarget !== undefined) {
      nextRecord.executionTarget = executionTarget;
    }

    const role = getOptionalRole(commandRecord, "role");

    if (role !== undefined) {
      nextRecord.role = role;
    }

    const stderr = getOptionalString(commandRecord, "stderr");

    if (stderr !== undefined) {
      nextRecord.stderr = stderr;
    }

    const status = getOptionalCommandStatus(commandRecord, "status");

    if (status !== undefined) {
      nextRecord.status = status;
    }

    const stdout = getOptionalString(commandRecord, "stdout");

    if (stdout !== undefined) {
      nextRecord.stdout = stdout;
    }

    const workingDirectory = getOptionalString(
      commandRecord,
      "workingDirectory",
    );

    if (workingDirectory !== undefined) {
      nextRecord.workingDirectory = workingDirectory;
    }

    return nextRecord;
  }

  return undefined;
}

function formatCheckStatus(
  latestCheck: RunCheckResult | undefined,
  command: string | undefined,
  commandStatus: CommandLogRecord["status"],
  exitCode: number | undefined | null,
): string {
  if (latestCheck === undefined) {
    return [
      "Required check recorded:",
      command ?? "unknown command",
      summarizeCommandOutcome(commandStatus, exitCode),
    ]
      .filter((part) => part !== undefined)
      .join(" ");
  }

  const outcome =
    latestCheck.status === "passed"
      ? "passed"
      : latestCheck.status === "failed"
        ? "failed"
        : "was skipped";
  const exitDetail =
    latestCheck.exitCode === undefined ? "" : ` (exit ${latestCheck.exitCode})`;

  return `Required check ${outcome}${exitDetail}: ${latestCheck.command ?? command ?? "unknown command"}`;
}

function formatCommandStatus(command: CommandLogRecord): string {
  return `Last command ${summarizeCommandOutcome(command.status, command.exitCode)}: ${command.command}`;
}

function summarizeCommandOutcome(
  status: CommandLogRecord["status"],
  exitCode: number | null | undefined,
): string {
  switch (status) {
    case "timed-out":
      return "timed out";
    case "cancelled":
      return "was cancelled";
    case "failed-to-start":
      return "failed to start";
    case "completed":
      return exitCode === 0
        ? "passed"
        : `failed${exitCode === null || exitCode === undefined ? "" : ` (exit ${exitCode})`}`;
    default:
      return exitCode === 0
        ? "passed"
        : exitCode === undefined || exitCode === null
          ? "completed"
          : `failed (exit ${exitCode})`;
  }
}

function deriveDisplayedPhase(
  manifestStatus: RunLifecycleStatus,
  resultStatus: RunResult["status"] | undefined,
  derivedState: DerivedRunState,
): string {
  if (resultStatus !== undefined) {
    return summarizeFinalPhase(resultStatus);
  }

  if (manifestStatus !== "running") {
    return summarizeLifecycleStatus(manifestStatus);
  }

  return derivedState.phase;
}

function summarizeLifecycleStatus(status: RunLifecycleStatus): string {
  switch (status) {
    case "initialized":
      return "Initialized";
    case "running":
      return "Running";
    case "success":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
  }
}

function summarizeFinalPhase(status: string | undefined): string {
  switch (status) {
    case "success":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    default:
      return "Finalizing";
  }
}

function selectPrimaryArtifacts(
  artifacts: Record<DossierFileKey, RunArtifactPresence>,
  status: RunLifecycleStatus,
): RunArtifactPresence[] {
  const orderedKeys: DossierFileKey[] =
    status === "success"
      ? ["finalReport", "result", "checks", "events", "commandLog"]
      : status === "failed" || status === "stopped"
        ? ["failureNotes", "finalReport", "checks", "commandLog", "events"]
        : ["run", "checks", "commandLog", "events", "engineerTask"];

  const selectedArtifacts = orderedKeys
    .map((key) => artifacts[key])
    .filter((artifact) => artifact !== undefined && artifact.written);

  return selectedArtifacts.length > 0
    ? selectedArtifacts
    : [artifacts.run].filter((artifact) => artifact.written);
}

function getOptionalString(value: JsonRecord, key: string): string | undefined {
  const entry = value[key];
  return typeof entry === "string" ? entry : undefined;
}

function getOptionalNumber(value: JsonRecord, key: string): number | undefined {
  const entry = value[key];
  return typeof entry === "number" ? entry : undefined;
}

function getOptionalIntegerOrNull(
  value: JsonRecord,
  key: string,
): number | null | undefined {
  const entry = value[key];

  if (entry === null) {
    return null;
  }

  return Number.isInteger(entry) ? (entry as number) : undefined;
}

function getOptionalRecord(
  value: JsonRecord,
  key: string,
): JsonRecord | undefined {
  const entry = value[key];
  return isPlainObject(entry) ? entry : undefined;
}

function getStringArray(value: JsonRecord, key: string): string[] {
  const entry = value[key];

  if (!Array.isArray(entry)) {
    return [];
  }

  return entry.filter((item): item is string => typeof item === "string");
}

function getOptionalRole(
  value: JsonRecord,
  key: string,
): CommandLogRecord["role"] | undefined {
  const entry = value[key];
  return entry === "architect" || entry === "engineer" || entry === "system"
    ? entry
    : undefined;
}

function getOptionalCommandAccessMode(
  value: JsonRecord,
  key: string,
): CommandLogRecord["accessMode"] | undefined {
  const entry = value[key];
  return entry === "inspect" || entry === "mutate" ? entry : undefined;
}

function getOptionalCommandStatus(
  value: JsonRecord,
  key: string,
): CommandLogRecord["status"] | undefined {
  const entry = value[key];
  return entry === "cancelled" ||
    entry === "completed" ||
    entry === "failed-to-start" ||
    entry === "timed-out"
    ? entry
    : undefined;
}

function getOptionalExecutionTarget(
  value: JsonRecord,
  key: string,
): CommandLogRecord["executionTarget"] | undefined {
  const entry = value[key];
  return entry === "docker" || entry === "host" ? entry : undefined;
}

function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCommand(command: string): string {
  return command.trim().replaceAll(/\s+/gu, " ");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
