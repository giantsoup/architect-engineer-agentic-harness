import type {
  ArchitectPlanOutput,
  ArchitectReviewOutput,
} from "../models/types.js";
import type { RunDossier } from "./run-dossier.js";
import type {
  EngineerTaskExecution,
  EngineerTaskStopReason,
} from "./engineer-task.js";
import type { RunCheckResult, RunResult } from "../types/run.js";
import type { ToolExecutionSummary } from "../tools/types.js";
import {
  createInitialRunGitMetadata,
  type RuntimeRunGitMetadata,
} from "./run-git-state.js";

export type ArchitectEngineerNodeName =
  | "prepare"
  | "plan"
  | "execute"
  | "review"
  | "finalize";

export type ArchitectEngineerStopReason =
  | "architect-approved"
  | "architect-failed"
  | "architect-model-error"
  | "dirty-working-tree"
  | "git-automation-error"
  | "max-consecutive-failed-checks"
  | "timeout"
  | `engineer-${EngineerTaskStopReason}`;

export interface ArchitectEngineerFailureNote {
  author: "architect" | "engineer" | "system";
  details: string[];
  summary: string;
  timestamp: string;
}

export interface ArchitectEngineerRunMetadata {
  createdAt: string;
  runId: string;
  startedAt: string;
  task: string;
  timeoutMs: number;
}

export interface ArchitectEngineerStopConditionState {
  consecutiveFailedRequiredChecks: number;
  deadlineAt: string;
  maxConsecutiveFailedRequiredChecks: number;
}

export interface ArchitectEngineerIterationState {
  engineerAttempts: number;
  reviewCycles: number;
}

export interface ArchitectEngineerExecutionSnapshot {
  checks: RunCheckResult[];
  consecutiveFailedChecks: number;
  failureNotes?: string | undefined;
  iterationCount: number;
  result: RunResult;
  stopReason: EngineerTaskStopReason;
  toolSummary: ToolExecutionSummary;
}

export interface ArchitectEngineerFinalOutcome {
  status: RunResult["status"];
  stopReason: ArchitectEngineerStopReason;
  summary: string;
}

export interface ArchitectEngineerState {
  architectPlan?: ArchitectPlanOutput | undefined;
  architectReview?: ArchitectReviewOutput | undefined;
  checks: RunCheckResult[];
  dossier?: RunDossier | undefined;
  engineerExecution?: ArchitectEngineerExecutionSnapshot | undefined;
  failureNotes: ArchitectEngineerFailureNote[];
  finalOutcome?: ArchitectEngineerFinalOutcome | undefined;
  git: RuntimeRunGitMetadata;
  iterations: ArchitectEngineerIterationState;
  metadata: ArchitectEngineerRunMetadata;
  nextNode: ArchitectEngineerNodeName;
  stopConditions: ArchitectEngineerStopConditionState;
}

export interface CreateArchitectEngineerStateOptions {
  createdAt: Date;
  maxConsecutiveFailedRequiredChecks: number;
  runId: string;
  task: string;
  timeoutMs: number;
}

export function createArchitectEngineerState(
  options: CreateArchitectEngineerStateOptions,
): ArchitectEngineerState {
  const createdAt = options.createdAt.toISOString();

  return {
    checks: [],
    failureNotes: [],
    git: createInitialRunGitMetadata(),
    iterations: {
      engineerAttempts: 0,
      reviewCycles: 0,
    },
    metadata: {
      createdAt,
      runId: options.runId,
      startedAt: createdAt,
      task: options.task,
      timeoutMs: options.timeoutMs,
    },
    nextNode: "prepare",
    stopConditions: {
      consecutiveFailedRequiredChecks: 0,
      deadlineAt: new Date(
        options.createdAt.getTime() + options.timeoutMs,
      ).toISOString(),
      maxConsecutiveFailedRequiredChecks:
        options.maxConsecutiveFailedRequiredChecks,
    },
  };
}

export function withPreparedDossier(
  state: ArchitectEngineerState,
  dossier: RunDossier,
): ArchitectEngineerState {
  return {
    ...state,
    dossier,
    nextNode: "plan",
  };
}

export function withRunGitMetadata(
  state: ArchitectEngineerState,
  git: RuntimeRunGitMetadata,
): ArchitectEngineerState {
  return {
    ...state,
    git,
  };
}

export function withArchitectPlan(
  state: ArchitectEngineerState,
  architectPlan: ArchitectPlanOutput,
): ArchitectEngineerState {
  return {
    ...state,
    architectPlan,
    nextNode: "execute",
  };
}

export function withEngineerExecution(
  state: ArchitectEngineerState,
  execution: EngineerTaskExecution,
): ArchitectEngineerState {
  return {
    ...state,
    checks: [...execution.checks],
    engineerExecution: {
      checks: [...execution.checks],
      consecutiveFailedChecks: execution.consecutiveFailedChecks,
      failureNotes: execution.failureNotes,
      iterationCount: execution.iterationCount,
      result: execution.result,
      stopReason: execution.stopReason,
      toolSummary: execution.toolSummary,
    },
    iterations: {
      ...state.iterations,
      engineerAttempts: state.iterations.engineerAttempts + 1,
    },
    stopConditions: {
      ...state.stopConditions,
      consecutiveFailedRequiredChecks: execution.consecutiveFailedChecks,
    },
    nextNode: "review",
  };
}

export function withArchitectReview(
  state: ArchitectEngineerState,
  architectReview: ArchitectReviewOutput,
): ArchitectEngineerState {
  return {
    ...state,
    architectReview,
    iterations: {
      ...state.iterations,
      reviewCycles: state.iterations.reviewCycles + 1,
    },
    nextNode: architectReview.decision === "revise" ? "execute" : "finalize",
  };
}

export function appendFailureNote(
  state: ArchitectEngineerState,
  failureNote: ArchitectEngineerFailureNote,
): ArchitectEngineerState {
  return {
    ...state,
    failureNotes: [...state.failureNotes, failureNote],
  };
}

export function withFinalOutcome(
  state: ArchitectEngineerState,
  finalOutcome: ArchitectEngineerFinalOutcome,
): ArchitectEngineerState {
  return {
    ...state,
    finalOutcome,
    nextNode: "finalize",
  };
}

export function createEngineerFailureNote(
  execution: ArchitectEngineerExecutionSnapshot,
  timestamp: string,
): ArchitectEngineerFailureNote {
  const details: string[] = [];
  const lastCheck = execution.checks.at(-1);

  if (lastCheck?.summary !== undefined) {
    details.push(lastCheck.summary);
  }

  return {
    author: "engineer",
    details,
    summary: execution.result.summary,
    timestamp,
  };
}

export function createArchitectFailureNote(
  review: ArchitectReviewOutput,
  timestamp: string,
): ArchitectEngineerFailureNote {
  return {
    author: "architect",
    details: [...(review.nextActions ?? [])],
    summary: review.summary,
    timestamp,
  };
}
