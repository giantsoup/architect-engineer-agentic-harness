import type { HarnessEvent } from "../runtime/harness-events.js";
import type { RunInspection } from "../runtime/run-history.js";
import type { CommandLogRecord, RunCheckResult } from "../types/run.js";
import type { TuiActiveRole, TuiLogEntry, TuiRoleId } from "./state.js";
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
  activeRole: TuiActiveRole;
  cards: Record<TuiRoleId, { lines: readonly string[] }>;
  phaseText: string;
  statusText: string;
}

export interface TuiReconcileContext {
  artifacts: TuiArtifactSnapshot;
  inspection: RunInspection | undefined;
  overlay: TuiLiveOverlay;
  task?: string | undefined;
}

const HYDRATED_LOG_ENTRY_LIMIT = 600;
const LIVE_COMMAND_CHUNK_LINE_LIMIT = 12;
const LIVE_COMMAND_OUTPUT_LINE_LIMIT = 120;

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
      if (!isHarnessRole(event.role)) {
        return {
          appendLogEntries: [],
          requestReconcile: false,
        };
      }

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
      if (!isHarnessRole(event.role)) {
        return {
          appendLogEntries: [],
          requestReconcile: false,
        };
      }

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
      if (!isHarnessRole(event.role)) {
        return {
          appendLogEntries: [],
          requestReconcile: false,
        };
      }

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
      if (!isHarnessRole(event.role)) {
        return {
          appendLogEntries: [],
          requestReconcile: false,
        };
      }

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
      if (!isHarnessRole(event.role)) {
        return {
          appendLogEntries: [],
          requestReconcile: false,
        };
      }

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
      if (!isHarnessRole(event.role)) {
        return {
          appendLogEntries: [],
          requestReconcile: false,
        };
      }

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
    default:
      return {
        appendLogEntries: [],
        requestReconcile: false,
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
    activeRole: resolveProjectionActiveRole(context),
    cards: {
      architect: {
        lines: buildArchitectCardLines(context, requiredCheckCommand),
      },
      engineer: {
        lines: buildEngineerCardLines(context, requiredCheckCommand),
      },
    },
    phaseText: resolveProjectionPhase(context),
    statusText: buildStatusText(context),
  };
}

function buildArchitectCardLines(
  context: TuiReconcileContext,
  requiredCheckCommand: string | undefined,
): readonly string[] {
  const planSummary =
    context.artifacts.architectReview.trim().length > 0
      ? summarizeMarkdownArtifact(
          context.artifacts.architectReview,
          "Architect review recorded.",
        )
      : context.artifacts.architectPlan.trim().length > 0
        ? summarizeMarkdownArtifact(
            context.artifacts.architectPlan,
            "Architect plan recorded.",
          )
        : undefined;
  const latestSummary = resolveArchitectLatestSummary(
    context,
    requiredCheckCommand,
    planSummary,
  );
  const decisionSummary =
    context.inspection?.latestDecision ??
    planSummary ??
    "No architect decision recorded yet.";

  return formatCardRows([
    ["Task", resolveArchitectTask(context, planSummary)],
    ["State", resolveArchitectState(context)],
    ["Latest", latestSummary],
    ["Decision", decisionSummary],
  ]);
}

function buildEngineerCardLines(
  context: TuiReconcileContext,
  requiredCheckCommand: string | undefined,
): readonly string[] {
  const runningCommand = context.overlay.currentCommands.engineer;
  const lastCommand =
    context.overlay.lastCommands.engineer ??
    getLatestCommandForRole(context.artifacts.commandLog, "engineer");
  const latestCheck =
    context.overlay.latestCheck?.check ??
    context.artifacts.checks?.checks.at(-1);

  return formatCardRows([
    ["Task", resolveEngineerTask(context)],
    [
      "State",
      resolveEngineerState(context, runningCommand, lastCommand, latestCheck),
    ],
    ["Tool", resolveEngineerTool(context, runningCommand, lastCommand)],
    [
      "Result",
      resolveEngineerResult(
        context,
        requiredCheckCommand,
        runningCommand,
        lastCommand,
        latestCheck,
      ),
    ],
  ]);
}

function resolveProjectionActiveRole(
  context: TuiReconcileContext,
): TuiActiveRole {
  if (context.overlay.currentCommands.engineer !== undefined) {
    return "engineer";
  }

  if (context.overlay.currentCommands.architect !== undefined) {
    return "architect";
  }

  if (context.overlay.agentStatus.engineer?.status === "active") {
    return "engineer";
  }

  if (context.overlay.agentStatus.architect?.status === "active") {
    return "architect";
  }

  if (context.inspection !== undefined) {
    return context.inspection.activeRole === "agent"
      ? "system"
      : context.inspection.activeRole;
  }

  return "system";
}

function resolveProjectionPhase(context: TuiReconcileContext): string {
  if (context.overlay.runStatus?.phase !== undefined) {
    return capitalize(context.overlay.runStatus.phase.replaceAll("-", " "));
  }

  if (context.overlay.currentCommands.engineer !== undefined) {
    return "Execution";
  }

  if (context.overlay.agentStatus.architect?.status === "active") {
    return capitalize(context.overlay.agentStatus.architect.phase);
  }

  if (context.overlay.agentStatus.engineer?.status === "active") {
    return capitalize(context.overlay.agentStatus.engineer.phase);
  }

  if (context.inspection?.phase !== undefined) {
    return context.inspection.phase;
  }

  if (context.overlay.runStatus?.status !== undefined) {
    return capitalize(context.overlay.runStatus.status);
  }

  return "Waiting";
}

function resolveArchitectTask(
  context: TuiReconcileContext,
  planSummary: string | undefined,
): string {
  if (context.inspection?.activeRole === "architect") {
    return (
      context.inspection.currentObjective ??
      context.inspection.task ??
      planSummary ??
      context.task ??
      "Waiting for architect planning."
    );
  }

  return (
    planSummary ??
    context.task ??
    context.inspection?.task ??
    "Waiting for architect planning."
  );
}

function resolveArchitectState(context: TuiReconcileContext): string {
  const architectAgent = context.overlay.agentStatus.architect;

  if (architectAgent !== undefined) {
    return architectAgent.status === "active"
      ? `${architectAgent.phase} / active`
      : `${architectAgent.phase} / completed`;
  }

  if (
    context.inspection?.activeRole === "engineer" &&
    context.inspection.status === "running"
  ) {
    return "handoff / waiting";
  }

  if (context.inspection !== undefined) {
    return `${context.inspection.phase.toLowerCase()} / ${context.inspection.status}`;
  }

  return "waiting";
}

function resolveArchitectLatestSummary(
  context: TuiReconcileContext,
  requiredCheckCommand: string | undefined,
  artifactSummary: string | undefined,
): string {
  const architectAgent = context.overlay.agentStatus.architect;

  if (architectAgent !== undefined) {
    return `Architect ${architectAgent.phase}: ${architectAgent.summary}`;
  }

  const reasoningTimeline = buildArchitectReasoningTimeline(
    context,
    requiredCheckCommand,
  );

  if (reasoningTimeline.length > 0) {
    const latestLine = reasoningTimeline.at(-1);

    if (latestLine !== undefined) {
      return latestLine.replace(/^\d{2}:\d{2}:\d{2}\s+\S+\s+/u, "");
    }
  }

  return artifactSummary ?? "No architect activity recorded yet.";
}

function resolveEngineerTask(context: TuiReconcileContext): string {
  if (context.inspection?.activeRole === "engineer") {
    return (
      context.inspection.currentObjective ??
      context.inspection.task ??
      resolveTaskSummary(context)
    );
  }

  return context.inspection?.task ?? resolveTaskSummary(context);
}

function resolveEngineerState(
  context: TuiReconcileContext,
  runningCommand: TuiRunningCommandState | undefined,
  lastCommand: TuiCompletedCommandState | undefined,
  latestCheck: RunCheckResult | undefined,
): string {
  if (runningCommand !== undefined) {
    return "running";
  }

  if (latestCheck !== undefined) {
    return latestCheck.status;
  }

  if (context.inspection?.status === "failed") {
    return "failed";
  }

  if (context.inspection?.status === "stopped") {
    return "blocked";
  }

  if (lastCommand !== undefined) {
    if (lastCommand.status !== "completed") {
      return lastCommand.status;
    }

    return lastCommand.exitCode === 0 ? "idle" : "failed";
  }

  return "idle";
}

function resolveEngineerTool(
  context: TuiReconcileContext,
  runningCommand: TuiRunningCommandState | undefined,
  lastCommand: TuiCompletedCommandState | undefined,
): string {
  if (runningCommand !== undefined) {
    return runningCommand.command;
  }

  const lastTool =
    context.overlay.lastToolByRole.engineer ??
    findLatestToolName(context.artifacts.events, "engineer");

  if (lastTool !== undefined) {
    return lastTool;
  }

  if (lastCommand !== undefined) {
    return lastCommand.command;
  }

  return "No tool or command recorded yet.";
}

function resolveEngineerResult(
  context: TuiReconcileContext,
  requiredCheckCommand: string | undefined,
  runningCommand: TuiRunningCommandState | undefined,
  lastCommand: TuiCompletedCommandState | undefined,
  latestCheck: RunCheckResult | undefined,
): string {
  if (runningCommand !== undefined) {
    const latestOutput = runningCommand.output.at(-1)?.text;
    const location =
      runningCommand.workingDirectory === undefined
        ? ""
        : ` from ${runningCommand.workingDirectory}`;

    return latestOutput === undefined
      ? `Running${location}.`
      : `Running${location}: ${latestOutput}`;
  }

  if (latestCheck !== undefined) {
    return formatCheckLine(latestCheck, requiredCheckCommand);
  }

  if (lastCommand !== undefined) {
    return `${lastCommand.command} ${summarizeCommandResult(lastCommand)}`;
  }

  if (context.inspection?.commandStatus !== undefined) {
    return context.inspection.commandStatus;
  }

  return "No command or check result recorded yet.";
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

function buildStatusText(context: TuiReconcileContext): string {
  if (
    context.overlay.runStatus !== undefined &&
    (context.inspection === undefined ||
      Date.parse(context.overlay.runStatus.timestamp) >=
        Date.parse(context.inspection.updatedAt))
  ) {
    return `${context.overlay.runStatus.status} | ${context.overlay.runStatus.summary ?? "Waiting for run activity."}`;
  }

  if (context.inspection !== undefined) {
    return `${context.inspection.phase} | ${context.inspection.activeRole} | ${context.inspection.commandStatus}`;
  }

  return "Waiting for live harness activity.";
}

function buildArchitectReasoningTimeline(
  context: TuiReconcileContext,
  requiredCheckCommand: string | undefined,
): string[] {
  const entries: Array<{ kind: string; summary: string; timestamp: string }> =
    [];
  let sawPlanEvent = false;
  let sawReviewEvent = false;
  let sawHandoff = false;

  for (const event of context.artifacts.events) {
    const timestamp = getOptionalString(event, "timestamp");
    const type = getOptionalString(event, "type");

    if (timestamp === undefined || type === undefined) {
      continue;
    }

    let summary: string | undefined;

    switch (type) {
      case "architect-engineer-run-started":
        summary =
          requiredCheckCommand === undefined
            ? "Run started."
            : `Run started. Required check: ${requiredCheckCommand}.`;
        break;
      case "architect-action-selected":
        summary =
          getOptionalString(event, "summary") ?? "Architect action recorded.";
        break;
      case "architect-plan-created":
        sawPlanEvent = true;
        summary = `Plan created: ${getOptionalString(event, "summary") ?? summarizeMarkdownArtifact(context.artifacts.architectPlan, "Plan artifact updated.")}`;
        break;
      case "architect-review-created":
        sawReviewEvent = true;
        summary = `Review recorded: ${getOptionalString(event, "summary") ?? summarizeMarkdownArtifact(context.artifacts.architectReview, "Review artifact updated.")}`;
        break;
      case "engineer-run-started":
        sawHandoff = true;
        summary = "Handed off to engineer.";
        break;
      default:
        summary = undefined;
        break;
    }

    if (summary !== undefined) {
      entries.push({
        kind:
          type === "architect-engineer-run-started"
            ? "START"
            : type === "architect-action-selected"
              ? "PLAN"
              : type === "architect-plan-created"
                ? "PLAN"
                : type === "architect-review-created"
                  ? "REVIEW"
                  : "HANDOFF",
        summary,
        timestamp,
      });
    }
  }

  if (!sawPlanEvent && context.artifacts.architectPlan.trim().length > 0) {
    entries.push({
      kind: "PLAN",
      summary: `Plan available: ${summarizeMarkdownArtifact(context.artifacts.architectPlan, "Architect plan recorded.")}`,
      timestamp: context.inspection?.updatedAt ?? new Date().toISOString(),
    });
  }

  if (!sawReviewEvent && context.artifacts.architectReview.trim().length > 0) {
    entries.push({
      kind: "REVIEW",
      summary: `Review available: ${summarizeMarkdownArtifact(context.artifacts.architectReview, "Architect review recorded.")}`,
      timestamp: context.inspection?.updatedAt ?? new Date().toISOString(),
    });
  }

  if (
    !sawHandoff &&
    context.inspection?.activeRole === "engineer" &&
    context.inspection.status === "running"
  ) {
    entries.push({
      kind: "HANDOFF",
      summary: "Handed off to engineer.",
      timestamp: context.inspection.updatedAt,
    });
  }

  if (context.inspection?.latestDecision !== undefined) {
    entries.push({
      kind: "NOTE",
      summary: context.inspection.latestDecision,
      timestamp: context.inspection.updatedAt,
    });
  }

  const architectAgent = context.overlay.agentStatus.architect;

  if (architectAgent !== undefined) {
    entries.push({
      kind: architectAgent.status === "completed" ? "DONE" : "ACTIVE",
      summary: `Architect ${architectAgent.phase}: ${architectAgent.summary}`,
      timestamp: architectAgent.timestamp,
    });
  }

  if (context.inspection !== undefined) {
    entries.push({
      kind: "STATE",
      summary: `${context.inspection.phase} / ${context.inspection.activeRole} / ${context.inspection.status}`,
      timestamp: context.inspection.updatedAt,
    });
  }

  return dedupeTimelineLines(
    entries
      .sort(
        (left, right) =>
          Date.parse(left.timestamp) - Date.parse(right.timestamp),
      )
      .map((entry) =>
        formatTimelineEntry(entry.timestamp, entry.kind, entry.summary),
      ),
  );
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

function summarizeMarkdownArtifact(markdown: string, fallback: string): string {
  const summaryLine = splitLines(markdown).find(
    (line) => !/^(#|[-*]\s*$)/u.test(line.trim()),
  );

  return summaryLine ?? fallback;
}

function appendUniqueLine(lines: string[], line: string): void {
  if (
    !lines.some(
      (existingLine) => normalizeText(existingLine) === normalizeText(line),
    )
  ) {
    lines.push(line);
  }
}

function dedupeTimelineLines(lines: readonly string[]): string[] {
  const deduped: string[] = [];

  for (const line of lines) {
    appendUniqueLine(deduped, line);
  }

  return deduped;
}

function formatTimelineEntry(
  timestamp: string,
  kind: string,
  summary: string,
): string {
  return `${formatClock(timestamp)}  ${kind.padEnd(6)}  ${summary}`;
}

function formatExitSuffix(
  exitCode: number | null,
  status: CommandLogRecord["status"] | undefined,
): string {
  if (status === "timed-out") {
    return "timed out";
  }

  if (status === "cancelled") {
    return "cancelled";
  }

  if (status === "failed-to-start") {
    return "failed to start";
  }

  return exitCode === null ? "failed" : `exit ${exitCode}`;
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

function summarizeCommandResult(
  command: TuiCompletedCommandState | undefined,
): string {
  if (command === undefined) {
    return "n/a";
  }

  return command.status === "completed"
    ? command.exitCode === null
      ? "completed"
      : `exit ${command.exitCode}`
    : formatExitSuffix(command.exitCode, command.status);
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

function formatCardRows(
  rows: ReadonlyArray<readonly [label: string, value: string]>,
): string[] {
  const labelWidth = 8;

  return rows.map(
    ([label, value]) => `${label.padEnd(labelWidth)}  ${value.trim()}`,
  );
}

function formatClock(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString().slice(11, 19);
}

function normalizeText(value: string): string {
  return value.trim().replaceAll(/\s+/gu, " ").toLowerCase();
}

function isHarnessRole(value: string): value is HarnessRole {
  return value === "architect" || value === "engineer";
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
