import type { ArchitectReviewOutput } from "../models/types.js";
import type {
  ArchitectEngineerFinalOutcome,
  ArchitectEngineerState,
} from "./architect-engineer-state.js";
import type { EngineerTaskStopReason } from "./engineer-task.js";

export function getRemainingRunTimeMs(
  state: ArchitectEngineerState,
  now: Date,
): number {
  return new Date(state.stopConditions.deadlineAt).getTime() - now.getTime();
}

export function hasArchitectEngineerTimedOut(
  state: ArchitectEngineerState,
  now: Date,
): boolean {
  return getRemainingRunTimeMs(state, now) <= 0;
}

export function hasReachedFailedCheckThreshold(
  state: ArchitectEngineerState,
): boolean {
  return (
    state.stopConditions.consecutiveFailedRequiredChecks >=
    state.stopConditions.maxConsecutiveFailedRequiredChecks
  );
}

export function getStopConditionOutcome(
  state: ArchitectEngineerState,
  now: Date,
): ArchitectEngineerFinalOutcome | undefined {
  if (hasArchitectEngineerTimedOut(state, now)) {
    return {
      status: "stopped",
      stopReason: "timeout",
      summary: `Run timed out after ${state.metadata.timeoutMs}ms.`,
    };
  }

  if (hasReachedFailedCheckThreshold(state)) {
    return {
      status: "failed",
      stopReason: "max-consecutive-failed-checks",
      summary: `Required check failed ${state.stopConditions.consecutiveFailedRequiredChecks} consecutive times.`,
    };
  }

  return undefined;
}

export function getEngineerStopOutcome(
  stopReason: EngineerTaskStopReason,
  summary: string,
): ArchitectEngineerFinalOutcome | undefined {
  switch (stopReason) {
    case "timeout":
      return {
        status: "stopped",
        stopReason: "timeout",
        summary,
      };
    case "max-consecutive-failed-checks":
      return {
        status: "failed",
        stopReason: "max-consecutive-failed-checks",
        summary,
      };
    default:
      return undefined;
  }
}

export function getReviewOutcome(
  review: ArchitectReviewOutput,
): ArchitectEngineerFinalOutcome | undefined {
  switch (review.decision) {
    case "approve":
      return {
        status: "success",
        stopReason: "architect-approved",
        summary: review.summary,
      };
    case "fail":
      return {
        status: "failed",
        stopReason: "architect-failed",
        summary: review.summary,
      };
    case "revise":
      return undefined;
  }
}
