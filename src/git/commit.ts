import type { GitStatusEntry } from "../tools/types.js";

export type RunGitCommitPhase = "engineer-milestone" | "final-state";

export interface CreateRunCommitMessageOptions {
  phase: RunGitCommitPhase;
  reviewCycle: number;
  runId: string;
  task: string;
  engineerAttempt?: number | undefined;
}

export function isCommitNeeded(entries: readonly GitStatusEntry[]): boolean {
  return entries.length > 0;
}

export function createRunCommitMessage(
  options: CreateRunCommitMessageOptions,
): string {
  const taskSummary = options.task.trim().replace(/\s+/gu, " ").slice(0, 72);

  if (options.phase === "engineer-milestone") {
    const engineerAttempt = options.engineerAttempt ?? 0;

    return [
      `ae(${options.runId}): engineer milestone ${engineerAttempt}`,
      taskSummary.length > 0 ? "" : undefined,
      taskSummary.length > 0 ? taskSummary : undefined,
      `review-cycle:${options.reviewCycle}`,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  return [
    `ae(${options.runId}): finalize successful run`,
    taskSummary.length > 0 ? "" : undefined,
    taskSummary.length > 0 ? taskSummary : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
