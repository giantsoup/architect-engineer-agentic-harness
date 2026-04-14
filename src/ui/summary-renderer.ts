import type {
  RunArtifactPresence,
  RunInspection,
} from "../runtime/run-history.js";

const CLI_NAME = "architect-engineer-agentic-harness";

export function renderLiveSnapshotBlock(run: RunInspection): string {
  const lines = [
    `Run ${run.runId}  ${formatStatusLabel(run.status)}  ${formatDuration(run.elapsedMs)}`,
    `Phase: ${run.phase}`,
    `Role: ${capitalize(run.activeRole)}`,
    `Objective: ${truncate(run.currentObjective)}`,
    `Command/check: ${truncate(run.commandStatus)}`,
    `Decision: ${truncate(run.latestDecision)}`,
    `Dossier: ${run.runDirRelativePath}`,
  ];

  return `${lines.join("\n")}\n`;
}

export function renderLiveSnapshotLine(run: RunInspection): string {
  return [
    `[${formatDuration(run.elapsedMs)}]`,
    formatStatusLabel(run.status),
    `${run.phase} / ${capitalize(run.activeRole)}`,
    `objective: ${truncate(run.currentObjective, 72)}`,
    `command: ${truncate(run.commandStatus, 64)}`,
    `decision: ${truncate(run.latestDecision, 64)}`,
  ].join(" | ");
}

export function renderRunCompletionSummary(run: RunInspection): string {
  const lines = [
    `Run ${run.status}: ${run.summary}`,
    `Run ID: ${run.runId}`,
    `Phase: ${run.phase}`,
    `Elapsed: ${formatDuration(run.elapsedMs)}`,
    `Dossier: ${run.runDirRelativePath}`,
  ];

  if (run.stopReason !== undefined) {
    lines.push(`Stop reason: ${run.stopReason}`);
  }

  lines.push(`Objective: ${run.currentObjective}`);
  lines.push(`Latest decision: ${run.latestDecision}`);
  lines.push(`Command/check: ${run.commandStatus}`);
  lines.push("Artifacts:");

  for (const artifact of run.primaryArtifacts) {
    lines.push(`- ${formatArtifactLabel(artifact)}: ${artifact.relativePath}`);
  }

  lines.push(`Status command: ${CLI_NAME} status ${run.runId}`);
  lines.push(`Inspect command: ${CLI_NAME} inspect ${run.runId}`);

  return `${lines.join("\n")}\n`;
}

export function renderStatusSummary(run: RunInspection): string {
  const lines = [
    `Run ${run.runId}`,
    `Status: ${run.status}`,
    `Summary: ${run.summary}`,
    `Phase: ${run.phase}`,
    `Started: ${run.createdAt}`,
    `Updated: ${run.updatedAt}`,
    `Elapsed: ${formatDuration(run.elapsedMs)}`,
    `Role: ${capitalize(run.activeRole)}`,
    `Objective: ${run.currentObjective}`,
    `Latest decision: ${run.latestDecision}`,
    `Command/check: ${run.commandStatus}`,
    `Dossier: ${run.runDirRelativePath}`,
  ];

  if (run.stopReason !== undefined) {
    lines.push(`Stop reason: ${run.stopReason}`);
  }

  lines.push("Key artifacts:");

  for (const artifact of run.primaryArtifacts) {
    lines.push(`- ${formatArtifactLabel(artifact)}: ${artifact.relativePath}`);
  }

  return `${lines.join("\n")}\n`;
}

export function renderInspectSummary(run: RunInspection): string {
  const lines = [
    `Run ${run.runId}`,
    `Status: ${run.status}`,
    `Summary: ${run.summary}`,
    `Phase: ${run.phase}`,
    `Task: ${run.task ?? "not recorded"}`,
    `Dossier: ${run.runDirRelativePath}`,
    `Manifest: ${run.artifacts.run.relativePath}`,
  ];

  if (run.result !== undefined) {
    lines.push(`Result JSON: ${run.artifacts.result.relativePath}`);
  }

  if (run.stopReason !== undefined) {
    lines.push(`Stop reason: ${run.stopReason}`);
  }

  lines.push("Artifacts:");

  for (const artifact of orderedArtifacts(run)) {
    lines.push(
      `- ${formatArtifactLabel(artifact)}: ${formatArtifactState(artifact)}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function orderedArtifacts(run: RunInspection): RunArtifactPresence[] {
  return [
    run.artifacts.finalReport,
    run.artifacts.result,
    run.artifacts.events,
    run.artifacts.checks,
    run.artifacts.commandLog,
    run.artifacts.failureNotes,
    run.artifacts.diff,
    run.artifacts.architectPlan,
    run.artifacts.engineerTask,
    run.artifacts.architectReview,
    run.artifacts.run,
  ];
}

function formatArtifactState(artifact: RunArtifactPresence): string {
  if (!artifact.exists) {
    return "missing";
  }

  return artifact.written
    ? artifact.relativePath
    : `${artifact.relativePath} (empty)`;
}

function formatArtifactLabel(artifact: RunArtifactPresence): string {
  switch (artifact.key) {
    case "finalReport":
      return "final report";
    case "result":
      return "result JSON";
    case "events":
      return "events";
    case "checks":
      return "checks";
    case "commandLog":
      return "command log";
    case "failureNotes":
      return "failure notes";
    case "diff":
      return "diff";
    case "architectPlan":
      return "architect plan";
    case "engineerTask":
      return "engineer task";
    case "architectReview":
      return "architect review";
    case "run":
      return "run manifest";
  }
}

function formatStatusLabel(status: RunInspection["status"]): string {
  return status.toUpperCase();
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function truncate(value: string, maxLength: number = 96): string {
  const trimmed = value.trim().replaceAll(/\s+/gu, " ");

  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 1)}…`;
}

function capitalize(value: string): string {
  return value.length === 0
    ? value
    : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
