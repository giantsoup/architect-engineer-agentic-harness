import {
  createRunCommitMessage,
  isCommitNeeded,
  type RunGitCommitPhase,
} from "../git/commit.js";
import { createRunBranchName } from "../git/branch.js";
import {
  classifyGitWorkingTree,
  parseGitStatusPorcelain,
  type GitStatusSnapshot,
} from "../git/status.js";
import type { GitStatusEntry } from "../tools/types.js";
import type { RunProcess } from "../sandbox/process-runner.js";
import { runProcessCommand } from "../sandbox/process-runner.js";
import type { LoadedHarnessConfig } from "../types/config.js";
import { appendRunEvent, type RunDossier } from "./run-dossier.js";
import {
  createInitialRunGitMetadata,
  evaluateDirtyWorkingTreePolicy,
  withRunGitCommit,
  withRunGitError,
  withRunGitWarning,
  type RunGitCommitRecord,
  type RuntimeRunGitMetadata,
} from "./run-git-state.js";

const HARNESS_GIT_USER_NAME = "Architect Engineer Harness";
const HARNESS_GIT_USER_EMAIL = "architect-engineer-harness@local";

interface RunGitCommandResult {
  stderr: string;
  stdout: string;
}

export interface PrepareRunGitAutomationOptions {
  dossier: RunDossier;
  loadedConfig: LoadedHarnessConfig;
  now: () => Date;
  runId: string;
  runProcess?: RunProcess;
  task: string;
}

export type PrepareRunGitAutomationResult =
  | { git: RuntimeRunGitMetadata; kind: "blocked"; summary: string }
  | { git: RuntimeRunGitMetadata; kind: "failed"; summary: string }
  | { git: RuntimeRunGitMetadata; kind: "ready" };

export interface CommitRunGitChangesOptions {
  dossier: RunDossier;
  engineerAttempt?: number | undefined;
  git: RuntimeRunGitMetadata;
  loadedConfig: LoadedHarnessConfig;
  now: () => Date;
  phase: RunGitCommitPhase;
  reviewCycle: number;
  runId: string;
  runProcess?: RunProcess;
  task: string;
}

export interface CommitRunGitChangesResult {
  createdCommit?: RunGitCommitRecord | undefined;
  git: RuntimeRunGitMetadata;
  kind: "committed" | "failed" | "skipped";
  summary?: string | undefined;
}

export async function prepareRunGitAutomation(
  options: PrepareRunGitAutomationOptions,
): Promise<PrepareRunGitAutomationResult> {
  let git = createInitialRunGitMetadata();
  const statusTimestamp = options.now().toISOString();
  let status: GitStatusSnapshot;

  try {
    status = await readGitStatus(options.loadedConfig, options.runProcess);
  } catch (error) {
    const message = describeError(error);
    const summary = `Git automation failed while reading repository status: ${message}`;

    git = withRunGitError(git, summary);
    await appendRunEvent(options.dossier.paths, {
      error: message,
      timestamp: statusTimestamp,
      type: "run-git-status-failed",
    });

    return { git, kind: "failed", summary };
  }

  const initialWorkingTree = classifyGitWorkingTree(status.entries);
  const dirtyTreeDecision = evaluateDirtyWorkingTreePolicy(
    initialWorkingTree,
    git.dirtyWorkingTreePolicy,
  );
  const startingCommit = await readGitHeadCommit(
    options.loadedConfig,
    options.runProcess,
  );

  git = {
    ...git,
    dirtyWorkingTreeOutcome: dirtyTreeDecision.outcome,
    initialWorkingTree,
    startingBranch: status.branch.head,
    ...(startingCommit === undefined ? {} : { startingCommit }),
  };

  await appendRunEvent(options.dossier.paths, {
    dirtyWorkingTreePolicy: git.dirtyWorkingTreePolicy,
    dirtyWorkingTreeStatus: initialWorkingTree,
    startingBranch: git.startingBranch,
    startingCommit: git.startingCommit,
    timestamp: statusTimestamp,
    type: "run-git-state-recorded",
  });

  if (!dirtyTreeDecision.shouldProceed) {
    const summary =
      dirtyTreeDecision.summary ??
      "Run stopped before branch creation because the repository started with a dirty working tree.";

    git = withRunGitWarning(git, summary);
    await appendRunEvent(options.dossier.paths, {
      dirtyWorkingTreePolicy: git.dirtyWorkingTreePolicy,
      summary,
      timestamp: statusTimestamp,
      type: "run-git-dirty-working-tree-blocked",
    });

    return { git, kind: "blocked", summary };
  }

  const runBranch = createRunBranchName({
    runId: options.runId,
    task: options.task,
  });

  try {
    await runGitCommand(options.loadedConfig, options.runProcess, [
      "checkout",
      "-b",
      runBranch,
    ]);
  } catch (error) {
    const message = describeError(error);
    const summary = `Git automation failed while creating the run branch \`${runBranch}\`: ${message}`;

    git = withRunGitError(git, summary);
    await appendRunEvent(options.dossier.paths, {
      branch: runBranch,
      error: message,
      timestamp: options.now().toISOString(),
      type: "run-git-branch-create-failed",
    });

    return { git, kind: "failed", summary };
  }

  git = {
    ...git,
    runBranch,
  };
  await appendRunEvent(options.dossier.paths, {
    branch: runBranch,
    startingBranch: git.startingBranch,
    timestamp: options.now().toISOString(),
    type: "run-git-branch-created",
  });

  return { git, kind: "ready" };
}

export async function commitRunGitChanges(
  options: CommitRunGitChangesOptions,
): Promise<CommitRunGitChangesResult> {
  let status: GitStatusSnapshot;

  try {
    status = await readGitStatus(options.loadedConfig, options.runProcess);
  } catch (error) {
    const message = describeError(error);
    const summary = `Git automation failed while preparing a ${options.phase} commit: ${message}`;
    const git = withRunGitError(options.git, summary);

    await appendRunEvent(options.dossier.paths, {
      error: message,
      phase: options.phase,
      timestamp: options.now().toISOString(),
      type: "run-git-commit-status-failed",
    });

    return { git, kind: "failed", summary };
  }

  if (!isCommitNeeded(status.entries)) {
    await appendRunEvent(options.dossier.paths, {
      phase: options.phase,
      reason: "clean-working-tree",
      timestamp: options.now().toISOString(),
      type: "run-git-commit-skipped",
    });

    const finalCommit =
      options.git.finalCommit ??
      (await readGitHeadCommit(options.loadedConfig, options.runProcess));

    return {
      git:
        finalCommit === undefined
          ? options.git
          : {
              ...options.git,
              finalCommit,
            },
      kind: "skipped",
    };
  }

  const commitEligiblePaths = selectCommitEligiblePaths(
    status.entries,
    options.loadedConfig,
  );

  if (commitEligiblePaths.length === 0) {
    await appendRunEvent(options.dossier.paths, {
      phase: options.phase,
      reason: "artifact-only-changes",
      timestamp: options.now().toISOString(),
      type: "run-git-commit-skipped",
    });

    const finalCommit =
      options.git.finalCommit ??
      (await readGitHeadCommit(options.loadedConfig, options.runProcess));

    return {
      git:
        finalCommit === undefined
          ? options.git
          : {
              ...options.git,
              finalCommit,
            },
      kind: "skipped",
    };
  }

  const message = createRunCommitMessage({
    engineerAttempt: options.engineerAttempt,
    phase: options.phase,
    reviewCycle: options.reviewCycle,
    runId: options.runId,
    task: options.task,
  });

  try {
    await runGitCommand(
      options.loadedConfig,
      options.runProcess,
      createGitAddArgs(commitEligiblePaths),
    );
    await runGitCommand(options.loadedConfig, options.runProcess, [
      "-c",
      `user.name=${HARNESS_GIT_USER_NAME}`,
      "-c",
      `user.email=${HARNESS_GIT_USER_EMAIL}`,
      "commit",
      "-m",
      message,
    ]);
  } catch (error) {
    const details = describeError(error);
    const summary = `Git automation failed while creating a ${options.phase} commit: ${details}`;
    const git = withRunGitError(options.git, summary);

    await appendRunEvent(options.dossier.paths, {
      error: details,
      message,
      phase: options.phase,
      timestamp: options.now().toISOString(),
      type: "run-git-commit-failed",
    });

    return { git, kind: "failed", summary };
  }

  const commitHash = await readGitHeadCommit(
    options.loadedConfig,
    options.runProcess,
  );

  if (commitHash === undefined) {
    const summary = `Git automation created a ${options.phase} commit but could not read the new HEAD hash.`;
    const git = withRunGitError(options.git, summary);

    await appendRunEvent(options.dossier.paths, {
      message,
      phase: options.phase,
      timestamp: options.now().toISOString(),
      type: "run-git-commit-hash-missing",
    });

    return { git, kind: "failed", summary };
  }

  const createdCommit: RunGitCommitRecord = {
    commitHash,
    message,
    phase: options.phase,
    recordedAt: options.now().toISOString(),
  };
  const git = withRunGitCommit(options.git, createdCommit);

  await appendRunEvent(options.dossier.paths, {
    commitHash,
    message,
    phase: options.phase,
    timestamp: createdCommit.recordedAt,
    type: "run-git-commit-created",
  });

  return {
    createdCommit,
    git,
    kind: "committed",
  };
}

export function renderRunGitSection(git: RuntimeRunGitMetadata): string[] {
  const lines = [
    "## Git",
    "",
    `- Dirty-tree policy: stop the run before branch creation when the repository already has tracked or untracked changes.`,
    `- Dirty-tree outcome: ${git.dirtyWorkingTreeOutcome ?? "not-recorded"}`,
    `- Starting branch: ${git.startingBranch ?? "unavailable"}`,
    `- Run branch: ${git.runBranch ?? "not created"}`,
    `- Starting commit: ${git.startingCommit ?? "unavailable"}`,
    `- Final commit: ${git.finalCommit ?? "unavailable"}`,
  ];

  if (git.initialWorkingTree !== undefined) {
    lines.push(
      `- Initial working tree clean: ${git.initialWorkingTree.isDirty ? "no" : "yes"}`,
      `- Initial changed paths: ${git.initialWorkingTree.changedPaths.length === 0 ? "none" : git.initialWorkingTree.changedPaths.join(", ")}`,
      `- Initial staged changes: ${git.initialWorkingTree.hasStagedChanges ? "yes" : "no"}`,
      `- Initial unstaged changes: ${git.initialWorkingTree.hasUnstagedChanges ? "yes" : "no"}`,
      `- Initial untracked changes: ${git.initialWorkingTree.hasUntrackedChanges ? "yes" : "no"}`,
    );
  }

  if (git.createdCommits.length > 0) {
    lines.push("", "### Created Commits", "");

    for (const commit of git.createdCommits) {
      lines.push(
        `- ${commit.commitHash} (${commit.phase}): ${commit.message.split("\n", 1)[0] ?? commit.message}`,
      );
    }
  } else {
    lines.push("", "- Created commits: none");
  }

  if (git.warnings.length > 0) {
    lines.push("", "### Git Warnings", "");

    for (const warning of git.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (git.errors.length > 0) {
    lines.push("", "### Git Errors", "");

    for (const error of git.errors) {
      lines.push(`- ${error}`);
    }
  }

  return lines;
}

async function readGitStatus(
  loadedConfig: LoadedHarnessConfig,
  runProcess?: RunProcess,
): Promise<GitStatusSnapshot> {
  const result = await runGitCommand(loadedConfig, runProcess, [
    "status",
    "--porcelain=v1",
    "--branch",
  ]);

  return parseGitStatusPorcelain(result.stdout);
}

async function readGitHeadCommit(
  loadedConfig: LoadedHarnessConfig,
  runProcess?: RunProcess,
): Promise<string | undefined> {
  try {
    const result = await runGitCommand(loadedConfig, runProcess, [
      "rev-parse",
      "--verify",
      "HEAD",
    ]);

    const commitHash = result.stdout.trim();

    return commitHash.length > 0 ? commitHash : undefined;
  } catch {
    return undefined;
  }
}

async function runGitCommand(
  loadedConfig: LoadedHarnessConfig,
  runProcess: RunProcess | undefined,
  args: string[],
): Promise<RunGitCommandResult> {
  const processResult = await (runProcess ?? runProcessCommand)({
    args,
    cwd: loadedConfig.projectRoot,
    file: "git",
  });

  if (processResult.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with exit code ${processResult.exitCode}: ${selectErrorMessage(processResult.stderr, processResult.stdout)}`,
    );
  }

  return {
    stderr: processResult.stderr,
    stdout: processResult.stdout,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function selectErrorMessage(stderr: string, stdout: string): string {
  const trimmedStderr = stderr.trim();

  if (trimmedStderr.length > 0) {
    return trimmedStderr;
  }

  const trimmedStdout = stdout.trim();

  return trimmedStdout.length > 0 ? trimmedStdout : "Unknown git failure.";
}

function createGitAddArgs(paths: readonly string[]): string[] {
  if (paths.length === 0) {
    return ["add", "--all"];
  }

  return ["add", "--all", "--", ...paths];
}

function selectCommitEligiblePaths(
  entries: readonly GitStatusEntry[],
  loadedConfig: LoadedHarnessConfig,
): string[] {
  const artifactRoot = normalizeRelativeDirectory(
    loadedConfig.config.artifacts.rootDir,
  );
  const paths = new Set<string>();

  for (const entry of entries) {
    if (!isPathInsideArtifactRoot(entry.path, artifactRoot)) {
      paths.add(entry.path);
    }

    if (
      entry.originalPath !== undefined &&
      !isPathInsideArtifactRoot(entry.originalPath, artifactRoot)
    ) {
      paths.add(entry.originalPath);
    }
  }

  return [...paths];
}

function isPathInsideArtifactRoot(path: string, artifactRoot: string): boolean {
  if (artifactRoot === "." || artifactRoot.length === 0) {
    return false;
  }

  return path === artifactRoot || path.startsWith(`${artifactRoot}/`);
}

function normalizeRelativeDirectory(value: string): string {
  const normalized = value.replace(/\\/gu, "/").replace(/\/+$/u, "");

  return normalized.length === 0 ? "." : normalized;
}
