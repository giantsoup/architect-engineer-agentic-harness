import { readFile } from "node:fs/promises";

import type { LoadedHarnessConfig } from "../types/config.js";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ArchitectPlanOutput,
  ArchitectReviewOutput,
} from "../models/types.js";
import {
  createArchitectStructuredOutputFormat,
  type ArchitectControlOutputOptions,
} from "../models/architect-output.js";
import { createRoleModelClient } from "../models/provider-factory.js";
import {
  createBuiltInToolExecutor,
  type BuiltInToolExecutor,
} from "../tools/built-in-tools.js";
import type { GitStatusToolResult } from "../tools/types.js";
import {
  appendRunEvent,
  appendStructuredMessage,
  initializeRunDossier,
  writeArchitectPlan,
  writeArchitectReview,
  writeFailureNotes,
  writeFinalReport,
  writeRunLifecycleStatus,
  writeRunResult,
  type RunDossier,
} from "./run-dossier.js";
import {
  appendFailureNote,
  createArchitectFailureNote,
  createEngineerFailureNote,
  withArchitectPlan,
  withArchitectReview,
  withEngineerExecution,
  withFinalOutcome,
  withPreparedDossier,
  type ArchitectEngineerFailureNote,
  type ArchitectEngineerFinalOutcome,
  type ArchitectEngineerState,
} from "./architect-engineer-state.js";
import {
  getEngineerStopOutcome,
  getRemainingRunTimeMs,
  getReviewOutcome,
} from "./architect-engineer-guards.js";
import {
  executeEngineerTask,
  type EngineerTaskModelClient,
} from "./engineer-task.js";
import type { ProjectCommandRunnerLike } from "../sandbox/command-runner.js";
import type { RunProcess } from "../sandbox/process-runner.js";

export interface ArchitectRunModelClient {
  chat<TStructured = never>(
    request: ModelChatRequest<TStructured>,
  ): Promise<ModelChatResponse<TStructured>>;
}

export interface ArchitectEngineerNodeContext {
  architectModelClient?: ArchitectRunModelClient;
  engineerModelClient?: EngineerTaskModelClient;
  loadedConfig: LoadedHarnessConfig;
  now: () => Date;
  projectCommandRunner?: ProjectCommandRunnerLike;
  runProcess?: RunProcess;
}

interface ArchitectWorkspaceSnapshot {
  checksJson?: string | undefined;
  diff?: string | undefined;
  failureNotes?: string | undefined;
  gitStatus?: string | undefined;
  notes: string[];
}

const DEFAULT_ARCHITECT_SCHEMA_OPTIONS: ArchitectControlOutputOptions =
  Object.freeze({});

export async function prepareArchitectEngineerRunNode(
  state: ArchitectEngineerState,
  context: ArchitectEngineerNodeContext,
): Promise<ArchitectEngineerState> {
  const dossier = await initializeRunDossier(context.loadedConfig, {
    createdAt: new Date(state.metadata.createdAt),
    runId: state.metadata.runId,
  });
  const timestamp = context.now().toISOString();

  await writeRunLifecycleStatus(dossier.paths, "running", timestamp);
  await appendStructuredMessage(dossier.paths, {
    content: state.metadata.task,
    format: "markdown",
    role: "user",
    timestamp,
  });
  await appendRunEvent(dossier.paths, {
    maxConsecutiveFailedChecks:
      state.stopConditions.maxConsecutiveFailedRequiredChecks,
    requiredCheckCommand: context.loadedConfig.config.commands.test,
    task: state.metadata.task,
    timeoutMs: state.metadata.timeoutMs,
    timestamp,
    type: "architect-engineer-run-started",
  });

  return withPreparedDossier(state, dossier);
}

export async function architectPlanningNode(
  state: ArchitectEngineerState,
  context: ArchitectEngineerNodeContext,
): Promise<ArchitectEngineerState> {
  const dossier = assertDossier(state);
  const remainingTimeMs = getRemainingRunTimeMs(state, context.now());
  const workspaceSnapshot = await captureArchitectWorkspaceSnapshot(
    dossier,
    context,
  );
  const [systemPrompt, planningPrompt, structuredOutput] = await Promise.all([
    loadPromptAsset("prompts/v1/architect/system.md"),
    loadPromptAsset("prompts/v1/architect/planning.md"),
    createArchitectStructuredOutputFormat(
      "plan",
      DEFAULT_ARCHITECT_SCHEMA_OPTIONS,
    ),
  ]);
  const modelClient =
    context.architectModelClient ??
    createRoleModelClient({
      dossierPaths: dossier.paths,
      loadedConfig: withBoundRoleTimeout(
        context.loadedConfig,
        "architect",
        remainingTimeMs,
      ),
      role: "architect",
    });
  const userPrompt = renderPlanningRequest(
    state,
    context.loadedConfig,
    workspaceSnapshot,
  );
  let modelResponse: ModelChatResponse<ArchitectPlanOutput>;

  try {
    modelResponse = await modelClient.chat({
      messages: [
        { content: systemPrompt, role: "system" },
        {
          content: [
            planningPrompt.trim(),
            "",
            "Return strict JSON only, matching the architect plan schema.",
          ].join("\n"),
          role: "developer",
        },
        { content: userPrompt, role: "user" },
      ],
      metadata: {
        phase: "architect-plan",
        remainingTimeMs,
        runId: state.metadata.runId,
      },
      structuredOutput,
    });
  } catch (error) {
    return withFinalOutcome(state, {
      status: "failed",
      stopReason: "architect-model-error",
      summary: `Architect planning failed: ${describeError(error)}`,
    });
  }

  const plan = modelResponse.structuredOutput;

  if (plan === undefined) {
    return withFinalOutcome(state, {
      status: "failed",
      stopReason: "architect-model-error",
      summary: "Architect planning returned no structured output.",
    });
  }

  const timestamp = context.now().toISOString();

  await appendStructuredMessage(dossier.paths, {
    content: modelResponse.rawContent,
    format: "json",
    role: "architect",
    timestamp,
  });
  await writeArchitectPlan(
    dossier.paths,
    renderArchitectPlanMarkdown(plan, timestamp),
    timestamp,
  );
  await appendRunEvent(dossier.paths, {
    steps: plan.steps,
    summary: plan.summary,
    timestamp,
    type: "architect-plan-created",
  });

  return withArchitectPlan(state, plan);
}

export async function engineerExecutionNode(
  state: ArchitectEngineerState,
  context: ArchitectEngineerNodeContext,
): Promise<ArchitectEngineerState> {
  const dossier = assertDossier(state);
  const remainingTimeMs = getRemainingRunTimeMs(state, context.now());
  let execution: Awaited<ReturnType<typeof executeEngineerTask>>;

  try {
    execution = await executeEngineerTask({
      dossier,
      initialChecks: state.checks,
      initialConsecutiveFailedChecks:
        state.stopConditions.consecutiveFailedRequiredChecks,
      loadedConfig: context.loadedConfig,
      maxConsecutiveFailedChecks:
        state.stopConditions.maxConsecutiveFailedRequiredChecks,
      maxIterations: Number.POSITIVE_INFINITY,
      now: context.now,
      persistFinalArtifacts: false,
      task: renderEngineerExecutionTask(state, context.loadedConfig),
      timeoutMs: Math.max(1, remainingTimeMs),
      ...(context.engineerModelClient === undefined
        ? {}
        : { modelClient: context.engineerModelClient }),
      ...(context.projectCommandRunner === undefined
        ? {}
        : { projectCommandRunner: context.projectCommandRunner }),
      ...(context.runProcess === undefined
        ? {}
        : { runProcess: context.runProcess }),
    });
  } catch (error) {
    return withFinalOutcome(state, {
      status: "failed",
      stopReason: "engineer-model-error",
      summary: `Engineer execution failed: ${describeError(error)}`,
    });
  }

  let nextState = withEngineerExecution(state, execution);

  if (execution.result.status !== "success") {
    nextState = appendFailureNote(
      nextState,
      createEngineerFailureNote(
        nextState.engineerExecution!,
        context.now().toISOString(),
      ),
    );
  }

  await syncFailureNotesArtifact(nextState, context.now().toISOString());

  const forcedOutcome = getEngineerStopOutcome(
    execution.stopReason,
    execution.result.summary,
  );

  if (forcedOutcome !== undefined) {
    return withFinalOutcome(nextState, forcedOutcome);
  }

  return nextState;
}

export async function architectReviewNode(
  state: ArchitectEngineerState,
  context: ArchitectEngineerNodeContext,
): Promise<ArchitectEngineerState> {
  const dossier = assertDossier(state);
  const execution = state.engineerExecution;

  if (execution === undefined || state.architectPlan === undefined) {
    return withFinalOutcome(state, {
      status: "failed",
      stopReason: "architect-model-error",
      summary:
        "Architect review was requested before plan and Engineer execution were available.",
    });
  }

  const remainingTimeMs = getRemainingRunTimeMs(state, context.now());
  const workspaceSnapshot = await captureArchitectWorkspaceSnapshot(
    dossier,
    context,
  );
  const [systemPrompt, reviewPrompt, structuredOutput] = await Promise.all([
    loadPromptAsset("prompts/v1/architect/system.md"),
    loadPromptAsset("prompts/v1/architect/review.md"),
    createArchitectStructuredOutputFormat(
      "review",
      DEFAULT_ARCHITECT_SCHEMA_OPTIONS,
    ),
  ]);
  const modelClient =
    context.architectModelClient ??
    createRoleModelClient({
      dossierPaths: dossier.paths,
      loadedConfig: withBoundRoleTimeout(
        context.loadedConfig,
        "architect",
        remainingTimeMs,
      ),
      role: "architect",
    });
  let modelResponse: ModelChatResponse<ArchitectReviewOutput>;

  try {
    modelResponse = await modelClient.chat({
      messages: [
        { content: systemPrompt, role: "system" },
        {
          content: [
            reviewPrompt.trim(),
            "",
            "Return strict JSON only, matching the architect review schema.",
          ].join("\n"),
          role: "developer",
        },
        {
          content: renderReviewRequest(state, workspaceSnapshot),
          role: "user",
        },
      ],
      metadata: {
        engineerAttempts: state.iterations.engineerAttempts,
        phase: "architect-review",
        remainingTimeMs,
        reviewCycles: state.iterations.reviewCycles,
        runId: state.metadata.runId,
      },
      structuredOutput,
    });
  } catch (error) {
    return withFinalOutcome(state, {
      status: "failed",
      stopReason: "architect-model-error",
      summary: `Architect review failed: ${describeError(error)}`,
    });
  }

  const review = modelResponse.structuredOutput;

  if (review === undefined) {
    return withFinalOutcome(state, {
      status: "failed",
      stopReason: "architect-model-error",
      summary: "Architect review returned no structured output.",
    });
  }

  const timestamp = context.now().toISOString();

  await appendStructuredMessage(dossier.paths, {
    content: modelResponse.rawContent,
    format: "json",
    role: "architect",
    timestamp,
  });
  await writeArchitectReview(
    dossier.paths,
    renderArchitectReviewMarkdown(review, timestamp),
    timestamp,
  );
  await appendRunEvent(dossier.paths, {
    decision: review.decision,
    nextActions: review.nextActions,
    summary: review.summary,
    timestamp,
    type: "architect-review-created",
  });

  let nextState = withArchitectReview(state, review);
  const reviewOutcome = getReviewOutcome(review);

  if (review.decision !== "approve") {
    nextState = appendFailureNote(
      nextState,
      createArchitectFailureNote(review, timestamp),
    );
  }

  await syncFailureNotesArtifact(nextState, timestamp);

  if (reviewOutcome !== undefined) {
    return withFinalOutcome(nextState, reviewOutcome);
  }

  await writeRunLifecycleStatus(dossier.paths, "running", timestamp);
  return nextState;
}

export async function finalizeArchitectEngineerRunNode(
  state: ArchitectEngineerState,
  context: ArchitectEngineerNodeContext,
): Promise<ArchitectEngineerState> {
  const dossier = assertDossier(state);
  const finalOutcome = state.finalOutcome ?? {
    status: "stopped",
    stopReason: "timeout",
    summary: `Run timed out after ${state.metadata.timeoutMs}ms.`,
  };
  const timestamp = context.now().toISOString();
  const workspaceSnapshot = await captureArchitectWorkspaceSnapshot(
    dossier,
    context,
  );
  const finalReport = renderFinalReport(state, finalOutcome, workspaceSnapshot);

  if (state.failureNotes.length > 0) {
    await writeFailureNotes(
      dossier.paths,
      renderFailureNotesMarkdown(state.failureNotes),
      timestamp,
    );
  }

  await writeFinalReport(dossier.paths, finalReport, timestamp);

  const resultArtifacts = [
    dossier.paths.files.run.relativePath,
    dossier.paths.files.events.relativePath,
    dossier.paths.files.commandLog.relativePath,
    dossier.paths.files.architectPlan.relativePath,
    dossier.paths.files.engineerTask.relativePath,
    dossier.paths.files.architectReview.relativePath,
    dossier.paths.files.checks.relativePath,
    dossier.paths.files.diff.relativePath,
    dossier.paths.files.finalReport.relativePath,
    dossier.paths.files.result.relativePath,
  ];

  if (state.failureNotes.length > 0) {
    resultArtifacts.push(dossier.paths.files.failureNotes.relativePath);
  }

  await appendRunEvent(dossier.paths, {
    status: finalOutcome.status,
    stopReason: finalOutcome.stopReason,
    summary: finalOutcome.summary,
    timestamp,
    type: "architect-engineer-run-finished",
  });
  await writeRunResult(
    dossier.paths,
    {
      artifacts: resultArtifacts,
      status: finalOutcome.status,
      summary: finalOutcome.summary,
    },
    timestamp,
  );

  return state;
}

export function renderArchitectPlanMarkdown(
  plan: ArchitectPlanOutput,
  timestamp?: string,
): string {
  const lines = ["# Architect Plan"];

  if (timestamp !== undefined) {
    lines.push("", `Recorded: ${timestamp}`);
  }

  lines.push("", "## Summary", "", plan.summary, "", "## Steps", "");

  for (const step of plan.steps) {
    lines.push(`- ${step}`);
  }

  if ((plan.acceptanceCriteria?.length ?? 0) > 0) {
    lines.push("", "## Acceptance Criteria", "");

    for (const criterion of plan.acceptanceCriteria ?? []) {
      lines.push(`- ${criterion}`);
    }
  }

  return lines.join("\n");
}

export function renderArchitectReviewMarkdown(
  review: ArchitectReviewOutput,
  timestamp?: string,
): string {
  const lines = ["# Architect Review"];

  if (timestamp !== undefined) {
    lines.push("", `Recorded: ${timestamp}`);
  }

  lines.push(
    "",
    "## Decision",
    "",
    `- Decision: ${review.decision}`,
    `- Summary: ${review.summary}`,
  );

  if ((review.nextActions?.length ?? 0) > 0) {
    lines.push("", "## Next Actions", "");

    for (const action of review.nextActions ?? []) {
      lines.push(`- ${action}`);
    }
  }

  return lines.join("\n");
}

export function renderFailureNotesMarkdown(
  failureNotes: readonly ArchitectEngineerFailureNote[],
): string {
  const lines = ["# Failure Notes"];

  if (failureNotes.length === 0) {
    lines.push("", "No carried failure notes.");
    return lines.join("\n");
  }

  for (const failureNote of failureNotes) {
    lines.push(
      "",
      `## ${capitalize(failureNote.author)} Note`,
      "",
      `- Recorded: ${failureNote.timestamp}`,
      `- Summary: ${failureNote.summary}`,
    );

    if (failureNote.details.length > 0) {
      lines.push("- Details:");

      for (const detail of failureNote.details) {
        lines.push(`  - ${detail}`);
      }
    }
  }

  return lines.join("\n");
}

function renderPlanningRequest(
  state: ArchitectEngineerState,
  loadedConfig: LoadedHarnessConfig,
  workspaceSnapshot: ArchitectWorkspaceSnapshot,
): string {
  return [
    "# Task",
    "",
    state.metadata.task.trim(),
    "",
    "## Run Constraints",
    "",
    `- Required check command: \`${loadedConfig.config.commands.test}\``,
    `- Global timeout: ${state.metadata.timeoutMs}ms`,
    `- Failed required-check threshold: ${state.stopConditions.maxConsecutiveFailedRequiredChecks}`,
    "",
    "## Workspace Snapshot",
    "",
    workspaceSnapshot.gitStatus ?? "Git status unavailable.",
    ...(workspaceSnapshot.notes.length === 0
      ? []
      : [
          "",
          "## Inspection Notes",
          "",
          ...workspaceSnapshot.notes.map((note) => `- ${note}`),
        ]),
  ].join("\n");
}

function renderReviewRequest(
  state: ArchitectEngineerState,
  workspaceSnapshot: ArchitectWorkspaceSnapshot,
): string {
  const execution = state.engineerExecution!;
  const lines = [
    "# Task",
    "",
    state.metadata.task.trim(),
    "",
    "## Architect Plan",
    "",
    `- Summary: ${state.architectPlan!.summary}`,
    "",
    ...state.architectPlan!.steps.map((step) => `- ${step}`),
  ];

  if ((state.architectPlan!.acceptanceCriteria?.length ?? 0) > 0) {
    lines.push("", "## Acceptance Criteria", "");
    lines.push(
      ...((state.architectPlan!.acceptanceCriteria ?? []).map(
        (criterion) => `- ${criterion}`,
      ) as string[]),
    );
  }

  lines.push(
    "",
    "## Engineer Execution",
    "",
    `- Status: ${execution.result.status}`,
    `- Stop reason: ${execution.stopReason}`,
    `- Summary: ${execution.result.summary}`,
    `- Engineer attempts so far: ${state.iterations.engineerAttempts}`,
    `- Review cycles so far: ${state.iterations.reviewCycles}`,
    `- Consecutive failed required checks: ${execution.consecutiveFailedChecks}`,
  );

  const lastCheck = execution.checks.at(-1);

  if (lastCheck !== undefined) {
    lines.push(
      `- Last required check: ${lastCheck.summary ?? lastCheck.status}`,
    );
  }

  if (workspaceSnapshot.gitStatus !== undefined) {
    lines.push("", "## Workspace Snapshot", "", workspaceSnapshot.gitStatus);
  }

  if (workspaceSnapshot.checksJson !== undefined) {
    lines.push(
      "",
      "## Checks Artifact",
      "",
      "```json",
      workspaceSnapshot.checksJson.trim(),
      "```",
    );
  }

  if (
    workspaceSnapshot.diff !== undefined &&
    workspaceSnapshot.diff.trim().length > 0
  ) {
    lines.push(
      "",
      "## Diff",
      "",
      "```diff",
      workspaceSnapshot.diff.trim(),
      "```",
    );
  }

  if (
    workspaceSnapshot.failureNotes !== undefined &&
    workspaceSnapshot.failureNotes.trim().length > 0
  ) {
    lines.push(
      "",
      "## Failure Notes Carry Forward",
      "",
      workspaceSnapshot.failureNotes.trim(),
    );
  }

  if (workspaceSnapshot.notes.length > 0) {
    lines.push("", "## Inspection Notes", "");

    for (const note of workspaceSnapshot.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
}

function renderEngineerExecutionTask(
  state: ArchitectEngineerState,
  loadedConfig: LoadedHarnessConfig,
): string {
  const lines = [
    "# Objective",
    "",
    state.metadata.task.trim(),
    "",
    "## Architect Plan",
    "",
    `Summary: ${state.architectPlan?.summary ?? "No plan available."}`,
    "",
    ...((state.architectPlan?.steps ?? []).map(
      (step) => `- ${step}`,
    ) as string[]),
  ];

  if ((state.architectPlan?.acceptanceCriteria?.length ?? 0) > 0) {
    lines.push("", "## Acceptance Criteria", "");

    for (const criterion of state.architectPlan?.acceptanceCriteria ?? []) {
      lines.push(`- ${criterion}`);
    }
  }

  lines.push(
    "",
    "## Required Check",
    "",
    `- Command: \`${loadedConfig.config.commands.test}\``,
    `- Passing checks must be recorded before completion: ${loadedConfig.config.stopConditions.requirePassingChecks ? "yes" : "no"}`,
  );

  if (state.architectReview?.decision === "revise") {
    lines.push(
      "",
      "## Latest Architect Review",
      "",
      `- Summary: ${state.architectReview.summary}`,
    );

    for (const action of state.architectReview.nextActions ?? []) {
      lines.push(`- ${action}`);
    }
  }

  if (state.failureNotes.length > 0) {
    lines.push(
      "",
      "## Carry-Forward Failure Notes",
      "",
      renderFailureNotesMarkdown(state.failureNotes),
    );
  }

  return lines.join("\n");
}

function renderFinalReport(
  state: ArchitectEngineerState,
  finalOutcome: ArchitectEngineerFinalOutcome,
  workspaceSnapshot: ArchitectWorkspaceSnapshot,
): string {
  const lines = [
    "# Final Report",
    "",
    "## Outcome",
    "",
    `- Status: ${finalOutcome.status}`,
    `- Stop reason: ${finalOutcome.stopReason}`,
    `- Summary: ${finalOutcome.summary}`,
    `- Run ID: ${state.metadata.runId}`,
    "",
    "## Task",
    "",
    state.metadata.task.trim(),
  ];

  if (state.architectPlan !== undefined) {
    lines.push(
      "",
      "## Architect Plan",
      "",
      `- Summary: ${state.architectPlan.summary}`,
    );
    lines.push(...state.architectPlan.steps.map((step) => `- ${step}`));
  }

  if (state.architectReview !== undefined) {
    lines.push(
      "",
      "## Final Architect Review",
      "",
      `- Decision: ${state.architectReview.decision}`,
      `- Summary: ${state.architectReview.summary}`,
    );

    for (const action of state.architectReview.nextActions ?? []) {
      lines.push(`- ${action}`);
    }
  }

  if (state.engineerExecution !== undefined) {
    lines.push(
      "",
      "## Engineer Execution",
      "",
      `- Attempts: ${state.iterations.engineerAttempts}`,
      `- Total recorded checks: ${state.checks.length}`,
      `- Consecutive failed required checks: ${state.stopConditions.consecutiveFailedRequiredChecks}`,
      `- Latest stop reason: ${state.engineerExecution.stopReason}`,
      `- Latest summary: ${state.engineerExecution.result.summary}`,
    );
  }

  lines.push(
    "",
    "## Artifacts",
    "",
    `- Dossier: ${state.dossier?.paths.runDirRelativePath ?? "unavailable"}`,
    `- Architect plan: ${state.dossier?.paths.files.architectPlan.relativePath ?? "unavailable"}`,
    `- Engineer task: ${state.dossier?.paths.files.engineerTask.relativePath ?? "unavailable"}`,
    `- Architect review: ${state.dossier?.paths.files.architectReview.relativePath ?? "unavailable"}`,
    `- Checks: ${state.dossier?.paths.files.checks.relativePath ?? "unavailable"}`,
    `- Diff: ${state.dossier?.paths.files.diff.relativePath ?? "unavailable"}`,
    `- Failure notes: ${state.failureNotes.length > 0 ? state.dossier?.paths.files.failureNotes.relativePath : "not written"}`,
  );

  if (workspaceSnapshot.gitStatus !== undefined) {
    lines.push("", "## Workspace Snapshot", "", workspaceSnapshot.gitStatus);
  }

  if (workspaceSnapshot.notes.length > 0) {
    lines.push("", "## Notes", "");

    for (const note of workspaceSnapshot.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
}

async function syncFailureNotesArtifact(
  state: ArchitectEngineerState,
  timestamp: string,
): Promise<void> {
  const dossier = state.dossier;

  if (dossier === undefined) {
    return;
  }

  if (state.failureNotes.length === 0) {
    return;
  }

  await writeFailureNotes(
    dossier.paths,
    renderFailureNotesMarkdown(state.failureNotes),
    timestamp,
  );
}

async function captureArchitectWorkspaceSnapshot(
  dossier: RunDossier,
  context: ArchitectEngineerNodeContext,
): Promise<ArchitectWorkspaceSnapshot> {
  const executor = createBuiltInToolExecutor({
    dossierPaths: dossier.paths,
    loadedConfig: context.loadedConfig,
    now: context.now,
    ...(context.projectCommandRunner === undefined
      ? {}
      : { projectCommandRunner: context.projectCommandRunner }),
    ...(context.runProcess === undefined
      ? {}
      : { runProcess: context.runProcess }),
  });
  const notes: string[] = [];

  try {
    const [gitStatus, checksJson, diff, failureNotes] = await Promise.all([
      safelyReadWithArchitect(executor, { toolName: "git.status" }, notes),
      safelyReadWithArchitect(
        executor,
        {
          path: dossier.paths.files.checks.relativePath,
          toolName: "file.read",
        },
        notes,
      ),
      safelyReadWithArchitect(
        executor,
        {
          path: dossier.paths.files.diff.relativePath,
          toolName: "file.read",
        },
        notes,
      ),
      safelyReadWithArchitect(
        executor,
        {
          path: dossier.paths.files.failureNotes.relativePath,
          toolName: "file.read",
        },
        notes,
      ),
    ]);

    return {
      checksJson:
        checksJson?.toolName === "file.read" ? checksJson.content : undefined,
      diff: diff?.toolName === "file.read" ? diff.content : undefined,
      failureNotes:
        failureNotes?.toolName === "file.read"
          ? failureNotes.content
          : undefined,
      gitStatus:
        gitStatus?.toolName === "git.status"
          ? renderGitStatusSummary(gitStatus)
          : undefined,
      notes,
    };
  } finally {
    executor.close();
  }
}

async function safelyReadWithArchitect(
  executor: BuiltInToolExecutor,
  request: { path: string; toolName: "file.read" } | { toolName: "git.status" },
  notes: string[],
) {
  try {
    return await executor.execute({ role: "architect" }, request);
  } catch (error) {
    notes.push(
      `Architect inspection for \`${request.toolName}\` failed: ${describeError(error)}`,
    );
    return undefined;
  }
}

function renderGitStatusSummary(gitStatus: GitStatusToolResult): string {
  const changedPaths = gitStatus.entries.map((entry) => entry.path);

  return [
    `- Branch: ${gitStatus.branch.head}`,
    `- Clean working tree: ${gitStatus.isClean ? "yes" : "no"}`,
    `- Changed paths: ${changedPaths.length === 0 ? "none" : changedPaths.join(", ")}`,
  ].join("\n");
}

function assertDossier(state: ArchitectEngineerState): RunDossier {
  if (state.dossier === undefined) {
    throw new Error("Architect-Engineer run dossier is not initialized.");
  }

  return state.dossier;
}

async function loadPromptAsset(relativePath: string): Promise<string> {
  const candidates = [
    new URL(`../../${relativePath}`, import.meta.url),
    new URL(`../${relativePath}`, import.meta.url),
  ];

  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch (error) {
      const maybeNodeError = error as NodeJS.ErrnoException;

      if (maybeNodeError.code === "ENOENT") {
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    `Could not load prompt asset ${relativePath}. Looked for: ${candidates.map((candidate) => candidate.pathname).join(", ")}`,
  );
}

function withBoundRoleTimeout(
  loadedConfig: LoadedHarnessConfig,
  role: "architect" | "engineer",
  timeoutMs: number,
): LoadedHarnessConfig {
  const roleConfig =
    role === "architect"
      ? loadedConfig.config.models.architect
      : loadedConfig.config.models.engineer;

  return {
    ...loadedConfig,
    config: {
      ...loadedConfig.config,
      models: {
        ...loadedConfig.config.models,
        [role]: {
          ...roleConfig,
          timeoutMs:
            roleConfig.timeoutMs === undefined
              ? timeoutMs
              : Math.min(roleConfig.timeoutMs, timeoutMs),
        },
      },
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
