import type { GitWorkingTreeClassification } from "../git/status.js";
import type { RunGitCommitPhase } from "../git/commit.js";
import type { RunGitCommitSummary, RunGitMetadata } from "../types/run.js";

export type DirtyWorkingTreePolicy = "stop";
export type DirtyWorkingTreeOutcome = "clean" | "stopped";

export interface DirtyWorkingTreePolicyDecision {
  outcome: DirtyWorkingTreeOutcome;
  shouldProceed: boolean;
  summary?: string | undefined;
}

export type RunGitCommitRecord = RunGitCommitSummary & {
  phase: RunGitCommitPhase;
};

export type RuntimeRunGitMetadata = RunGitMetadata & {
  dirtyWorkingTreeOutcome?: DirtyWorkingTreeOutcome | undefined;
  dirtyWorkingTreePolicy: DirtyWorkingTreePolicy;
  initialWorkingTree?: GitWorkingTreeClassification | undefined;
};

export function createInitialRunGitMetadata(): RuntimeRunGitMetadata {
  return {
    createdCommits: [],
    dirtyWorkingTreePolicy: "stop",
    errors: [],
    warnings: [],
  };
}

export function evaluateDirtyWorkingTreePolicy(
  initialWorkingTree: GitWorkingTreeClassification,
  policy: DirtyWorkingTreePolicy,
): DirtyWorkingTreePolicyDecision {
  if (policy === "stop" && initialWorkingTree.isDirty) {
    return {
      outcome: "stopped",
      shouldProceed: false,
      summary:
        "Run stopped before branch creation because the repository started with a dirty working tree.",
    };
  }

  return {
    outcome: "clean",
    shouldProceed: true,
  };
}

export function withRunGitCommit(
  git: RuntimeRunGitMetadata,
  commit: RunGitCommitRecord,
): RuntimeRunGitMetadata {
  return {
    ...git,
    createdCommits: [...git.createdCommits, commit],
    finalCommit: commit.commitHash,
  };
}

export function withRunGitWarning(
  git: RuntimeRunGitMetadata,
  warning: string,
): RuntimeRunGitMetadata {
  return {
    ...git,
    warnings: [...git.warnings, warning],
  };
}

export function withRunGitError(
  git: RuntimeRunGitMetadata,
  error: string,
): RuntimeRunGitMetadata {
  return {
    ...git,
    errors: [...git.errors, error],
  };
}
