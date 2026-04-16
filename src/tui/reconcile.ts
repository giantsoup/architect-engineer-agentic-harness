import type { HarnessEvent } from "../runtime/harness-events.js";
import type { RunInspection } from "../runtime/run-history.js";
import type { CommandLogRecord, RunCheckResult } from "../types/run.js";
import type { TuiLogEntry, TuiQueueItem } from "./state.js";
import type { TuiArtifactSnapshot } from "./artifact-reader.js";

type JsonRecord = Record<string, unknown>;
type HarnessRole = "architect" | "engineer";

export interface TuiRunningCommandOutputLine {
  stream: "stderr" | "stdout";
  text: string;
  timestamp: string;
}

export interface TuiRunningCommandState {
  accessMode: "inspect" | "mutate";
  command: string;
  droppedOutputLineCount: number;
  role: HarnessRole;
  startedAt: string;
  output: readonly TuiRunningCommandOutputLine[];
  workingDirectory?: string | undefined;
}

export interface TuiCompletedCommandState {
  accessMode: "inspect" | "mutate";
  command: string;
  durationMs: number;
  exitCode: number | null;
  role: HarnessRole;
  status: "cancelled" | "completed" | "failed-to-start" | "timed-out";
  stderr?: string | undefined;
  stdout?: string | undefined;
  timestamp: string;
  workingDirectory?: string | undefined;
}

export interface TuiLiveOverlay {
  agentStatus: Partial<Record<HarnessRole, HarnessEvent<"agent:update">>>;
  currentCommands: Partial<Record<HarnessRole, TuiRunningCommandState>>;
  lastCommands: Partial<Record<HarnessRole, TuiCompletedCommandState>>;
  lastToolByRole: Partial<Record<HarnessRole, string>>;
  latestCheck?: HarnessEvent<"check:update"> | undefined;
  latestRetryByRole: Partial<Record<HarnessRole, HarnessEvent<"model:retry">>>;
  modelRequests: Partial<Record<HarnessRole, HarnessEvent<"model:request">>>;
  requiredCheckCommand?: string | undefined;
  runStatus?: HarnessEvent<"run:status"> | undefined;
}

export interface TuiProjection {
  architectLines: readonly string[];
  diffLines: readonly string[];
  engineerLines: readonly string[];
  queueItems: readonly TuiQueueItem[];
  statusText: string;
  testsLines: readonly string[];
}

export interface TuiReconcileContext {
  artifacts: TuiArtifactSnapshot;
  inspection: RunInspection | undefined;
  overlay: TuiLiveOverlay;
  task?: string | undefined;
}

const DIFF_PANE_LINE_LIMIT = 160;
const HYDRATED_LOG_ENTRY_LIMIT = 600;
const LIVE_COMMAND_CHUNK_LINE_LIMIT = 12;
const LIVE_COMMAND_OUTPUT_LINE_LIMIT = 120;
const PANE_EXCERPT_LINE_LIMIT = 6;
const TEST_OUTPUT_LINE_LIMIT = 18;

export function createEmptyTuiLiveOverlay(): TuiLiveOverlay {
  return {
    agentStatus: {},
    currentCommands: {},
    lastCommands: {},
    lastToolByRole: {},
    latestRetryByRole: {},
    modelRequests: {},
  };
}

export function applyHarnessEventToOverlay(
  overlay: TuiLiveOverlay,
  event: HarnessEvent,
): {
  appendLogEntries: readonly Omit<TuiLogEntry, "id">[];
  requestReconcile: boolean;
} {
  switch (event.type) {
    case "run:status":
      overlay.runStatus = event;
      return {
        appendLogEntries: [
          toLogEntry(
            event.timestamp,
            "runtime",
            "info",
            event.summary ?? event.status,
          ),
        ],
        requestReconcile: false,
      };
    case "agent:update":
      overlay.agentStatus[event.agent] = event;
      return {
        appendLogEntries: [
          toLogEntry(
            event.timestamp,
            event.agent,
            event.status === "completed" ? "info" : "info",
            `${capitalize(event.agent)} ${event.phase} ${event.status}: ${event.summary}`,
          ),
        ],
        requestReconcile: false,
      };
    case "model:request":
      overlay.modelRequests[event.role] = event;
      return {
        appendLogEntries: [
          toLogEntry(
            event.timestamp,
            event.role,
            "info",
            `Model request ${event.attempt} to ${event.provider}/${event.model}`,
          ),
        ],
        requestReconcile: false,
      };
    case "model:retry":
      overlay.latestRetryByRole[event.role] = event;
      return {
        appendLogEntries: [
          toLogEntry(
            event.timestamp,
            event.role,
            event.retryable ? "warn" : "error",
            `Model retry ${event.attempt} -> ${event.nextAttempt}: ${event.message}`,
          ),
        ],
        requestReconcile: false,
      };
    case "command:start": {
      const nextCommand: TuiRunningCommandState = {
        accessMode: event.accessMode,
        command: event.command,
        droppedOutputLineCount: 0,
        output: [],
        role: event.role,
        startedAt: event.timestamp,
        ...(event.workingDirectory === undefined
          ? {}
          : { workingDirectory: event.workingDirectory }),
      };

      overlay.currentCommands[event.role] = nextCommand;
      overlay.lastToolByRole[event.role] = "command.execute";

      return {
        appendLogEntries: [
          toLogEntry(
            event.timestamp,
            event.role,
            "info",
            `Command started (${event.accessMode}): ${event.command}`,
          ),
        ],
        requestReconcile: false,
      };
    }
    case "command:stdout":
    case "command:stderr": {
      const runningCommand = overlay.currentCommands[event.role];
      const chunkLines = toChunkLines(
        event.chunk,
        event.timestamp,
        event.type,
        LIVE_COMMAND_CHUNK_LINE_LIMIT,
      );

      if (
        runningCommand !== undefined &&
        runningCommand.command === event.command
      ) {
        const boundedOutput = boundLines(
          [...runningCommand.output, ...chunkLines.lines],
          LIVE_COMMAND_OUTPUT_LINE_LIMIT,
        );

        runningCommand.output = boundedOutput.lines;
        runningCommand.droppedOutputLineCount +=
          chunkLines.dropped + boundedOutput.dropped;
      }

      return {
        appendLogEntries: [
          ...(chunkLines.dropped > 0
            ? [
                toLogEntry(
                  event.timestamp,
                  event.role,
                  "warn",
                  `${event.type === "command:stderr" ? "stderr" : "stdout"}: ${chunkLines.dropped} earlier lines hidden in a burst`,
                ),
              ]
            : []),
          ...chunkLines.lines.map((line) =>
            toLogEntry(
              line.timestamp,
              event.role,
              event.type === "command:stderr" ? "warn" : "info",
              `${line.stream}: ${line.text}`,
            ),
          ),
        ],
        requestReconcile: false,
      };
    }
    case "command:end": {
      const completedCommand: TuiCompletedCommandState = {
        accessMode: event.accessMode,
        command: event.command,
        durationMs: event.durationMs,
        exitCode: event.exitCode,
        role: event.role,
        status: event.status,
        timestamp: event.timestamp,
        workingDirectory: event.workingDirectory,
      };

      overlay.lastCommands[event.role] = completedCommand;
      delete overlay.currentCommands[event.role];

      return {
        appendLogEntries: [
          toLogEntry(
            event.timestamp,
            event.role,
            event.exitCode === 0 ? "info" : "warn",
            `Command ${event.exitCode === 0 ? "passed" : `failed (exit ${event.exitCode})`}: ${event.command}`,
          ),
        ],
        requestReconcile: true,
      };
    }
    case "command:error": {
      const completedCommand: TuiCompletedCommandState = {
        accessMode: event.accessMode,
        command: event.command,
        durationMs: event.durationMs,
        exitCode: event.exitCode,
        role: event.role,
        status: event.status,
        timestamp: event.timestamp,
        ...(event.workingDirectory === undefined
          ? {}
          : { workingDirectory: event.workingDirectory }),
      };

      overlay.lastCommands[event.role] = completedCommand;
      delete overlay.currentCommands[event.role];

      return {
        appendLogEntries: [
          toLogEntry(
            event.timestamp,
            event.role,
            "error",
            `Command ${event.status}: ${event.command} (${event.message})`,
          ),
        ],
        requestReconcile: true,
      };
    }
    case "check:update":
      overlay.latestCheck = event;
      overlay.requiredCheckCommand = event.requiredCheckCommand;
      return {
        appendLogEntries: [
          toLogEntry(
            event.timestamp,
            "engineer",
            event.check.status === "passed" ? "info" : "warn",
            `Check ${event.check.status}${event.check.exitCode === undefined ? "" : ` (exit ${event.check.exitCode})`}: ${event.check.command ?? event.requiredCheckCommand}`,
          ),
        ],
        requestReconcile: true,
      };
    case "artifact:update":
      return {
        appendLogEntries: [
          toLogEntry(
            event.timestamp,
            "runtime",
            "info",
            `Artifact ${event.operation}: ${event.artifact}`,
          ),
        ],
        requestReconcile:
          event.artifact === "architectPlan" ||
          event.artifact === "architectReview" ||
          event.artifact === "checks" ||
          event.artifact === "diff" ||
          event.artifact === "engineerTask" ||
          event.artifact === "finalReport" ||
          event.artifact === "result",
      };
  }
}

export function buildTuiProjection(
  context: TuiReconcileContext,
): TuiProjection {
  const requiredCheckCommand = resolveRequiredCheckCommand(
    context.overlay,
    context.artifacts.events,
  );

  if (requiredCheckCommand !== undefined) {
    context.overlay.requiredCheckCommand = requiredCheckCommand;
  }

  return {
    architectLines: buildArchitectPane(context),
    diffLines: buildDiffPane(context.artifacts.diff),
    engineerLines: buildEngineerPane(context, requiredCheckCommand),
    queueItems: synthesizeQueueItems(context, requiredCheckCommand),
    statusText: buildStatusText(context),
    testsLines: buildTestsPane(context, requiredCheckCommand),
  };
}

export function buildHydratedLogEntries(context: TuiReconcileContext): {
  dropped: number;
  entries: readonly Omit<TuiLogEntry, "id">[];
} {
  const entries: Omit<TuiLogEntry, "id">[] = [];

  for (const event of context.artifacts.events) {
    const entry = toHistoricalEventLogEntry(event);

    if (entry !== undefined) {
      entries.push(entry);
    }
  }

  for (const command of context.artifacts.commandLog) {
    entries.push(
      toLogEntry(
        command.timestamp,
        command.role ?? "system",
        command.exitCode === 0 ? "info" : "warn",
        `Command ${command.exitCode === 0 ? "passed" : summarizeCommandExit(command.exitCode, command.status)}: ${command.command}`,
      ),
    );
  }

  const latestCheck = context.artifacts.checks?.checks.at(-1);

  if (latestCheck !== undefined) {
    entries.push(
      toLogEntry(
        context.inspection?.updatedAt ?? new Date().toISOString(),
        "engineer",
        latestCheck.status === "passed" ? "info" : "warn",
        `Latest check ${latestCheck.status}${latestCheck.exitCode === undefined ? "" : ` (exit ${latestCheck.exitCode})`}: ${latestCheck.command ?? latestCheck.name}`,
      ),
    );
  }

  for (const role of ["architect", "engineer"] as const) {
    const runningCommand = context.overlay.currentCommands[role];

    if (runningCommand === undefined) {
      continue;
    }

    entries.push(
      toLogEntry(
        runningCommand.startedAt,
        role,
        "info",
        `Running command (${runningCommand.accessMode}): ${runningCommand.command}`,
      ),
    );

    for (const line of runningCommand.output) {
      entries.push(
        toLogEntry(
          line.timestamp,
          role,
          line.stream === "stderr" ? "warn" : "info",
          `${line.stream}: ${line.text}`,
        ),
      );
    }
  }

  const sortedEntries = entries.sort(
    (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );
  const boundedEntries = boundLines(sortedEntries, HYDRATED_LOG_ENTRY_LIMIT);

  return {
    dropped: boundedEntries.dropped,
    entries: boundedEntries.lines,
  };
}

function buildArchitectPane(context: TuiReconcileContext): readonly string[] {
  const inspection = context.inspection;
  const latestArchitectActivity = findLatestRoleSummary(
    context.artifacts.events,
    "architect",
  );
  const currentArchitectModel = context.overlay.modelRequests.architect;
  const latestRetry = context.overlay.latestRetryByRole.architect;

  return [
    "Architect Summary",
    "",
    `Status: ${inspection?.status ?? "starting"}`,
    `Phase: ${inspection?.phase ?? "Preparing"}`,
    `Objective: ${inspection?.currentObjective ?? context.task ?? "Waiting for run activity."}`,
    `Latest decision: ${inspection?.latestDecision ?? "No architect decision recorded yet."}`,
    `Agent: ${formatAgentStatus(context.overlay.agentStatus.architect, latestArchitectActivity)}`,
    `Model: ${formatModelStatus(currentArchitectModel, latestRetry)}`,
    "",
    "Architect plan:",
    ...indentExcerpt(
      context.artifacts.architectPlan,
      "No architect plan recorded yet.",
    ),
    "",
    "Architect review:",
    ...indentExcerpt(
      context.artifacts.architectReview,
      "No architect review recorded yet.",
    ),
  ];
}

function buildEngineerPane(
  context: TuiReconcileContext,
  requiredCheckCommand: string | undefined,
): readonly string[] {
  const inspection = context.inspection;
  const runningCommand = context.overlay.currentCommands.engineer;
  const lastCommand =
    context.overlay.lastCommands.engineer ??
    getLatestCommandForRole(context.artifacts.commandLog, "engineer");
  const lastTool =
    context.overlay.lastToolByRole.engineer ??
    findLatestToolName(context.artifacts.events, "engineer");
  const latestCheck =
    context.overlay.latestCheck?.check ??
    context.artifacts.checks?.checks.at(-1);

  return [
    "Engineer Summary",
    "",
    `Task: ${inspection?.task ?? resolveTaskSummary(context)}`,
    `Status: ${inspection?.status ?? "starting"}`,
    `Current command: ${runningCommand?.command ?? "idle"}`,
    `Access mode: ${runningCommand?.accessMode ?? lastCommand?.accessMode ?? "n/a"}`,
    `Working dir: ${runningCommand?.workingDirectory ?? lastCommand?.workingDirectory ?? "."}`,
    `Last tool: ${lastTool ?? "No tool recorded yet."}`,
    `Last exit code: ${lastCommand?.exitCode ?? "n/a"}`,
    `Check status: ${formatCheckLine(latestCheck, requiredCheckCommand)}`,
  ];
}

function buildDiffPane(diff: string): readonly string[] {
  const normalized = splitLines(diff);
  const boundedDiff = boundLines(normalized, DIFF_PANE_LINE_LIMIT, "head");

  return boundedDiff.lines.length > 0
    ? boundedDiff.dropped > 0
      ? [
          `(${boundedDiff.dropped} additional diff lines hidden to keep the pane responsive)`,
          ...boundedDiff.lines,
        ]
      : boundedDiff.lines
    : ["No diff artifact recorded yet."];
}

function buildTestsPane(
  context: TuiReconcileContext,
  requiredCheckCommand: string | undefined,
): readonly string[] {
  const runningCheck = getRunningCheckCommand(
    context.overlay,
    requiredCheckCommand,
  );
  const latestCheck =
    context.overlay.latestCheck?.check ??
    context.artifacts.checks?.checks.at(-1);
  const latestCommand = getLatestCheckCommand(
    context,
    requiredCheckCommand,
    latestCheck,
  );
  const outputLines =
    runningCheck !== undefined
      ? formatRunningCommandOutput(
          runningCheck.output,
          runningCheck.droppedOutputLineCount,
        )
      : formatCommandOutput(latestCommand?.stdout, latestCommand?.stderr);

  return [
    "Check Status",
    "",
    `Required command: ${requiredCheckCommand ?? "not recorded yet"}`,
    `Current command: ${runningCheck?.command ?? latestCommand?.command ?? "idle"}`,
    `State: ${
      runningCheck !== undefined
        ? "running"
        : (latestCheck?.status ??
          (latestCommand === undefined ? "not run" : latestCommand.status))
    }`,
    `Exit code: ${runningCheck === undefined ? (latestCommand?.exitCode ?? latestCheck?.exitCode ?? "n/a") : "running"}`,
    `Duration: ${
      runningCheck === undefined
        ? formatDurationMs(latestCommand?.durationMs ?? latestCheck?.durationMs)
        : "running"
    }`,
    "",
    "Output:",
    ...(outputLines.length > 0
      ? outputLines
      : ["  No check output recorded yet."]),
  ];
}

function buildStatusText(context: TuiReconcileContext): string {
  if (context.inspection !== undefined) {
    return [
      `${context.inspection.phase} / ${context.inspection.activeRole}`,
      context.inspection.commandStatus,
    ].join(" | ");
  }

  if (context.overlay.runStatus !== undefined) {
    return `${context.overlay.runStatus.status} | ${context.overlay.runStatus.summary ?? "Waiting for run activity."}`;
  }

  return "Waiting for live harness activity.";
}

function synthesizeQueueItems(
  context: TuiReconcileContext,
  requiredCheckCommand: string | undefined,
): readonly TuiQueueItem[] {
  const markdownItems = parseQueueTitles(context.artifacts.engineerTask);
  const status = context.inspection?.status;

  if (markdownItems.length > 0) {
    const activeIndex =
      status === "success"
        ? markdownItems.length
        : findQueueActiveIndex(markdownItems, context, requiredCheckCommand);

    return markdownItems.map((title, index) => ({
      id: `task-${index + 1}`,
      status:
        status === "success"
          ? "done"
          : status === "failed" || status === "stopped"
            ? index === Math.min(activeIndex, markdownItems.length - 1)
              ? "blocked"
              : index < activeIndex
                ? "done"
                : "pending"
            : index < activeIndex
              ? "done"
              : index === activeIndex
                ? "active"
                : "pending",
      title,
    }));
  }

  const fallbackItems = [
    context.inspection?.currentObjective,
    context.overlay.currentCommands.engineer?.command,
    requiredCheckCommand === undefined
      ? undefined
      : `Run required check: ${requiredCheckCommand}`,
  ].filter(
    (value): value is string => value !== undefined && value.trim().length > 0,
  );

  return fallbackItems.map((title, index) => ({
    id: `fallback-${index + 1}`,
    status: index === 0 ? "active" : "pending",
    title,
  }));
}

function parseQueueTitles(markdown: string): string[] {
  const executionOrderSection = extractMarkdownSection(
    markdown,
    "Execution Order",
  );
  const orderedItems = parseMarkdownList(executionOrderSection);

  if (orderedItems.length > 0) {
    return orderedItems;
  }

  const objectiveSection = extractMarkdownSection(markdown, "Objective");
  const fallbackItems = parseMarkdownList(objectiveSection);

  return fallbackItems;
}

function extractMarkdownSection(markdown: string, heading: string): string {
  if (markdown.trim().length === 0) {
    return "";
  }

  const lines = markdown.split(/\r?\n/u);
  const headingPattern = new RegExp(
    `^##\\s+${escapeRegExp(heading)}\\s*$`,
    "u",
  );
  const section: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (headingPattern.test(line.trim())) {
      inSection = true;
      continue;
    }

    if (inSection && /^##\s+/u.test(line.trim())) {
      break;
    }

    if (inSection) {
      section.push(line);
    }
  }

  return section.join("\n");
}

function parseMarkdownList(markdown: string): string[] {
  return markdown
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^(\d+\.\s+|[-*]\s+)/u.test(line))
    .map((line) => line.replace(/^(\d+\.\s+|[-*]\s+)/u, "").trim())
    .filter((line) => line.length > 0);
}

function findQueueActiveIndex(
  titles: readonly string[],
  context: TuiReconcileContext,
  requiredCheckCommand: string | undefined,
): number {
  const candidates = [
    context.inspection?.currentObjective,
    context.inspection?.latestDecision,
    context.overlay.currentCommands.engineer?.command,
    requiredCheckCommand,
  ].filter(
    (value): value is string => value !== undefined && value.trim().length > 0,
  );

  for (const candidate of candidates) {
    const matchedIndex = titles.findIndex((title) =>
      includesNormalized(title, candidate),
    );

    if (matchedIndex >= 0) {
      return matchedIndex;
    }
  }

  return 0;
}

function resolveRequiredCheckCommand(
  overlay: TuiLiveOverlay,
  events: readonly JsonRecord[],
): string | undefined {
  if (overlay.requiredCheckCommand !== undefined) {
    return overlay.requiredCheckCommand;
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event === undefined) {
      continue;
    }

    const command = getOptionalString(event, "requiredCheckCommand");

    if (command !== undefined) {
      return command;
    }
  }

  return undefined;
}

function findLatestToolName(
  events: readonly JsonRecord[],
  role: HarnessRole,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event === undefined) {
      continue;
    }

    if (getOptionalString(event, "role") === role) {
      const toolName = getOptionalString(event, "toolName");

      if (toolName !== undefined) {
        return toolName;
      }
    }

    const toolRequest = getOptionalRecord(event, "toolRequest");

    if (toolRequest !== undefined) {
      const toolName = getOptionalString(toolRequest, "toolName");

      if (toolName !== undefined) {
        return toolName;
      }
    }
  }

  return undefined;
}

function findLatestRoleSummary(
  events: readonly JsonRecord[],
  role: HarnessRole,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event === undefined) {
      continue;
    }

    const type = getOptionalString(event, "type");

    if (
      role === "architect" &&
      (type === "architect-action-selected" ||
        type === "architect-plan-created" ||
        type === "architect-review-created")
    ) {
      return getOptionalString(event, "summary");
    }

    if (role === "engineer" && type === "engineer-action-selected") {
      return getOptionalString(event, "summary");
    }
  }

  return undefined;
}

function formatAgentStatus(
  agentStatus: HarnessEvent<"agent:update"> | undefined,
  latestSummary: string | undefined,
): string {
  if (agentStatus === undefined) {
    return latestSummary ?? "Waiting for architect activity.";
  }

  return `${agentStatus.phase} ${agentStatus.status}${latestSummary === undefined ? "" : ` | ${latestSummary}`}`;
}

function formatModelStatus(
  request: HarnessEvent<"model:request"> | undefined,
  retry: HarnessEvent<"model:retry"> | undefined,
): string {
  if (request === undefined) {
    return retry === undefined
      ? "No in-flight model request."
      : `Retry scheduled: ${retry.message}`;
  }

  return `${request.provider}/${request.model} attempt ${request.attempt}`;
}

function resolveTaskSummary(context: TuiReconcileContext): string {
  const firstQueueItem = parseQueueTitles(context.artifacts.engineerTask)[0];

  return firstQueueItem ?? context.task ?? "Waiting for task details.";
}

function formatCheckLine(
  check: RunCheckResult | undefined,
  requiredCheckCommand: string | undefined,
): string {
  if (check === undefined) {
    return requiredCheckCommand === undefined
      ? "No check recorded yet."
      : `Waiting for ${requiredCheckCommand}`;
  }

  return `${check.status}${check.exitCode === undefined ? "" : ` (exit ${check.exitCode})`}: ${check.command ?? requiredCheckCommand ?? check.name}`;
}

function getLatestCommandForRole(
  commands: readonly CommandLogRecord[],
  role: HarnessRole,
): TuiCompletedCommandState | undefined {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index];

    if (command?.role !== role) {
      continue;
    }

    return {
      accessMode: command.accessMode ?? "mutate",
      command: command.command,
      durationMs: command.durationMs,
      exitCode: command.exitCode,
      role,
      status: command.status ?? "completed",
      stderr: command.stderr,
      stdout: command.stdout,
      timestamp: command.timestamp,
      workingDirectory: command.workingDirectory,
    };
  }

  return undefined;
}

function getRunningCheckCommand(
  overlay: TuiLiveOverlay,
  requiredCheckCommand: string | undefined,
): TuiRunningCommandState | undefined {
  const runningCommand = overlay.currentCommands.engineer;

  if (runningCommand === undefined) {
    return undefined;
  }

  if (requiredCheckCommand === undefined) {
    return runningCommand;
  }

  return includesNormalized(runningCommand.command, requiredCheckCommand)
    ? runningCommand
    : undefined;
}

function getLatestCheckCommand(
  context: TuiReconcileContext,
  requiredCheckCommand: string | undefined,
  latestCheck: RunCheckResult | undefined,
): TuiCompletedCommandState | undefined {
  const overlayCommand = context.overlay.lastCommands.engineer;

  if (
    overlayCommand !== undefined &&
    (requiredCheckCommand === undefined ||
      includesNormalized(overlayCommand.command, requiredCheckCommand))
  ) {
    return overlayCommand;
  }

  for (
    let index = context.artifacts.commandLog.length - 1;
    index >= 0;
    index -= 1
  ) {
    const command = context.artifacts.commandLog[index];

    if (command?.role !== "engineer") {
      continue;
    }

    if (
      latestCheck?.command !== undefined &&
      includesNormalized(command.command, latestCheck.command)
    ) {
      return {
        accessMode: command.accessMode ?? "mutate",
        command: command.command,
        durationMs: command.durationMs,
        exitCode: command.exitCode,
        role: "engineer",
        status: command.status ?? "completed",
        stderr: command.stderr,
        stdout: command.stdout,
        timestamp: command.timestamp,
        workingDirectory: command.workingDirectory,
      };
    }

    if (
      requiredCheckCommand !== undefined &&
      includesNormalized(command.command, requiredCheckCommand)
    ) {
      return {
        accessMode: command.accessMode ?? "mutate",
        command: command.command,
        durationMs: command.durationMs,
        exitCode: command.exitCode,
        role: "engineer",
        status: command.status ?? "completed",
        stderr: command.stderr,
        stdout: command.stdout,
        timestamp: command.timestamp,
        workingDirectory: command.workingDirectory,
      };
    }
  }

  return undefined;
}

function formatRunningCommandOutput(
  output: readonly TuiRunningCommandOutputLine[],
  droppedOutputLineCount: number,
): string[] {
  const boundedOutput = boundLines(output, TEST_OUTPUT_LINE_LIMIT);
  const hiddenLineCount = droppedOutputLineCount + boundedOutput.dropped;
  const lines = boundedOutput.lines.map(
    (line) => `  ${line.stream} | ${line.text}`,
  );

  return hiddenLineCount > 0
    ? [
        `  (${hiddenLineCount} older output lines hidden to keep the pane bounded)`,
        ...lines,
      ]
    : lines;
}

function formatCommandOutput(
  stdout: string | undefined,
  stderr: string | undefined,
): string[] {
  const lines = [
    ...splitLines(stdout).map((line) => `  stdout | ${line}`),
    ...splitLines(stderr).map((line) => `  stderr | ${line}`),
  ];
  const boundedLines = boundLines(lines, TEST_OUTPUT_LINE_LIMIT);

  return boundedLines.dropped > 0
    ? [
        `  (${boundedLines.dropped} older output lines hidden to keep the pane bounded)`,
        ...boundedLines.lines,
      ]
    : [...boundedLines.lines];
}

function toHistoricalEventLogEntry(
  event: JsonRecord,
): Omit<TuiLogEntry, "id"> | undefined {
  const timestamp = getOptionalString(event, "timestamp");
  const type = getOptionalString(event, "type");

  if (timestamp === undefined || type === undefined) {
    return undefined;
  }

  switch (type) {
    case "architect-engineer-run-started":
      return toLogEntry(
        timestamp,
        "runtime",
        "info",
        "Architect/Engineer run started.",
      );
    case "engineer-run-started":
      return toLogEntry(
        timestamp,
        "engineer",
        "info",
        "Engineer task started.",
      );
    case "architect-action-selected":
    case "engineer-action-selected":
      return toLogEntry(
        timestamp,
        type === "architect-action-selected" ? "architect" : "engineer",
        "info",
        getOptionalString(event, "summary") ?? `${type} recorded.`,
      );
    case "architect-plan-created":
      return toLogEntry(
        timestamp,
        "architect",
        "info",
        getOptionalString(event, "summary") ?? "Architect plan created.",
      );
    case "architect-review-created":
      return toLogEntry(
        timestamp,
        "architect",
        "info",
        getOptionalString(event, "summary") ?? "Architect review created.",
      );
    case "engineer-convergence-guard-triggered":
      return toLogEntry(
        timestamp,
        "engineer",
        "warn",
        `Convergence guard: ${getOptionalString(event, "reason") ?? "guard triggered"}`,
      );
    case "tool-call":
      return toLogEntry(
        timestamp,
        getOptionalString(event, "role") ?? "runtime",
        getOptionalString(event, "status") === "failed" ? "warn" : "info",
        `${getOptionalString(event, "toolName") ?? "tool"} ${getOptionalString(event, "status") ?? "completed"}`,
      );
    case "engineer-run-finished":
    case "architect-engineer-run-finished":
      return toLogEntry(
        timestamp,
        "runtime",
        getOptionalString(event, "status") === "success" ? "info" : "warn",
        getOptionalString(event, "summary") ?? `${type} recorded.`,
      );
    default:
      return toLogEntry(timestamp, "runtime", "info", humanizeEventType(type));
  }
}

function toChunkLines(
  chunk: string,
  timestamp: string,
  type: "command:stderr" | "command:stdout",
  lineLimit: number,
): { dropped: number; lines: readonly TuiRunningCommandOutputLine[] } {
  const boundedLines = boundLines(splitLines(chunk), lineLimit);

  return {
    dropped: boundedLines.dropped,
    lines: boundedLines.lines.map((text) => ({
      stream: type === "command:stderr" ? "stderr" : "stdout",
      text,
      timestamp,
    })),
  };
}

function splitLines(value: string | undefined): string[] {
  if (value === undefined || value.length === 0) {
    return [];
  }

  return value
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function indentExcerpt(markdown: string, fallback: string): string[] {
  const excerptLines = splitLines(markdown).slice(0, PANE_EXCERPT_LINE_LIMIT);

  if (excerptLines.length === 0) {
    return [`  ${fallback}`];
  }

  const hiddenLineCount = Math.max(
    0,
    splitLines(markdown).length - excerptLines.length,
  );

  return hiddenLineCount > 0
    ? [
        ...excerptLines.map((line) => `  ${line}`),
        `  ... (${hiddenLineCount} additional lines omitted)`,
      ]
    : excerptLines.map((line) => `  ${line}`);
}

function toLogEntry(
  timestamp: string,
  source: string,
  level: TuiLogEntry["level"],
  summary: string,
): Omit<TuiLogEntry, "id"> {
  return {
    level,
    source,
    summary,
    timestamp,
  };
}

function humanizeEventType(value: string): string {
  return capitalize(value.replaceAll("-", " "));
}

function summarizeCommandExit(
  exitCode: number | null,
  status: CommandLogRecord["status"] | undefined,
): string {
  if (status === "timed-out") {
    return "timed out";
  }

  if (status === "cancelled") {
    return "was cancelled";
  }

  if (status === "failed-to-start") {
    return "failed to start";
  }

  return exitCode === null ? "failed" : `failed (exit ${exitCode})`;
}

function formatDurationMs(durationMs: number | undefined): string {
  if (durationMs === undefined) {
    return "n/a";
  }

  return `${durationMs}ms`;
}

function includesNormalized(left: string, right: string): boolean {
  return normalizeText(left).includes(normalizeText(right));
}

function normalizeText(value: string): string {
  return value.trim().replaceAll(/\s+/gu, " ").toLowerCase();
}

function capitalize(value: string): string {
  return value.length === 0
    ? value
    : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function getOptionalString(value: JsonRecord, key: string): string | undefined {
  const entry = value[key];
  return typeof entry === "string" ? entry : undefined;
}

function getOptionalRecord(
  value: JsonRecord,
  key: string,
): JsonRecord | undefined {
  const entry = value[key];
  return typeof entry === "object" && entry !== null && !Array.isArray(entry)
    ? (entry as JsonRecord)
    : undefined;
}

function boundLines<TLine>(
  lines: readonly TLine[],
  limit: number,
  preserve: "head" | "tail" = "tail",
): { dropped: number; lines: readonly TLine[] } {
  const overflow = Math.max(0, lines.length - limit);

  if (overflow === 0) {
    return {
      dropped: 0,
      lines,
    };
  }

  return {
    dropped: overflow,
    lines: preserve === "head" ? lines.slice(0, limit) : lines.slice(overflow),
  };
}
