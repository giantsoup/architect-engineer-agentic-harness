import { readFile } from "node:fs/promises";

import { getResolvedProjectCommand } from "../adapters/detect-project.js";
import type { LoadedHarnessConfig } from "../types/config.js";
import type {
  ModelChatMessage,
  ModelChatRequest,
  ModelChatResponse,
  ArchitectPlanAction,
  ArchitectReviewAction,
  ArchitectPlanOutput,
  ArchitectReviewOutput,
  ArchitectToolAction,
} from "../models/types.js";
import {
  createArchitectStructuredOutputFormat,
  type ArchitectControlOutputOptions,
} from "../models/architect-output.js";
import { ModelClientError } from "../models/openai-compatible-client.js";
import { createRoleModelClient } from "../models/provider-factory.js";
import { createBuiltInToolExecutor } from "../tools/built-in-tools.js";
import type { BuiltInToolExecutor } from "../tools/built-in-tools.js";
import { createToolRouter, type ToolRouter } from "../tools/tool-router.js";
import type { CreateMcpServerClient } from "../tools/mcp/client.js";
import type {
  FileListToolResult,
  FileReadToolResult,
  FileSearchToolResult,
  GitStatusToolResult,
  ToolCatalog,
  ToolExecutionSummary,
  ToolRequest,
  ToolResult,
} from "../tools/types.js";
import { BuiltInToolError, McpToolError } from "../tools/errors.js";
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
  withRunGitMetadata,
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
  type EngineerTaskStopReason,
} from "./engineer-task.js";
import {
  renderAcceptanceCriteriaLines,
  resolveAcceptanceCriteriaPolicy,
} from "./acceptance-criteria.js";
import type { ProjectCommandRunnerLike } from "../sandbox/command-runner.js";
import type { RunProcess } from "../sandbox/process-runner.js";
import {
  commitRunGitChanges,
  prepareRunGitAutomation,
  renderRunGitSection,
} from "./run-git-automation.js";

export interface ArchitectRunModelClient {
  chat<TStructured = never>(
    request: ModelChatRequest<TStructured>,
  ): Promise<ModelChatResponse<TStructured>>;
}

export interface ArchitectEngineerNodeContext {
  architectModelClient?: ArchitectRunModelClient;
  engineerModelClient?: EngineerTaskModelClient;
  loadedConfig: LoadedHarnessConfig;
  mcpClientFactory?: CreateMcpServerClient;
  now: () => Date;
  projectCommandRunner?: ProjectCommandRunnerLike;
  runProcess?: RunProcess;
}

interface ArchitectWorkspaceSnapshot {
  gitStatus?: string | undefined;
  notes: string[];
}

const MAX_ARCHITECT_SNAPSHOT_ROOT_ENTRIES = 6;
const MAX_ARCHITECT_SNAPSHOT_SEARCH_TERMS = 2;
const MAX_ARCHITECT_SNAPSHOT_SEARCH_RESULTS = 4;

const DEFAULT_ARCHITECT_SCHEMA_OPTIONS: ArchitectControlOutputOptions =
  Object.freeze({});
const MAX_ARCHITECT_VISIBLE_COMMAND_OUTPUT_CHARS = 2000;
const MAX_ARCHITECT_VISIBLE_DIFF_CHARS = 3000;
const MAX_ARCHITECT_VISIBLE_FILE_READ_CHARS = 2500;
const MAX_ARCHITECT_VISIBLE_MCP_TEXT_CHARS = 2000;
const MAX_ARCHITECT_TOOL_STEPS = 8;
const MAX_ARCHITECT_OUTPUT_REPAIRS = 2;

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
    projectAdapter: context.loadedConfig.resolvedProject.adapter,
    resolvedCommands: toResolvedCommandRecord(context.loadedConfig),
    requiredCheckCommand: getRequiredCheckCommand(context.loadedConfig),
    task: state.metadata.task,
    timeoutMs: state.metadata.timeoutMs,
    timestamp,
    type: "architect-engineer-run-started",
  });

  const preparedState = withPreparedDossier(state, dossier);
  const gitPreparation = await prepareRunGitAutomation({
    dossier,
    loadedConfig: context.loadedConfig,
    now: context.now,
    runId: state.metadata.runId,
    ...(context.runProcess === undefined
      ? {}
      : { runProcess: context.runProcess }),
    task: state.metadata.task,
  });
  const preparedWithGit = withRunGitMetadata(preparedState, gitPreparation.git);

  if (gitPreparation.kind === "blocked") {
    return withFinalOutcome(preparedWithGit, {
      status: "stopped",
      stopReason: "dirty-working-tree",
      summary: gitPreparation.summary,
    });
  }

  if (gitPreparation.kind === "failed") {
    return withFinalOutcome(preparedWithGit, {
      status: "failed",
      stopReason: "git-automation-error",
      summary: gitPreparation.summary,
    });
  }

  return preparedWithGit;
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
    state.metadata.task,
  );
  const [systemPrompt, planningPrompt] = await Promise.all([
    loadPromptAsset("prompts/v1/architect/system.md"),
    loadPromptAsset("prompts/v1/architect/planning.md"),
  ]);
  const architectLoop = await runArchitectLoop({
    context,
    developerPrompt: planningPrompt.trim(),
    dossier,
    kind: "plan",
    remainingTimeMs,
    state,
    systemPrompt,
    userPrompt: renderPlanningRequest(
      state,
      context.loadedConfig,
      workspaceSnapshot,
    ),
  });

  if (architectLoop.ok === false) {
    return withFinalOutcome(state, {
      status: "failed",
      stopReason: "architect-model-error",
      summary: architectLoop.message,
    });
  }

  const timestamp = context.now().toISOString();

  await appendStructuredMessage(dossier.paths, {
    content: architectLoop.rawContent,
    format: "json",
    role: "architect",
    timestamp,
  });
  await writeArchitectPlan(
    dossier.paths,
    renderArchitectPlanMarkdown(architectLoop.output, timestamp),
    timestamp,
  );
  await appendRunEvent(dossier.paths, {
    steps: architectLoop.output.steps,
    summary: architectLoop.output.summary,
    toolSummary: architectLoop.toolSummary,
    timestamp,
    type: "architect-plan-created",
  });

  return withArchitectPlan(state, architectLoop.output);
}

export async function engineerExecutionNode(
  state: ArchitectEngineerState,
  context: ArchitectEngineerNodeContext,
): Promise<ArchitectEngineerState> {
  const dossier = assertDossier(state);
  const remainingTimeMs = getRemainingRunTimeMs(state, context.now());
  const workspaceSnapshot = await captureArchitectWorkspaceSnapshot(
    dossier,
    context,
    state.metadata.task,
  );
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
      maxIterations: context.loadedConfig.config.stopConditions.maxIterations,
      now: context.now,
      persistFinalArtifacts: false,
      task: renderEngineerExecutionTask(
        state,
        context.loadedConfig,
        workspaceSnapshot,
      ),
      taskFormat: "brief",
      timeoutMs: Math.max(1, remainingTimeMs),
      ...(context.engineerModelClient === undefined
        ? {}
        : { modelClient: context.engineerModelClient }),
      ...(context.mcpClientFactory === undefined
        ? {}
        : { mcpClientFactory: context.mcpClientFactory }),
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

  if (execution.result.status === "success") {
    const commitResult = await commitRunGitChanges({
      dossier,
      engineerAttempt: nextState.iterations.engineerAttempts,
      git: nextState.git,
      loadedConfig: context.loadedConfig,
      now: context.now,
      phase: "engineer-milestone",
      reviewCycle: nextState.iterations.reviewCycles,
      runId: nextState.metadata.runId,
      ...(context.runProcess === undefined
        ? {}
        : { runProcess: context.runProcess }),
      task: nextState.metadata.task,
    });

    nextState = withRunGitMetadata(nextState, commitResult.git);

    if (commitResult.kind === "failed") {
      return withFinalOutcome(nextState, {
        status: "failed",
        stopReason: "git-automation-error",
        summary: commitResult.summary ?? "Git automation failed.",
      });
    }
  }

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
    state.metadata.task,
  );
  const [systemPrompt, reviewPrompt] = await Promise.all([
    loadPromptAsset("prompts/v1/architect/system.md"),
    loadPromptAsset("prompts/v1/architect/review.md"),
  ]);
  const architectLoop = await runArchitectLoop({
    context,
    developerPrompt: reviewPrompt.trim(),
    dossier,
    kind: "review",
    remainingTimeMs,
    state,
    systemPrompt,
    userPrompt: renderReviewRequest(
      state,
      context.loadedConfig,
      workspaceSnapshot,
    ),
  });

  if (architectLoop.ok === false) {
    return withFinalOutcome(state, {
      status: "failed",
      stopReason: "architect-model-error",
      summary: architectLoop.message,
    });
  }

  const timestamp = context.now().toISOString();

  await appendStructuredMessage(dossier.paths, {
    content: architectLoop.rawContent,
    format: "json",
    role: "architect",
    timestamp,
  });
  await writeArchitectReview(
    dossier.paths,
    renderArchitectReviewMarkdown(architectLoop.output, timestamp),
    timestamp,
  );
  await appendRunEvent(dossier.paths, {
    decision: architectLoop.output.decision,
    nextActions: architectLoop.output.nextActions,
    summary: architectLoop.output.summary,
    toolSummary: architectLoop.toolSummary,
    timestamp,
    type: "architect-review-created",
  });

  let nextState = withArchitectReview(state, architectLoop.output);
  const reviewOutcome = getReviewOutcome(architectLoop.output);

  if (architectLoop.output.decision !== "approve") {
    nextState = appendFailureNote(
      nextState,
      createArchitectFailureNote(architectLoop.output, timestamp),
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
  let finalizedState = state;
  let resolvedFinalOutcome = finalOutcome;

  if (resolvedFinalOutcome.status === "success") {
    const finalCommitResult = await commitRunGitChanges({
      dossier,
      engineerAttempt: finalizedState.iterations.engineerAttempts,
      git: finalizedState.git,
      loadedConfig: context.loadedConfig,
      now: context.now,
      phase: "final-state",
      reviewCycle: finalizedState.iterations.reviewCycles,
      runId: finalizedState.metadata.runId,
      ...(context.runProcess === undefined
        ? {}
        : { runProcess: context.runProcess }),
      task: finalizedState.metadata.task,
    });

    finalizedState = withRunGitMetadata(finalizedState, finalCommitResult.git);

    if (finalCommitResult.kind === "failed") {
      resolvedFinalOutcome = {
        status: "failed",
        stopReason: "git-automation-error",
        summary:
          finalCommitResult.summary ??
          "Git automation failed during finalization.",
      };
      finalizedState = withFinalOutcome(finalizedState, resolvedFinalOutcome);
    }
  }

  const workspaceSnapshot = await captureArchitectWorkspaceSnapshot(
    dossier,
    context,
    finalizedState.metadata.task,
  );
  const finalReport = renderFinalReport(
    finalizedState,
    resolvedFinalOutcome,
    context.loadedConfig,
    workspaceSnapshot,
  );
  const shouldPublishFailureNotes =
    resolvedFinalOutcome.status !== "success" &&
    finalizedState.failureNotes.length > 0;

  if (shouldPublishFailureNotes) {
    await writeFailureNotes(
      dossier.paths,
      renderFailureNotesMarkdown(finalizedState.failureNotes),
      timestamp,
    );
  } else if (
    resolvedFinalOutcome.status === "success" &&
    finalizedState.failureNotes.length > 0
  ) {
    await writeFailureNotes(dossier.paths, "", timestamp);
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

  if (shouldPublishFailureNotes) {
    resultArtifacts.push(dossier.paths.files.failureNotes.relativePath);
  }

  await appendRunEvent(dossier.paths, {
    ...(finalizedState.engineerExecution?.result.convergence === undefined
      ? {}
      : { convergence: finalizedState.engineerExecution.result.convergence }),
    git: finalizedState.git,
    status: resolvedFinalOutcome.status,
    stopReason: resolvedFinalOutcome.stopReason,
    summary: resolvedFinalOutcome.summary,
    timestamp,
    type: "architect-engineer-run-finished",
  });
  await writeRunResult(
    dossier.paths,
    {
      artifacts: resultArtifacts,
      ...(finalizedState.engineerExecution?.result.convergence === undefined
        ? {}
        : { convergence: finalizedState.engineerExecution.result.convergence }),
      git: finalizedState.git,
      status: resolvedFinalOutcome.status,
      summary: resolvedFinalOutcome.summary,
    },
    timestamp,
  );

  return finalizedState;
}

async function runArchitectLoop<TKind extends "plan" | "review">(options: {
  context: ArchitectEngineerNodeContext;
  developerPrompt: string;
  dossier: RunDossier;
  kind: TKind;
  remainingTimeMs: number;
  state: ArchitectEngineerState;
  systemPrompt: string;
  userPrompt: string;
}): Promise<
  | {
      ok: false;
      message: string;
    }
  | {
      ok: true;
      output: TKind extends "plan"
        ? ArchitectPlanOutput
        : ArchitectReviewOutput;
      rawContent: string;
      toolSummary: ToolExecutionSummary;
    }
> {
  const toolRouter = createToolRouter({
    dossierPaths: options.dossier.paths,
    loadedConfig: options.context.loadedConfig,
    ...(options.context.mcpClientFactory === undefined
      ? {}
      : { mcpClientFactory: options.context.mcpClientFactory }),
    now: options.context.now,
    ...(options.context.projectCommandRunner === undefined
      ? {}
      : { projectCommandRunner: options.context.projectCommandRunner }),
    ...(options.context.runProcess === undefined
      ? {}
      : { runProcess: options.context.runProcess }),
  });

  try {
    const toolCatalog = await toolRouter.prepare();
    const structuredOutput = await createArchitectStructuredOutputFormat(
      options.kind,
      DEFAULT_ARCHITECT_SCHEMA_OPTIONS,
    );
    const modelClient =
      options.context.architectModelClient ??
      createRoleModelClient({
        dossierPaths: options.dossier.paths,
        loadedConfig: withBoundRoleTimeout(
          options.context.loadedConfig,
          "architect",
          options.remainingTimeMs,
        ),
        role: "architect",
      });
    const messages: ModelChatMessage[] = [
      { content: options.systemPrompt, role: "system" as const },
      {
        content: [
          options.developerPrompt,
          "",
          renderArchitectToolProtocol(options.kind, toolCatalog),
        ].join("\n"),
        role: "developer" as const,
      },
      { content: options.userPrompt, role: "user" as const },
    ];
    let repairAttempts = 0;

    for (
      let iteration = 1;
      iteration <= MAX_ARCHITECT_TOOL_STEPS;
      iteration += 1
    ) {
      let modelResponse: ModelChatResponse<
        ArchitectPlanAction | ArchitectReviewAction | ArchitectToolAction
      >;

      try {
        modelResponse = await modelClient.chat({
          messages,
          metadata: {
            architectToolIteration: iteration,
            engineerAttempts: options.state.iterations.engineerAttempts,
            phase:
              options.kind === "plan" ? "architect-plan" : "architect-review",
            remainingTimeMs: options.remainingTimeMs,
            reviewCycles: options.state.iterations.reviewCycles,
            runId: options.state.metadata.runId,
          },
          structuredOutput,
        });
      } catch (error) {
        const repairGuidance = createArchitectRepairGuidance(
          options.kind,
          error,
        );

        if (
          repairGuidance !== undefined &&
          repairAttempts < MAX_ARCHITECT_OUTPUT_REPAIRS
        ) {
          repairAttempts += 1;
          messages.push({
            content: repairGuidance,
            role: "developer",
          });
          await appendStructuredMessage(options.dossier.paths, {
            content: repairGuidance,
            role: "system",
            timestamp: options.context.now().toISOString(),
          });
          continue;
        }

        return {
          message: `Architect ${options.kind} failed: ${describeError(error)}`,
          ok: false,
        };
      }

      repairAttempts = 0;

      const action = modelResponse.structuredOutput;

      if (action === undefined) {
        return {
          message: `Architect ${options.kind} returned no structured output.`,
          ok: false,
        };
      }

      const actionType = action.type ?? options.kind;

      await appendRunEvent(options.dossier.paths, {
        actionType,
        iteration,
        phase: options.kind === "plan" ? "architect-plan" : "architect-review",
        ...(action.type === "tool"
          ? { toolRequest: summarizeToolRequestForEvent(action.request) }
          : {}),
        summary: action.summary,
        timestamp: options.context.now().toISOString(),
        type: "architect-action-selected",
      });

      if (action.type !== "tool") {
        return {
          ok: true,
          output: stripArchitectActionType(action) as TKind extends "plan"
            ? ArchitectPlanOutput
            : ArchitectReviewOutput,
          rawContent: modelResponse.rawContent,
          toolSummary: toolRouter.getExecutionSummary(),
        };
      }

      messages.push({
        content: renderArchitectAssistantMessage(action),
        role: "assistant",
      });

      const toolFeedback = await executeArchitectTool(
        toolRouter,
        action.request,
      );

      messages.push({
        content: renderArchitectToolFeedbackForModel(toolFeedback),
        name: action.request.toolName,
        role: "tool",
      });
    }

    return {
      message: `Architect ${options.kind} exceeded the configured tool-step limit of ${MAX_ARCHITECT_TOOL_STEPS}.`,
      ok: false,
    };
  } finally {
    await toolRouter.close();
  }
}

async function executeArchitectTool(
  toolRouter: ToolRouter,
  request: ToolRequest,
): Promise<
  | {
      ok: false;
      toolName: string;
      error: { code: string; message: string; name: string };
    }
  | { ok: true; toolName: string; result: ToolResult }
> {
  try {
    const result = await toolRouter.execute({ role: "architect" }, request);

    return {
      ok: true,
      result,
      toolName: request.toolName,
    };
  } catch (error) {
    if (error instanceof BuiltInToolError || error instanceof McpToolError) {
      return {
        error: {
          code: error.code,
          message: error.message,
          name: error.name,
        },
        ok: false,
        toolName: request.toolName,
      };
    }

    throw error;
  }
}

function createArchitectRepairGuidance(
  kind: "plan" | "review",
  error: unknown,
): string | undefined {
  if (!(error instanceof ModelClientError)) {
    return undefined;
  }

  if (error.classification !== "invalid-structured-output") {
    return undefined;
  }

  const issueDetails =
    error.issues === undefined || error.issues.length === 0
      ? `The previous Architect ${kind} response did not match the required JSON output.`
      : `The previous Architect ${kind} response did not match the required JSON output: ${error.issues.join("; ")}`;
  const finalExample =
    kind === "plan"
      ? '{"type":"plan","summary":"...","steps":["..."],"acceptanceCriteria":["..."]}'
      : '{"type":"review","decision":"approve|revise|fail","summary":"...","nextActions":["..."]}';

  return [
    issueDetails,
    "Return exactly one JSON object and nothing else.",
    "Do not include markdown fences, prose, or multiple JSON objects.",
    "Do not combine a tool action and a final decision in the same response.",
    'If you need one more tool, return `{"type":"tool","summary":"...","request":{...}}`.',
    `If you are ready to finish, return \`${finalExample}\`.`,
    'For `command.execute`, `accessMode` must be exactly `"inspect"` or `"mutate"`.',
  ].join(" ");
}

function summarizeToolRequestForEvent(
  request: ToolRequest,
): Record<string, string> {
  switch (request.toolName) {
    case "command.execute":
      return {
        command: request.command,
        toolName: request.toolName,
      };
    case "file.search":
      return {
        path: request.path ?? ".",
        query: request.query,
        toolName: request.toolName,
      };
    case "file.list":
      return {
        path: request.path ?? ".",
        toolName: request.toolName,
      };
    case "file.read_many":
      return {
        paths: request.paths.join(", "),
        toolName: request.toolName,
      };
    case "file.read":
    case "file.write":
      return {
        path: request.path,
        toolName: request.toolName,
      };
    case "git.diff":
    case "git.status":
      return {
        toolName: request.toolName,
      };
    case "mcp.call":
      return {
        name: request.name,
        server: request.server,
        toolName: request.toolName,
      };
  }
}

function stripArchitectActionType(
  action: ArchitectPlanAction | ArchitectReviewAction,
): ArchitectPlanOutput | ArchitectReviewOutput {
  const { type, ...rest } = action;

  void type;
  return rest;
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

function renderArchitectToolProtocol(
  kind: "plan" | "review",
  toolCatalog: ToolCatalog,
): string {
  const finalType = kind === "plan" ? "plan" : "review";
  const lines = [
    "Return exactly one JSON action per turn.",
    "",
    "Rules:",
    `- Use \`type: "tool"\` to request exactly one built-in tool or \`mcp.call\`.`,
    `- Use \`type: "${finalType}"\` only when you are ready to deliver the final ${kind}.`,
    "- Do not combine a tool action and a final decision in the same response.",
    "- Prefer finishing without tools when the current evidence already proves the outcome.",
    "- If you need inspection, request one narrow tool instead of broad exploration.",
    "- Built-in tool restrictions still apply to the Architect role.",
    "- MCP servers are additive and controlled by the project allowlist.",
    "",
    "## Available Built-in Tools",
    "",
    renderArchitectBuiltInToolsMarkdown(),
    "",
    "## Available MCP Tools",
    "",
    renderArchitectMcpToolsMarkdown(toolCatalog),
  ];

  return lines.join("\n");
}

function renderArchitectBuiltInToolsMarkdown(): string {
  return [
    "### `file.search`",
    "- Search text. Required: `query`. Optional: `path`, `limit`.",
    "",
    "### `file.read_many`",
    "- Read a small batch. Required: `paths`.",
    "",
    "### `file.list`",
    "- List directory entries. Optional: `path`.",
    "",
    "### `file.read`",
    "- Read one file. Required: `path`.",
    "",
    "### `command.execute`",
    "- Run one command. Required: `command`. Optional: `accessMode`, `workingDirectory`, `timeoutMs`, `environment`.",
    "",
    "### `git.status`",
    "- Inspect working tree state. No arguments.",
    "",
    "### `git.diff`",
    "- Read the current patch. Optional: `staged`.",
  ].join("\n");
}

function renderArchitectMcpToolsMarkdown(toolCatalog: ToolCatalog): string {
  const lines = [
    `- Configured servers: ${formatList(toolCatalog.mcpServers.configured)}`,
    `- Allowlisted and available servers: ${formatList(toolCatalog.mcpServers.available)}`,
  ];

  if (toolCatalog.mcpTools.length === 0) {
    lines.push("- Allowlisted MCP tools available now: none");
  } else {
    for (const tool of toolCatalog.mcpTools) {
      lines.push(
        `- \`${tool.server}.${tool.name}\`${tool.description === undefined ? "" : `: ${tool.description}`}. Use \`mcp.call\` with \`server\`, \`name\`, and optional \`arguments\`.`,
      );
    }
  }

  if (toolCatalog.mcpServers.unavailable.length > 0) {
    lines.push("", "### Diagnostics");

    for (const diagnostic of toolCatalog.mcpServers.unavailable) {
      lines.push(`- ${diagnostic.message}`);
    }
  }

  return lines.join("\n");
}

function renderPlanningRequest(
  state: ArchitectEngineerState,
  loadedConfig: LoadedHarnessConfig,
  workspaceSnapshot: ArchitectWorkspaceSnapshot,
): string {
  const requiredCheckCommand = getRequiredCheckCommand(loadedConfig);

  return [
    "# Task",
    "",
    state.metadata.task.trim(),
    "",
    "## Run Constraints",
    "",
    `- Project adapter: ${formatProjectAdapter(loadedConfig.resolvedProject.adapter)}`,
    `- Required check command: \`${requiredCheckCommand}\``,
    `- Global timeout: ${state.metadata.timeoutMs}ms`,
    `- Failed required-check threshold: ${state.stopConditions.maxConsecutiveFailedRequiredChecks}`,
    "",
    "## Resolved Commands",
    "",
    ...Object.entries(toResolvedCommandRecord(loadedConfig)).map(
      ([commandName, command]) =>
        `- ${commandName}: ${command === undefined ? "not resolved" : `\`${command}\``}`,
    ),
    "",
    "## Planning Guardrails",
    "",
    "- Base concrete file paths, directory names, and commands only on verified workspace hints or tool outputs.",
    "- If a file path is not verified, do not guess it as if it exists. Request one narrow inspection tool instead.",
    "",
    "## Workspace Snapshot",
    "",
    workspaceSnapshot.gitStatus ?? "Git status unavailable.",
    ...(workspaceSnapshot.notes.length === 0
      ? []
      : [
          "",
          "## Verified Workspace Hints",
          "",
          ...workspaceSnapshot.notes.map((note) => `- ${note}`),
        ]),
  ].join("\n");
}

function renderReviewRequest(
  state: ArchitectEngineerState,
  loadedConfig: LoadedHarnessConfig,
  workspaceSnapshot: ArchitectWorkspaceSnapshot,
): string {
  const execution = state.engineerExecution!;
  const acceptanceCriteriaPolicy = resolveAcceptanceCriteriaPolicy({
    architectPlan: state.architectPlan,
    requiredTestCommand: getRequiredCheckCommand(loadedConfig),
    requirePassingChecks:
      loadedConfig.config.stopConditions.requirePassingChecks,
  });
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

  lines.push("", "## Acceptance Criteria", "");
  lines.push(...renderAcceptanceCriteriaLines(acceptanceCriteriaPolicy));

  lines.push(
    "",
    "## Engineer Execution",
    "",
    `- Status: ${execution.result.status}`,
    `- Stop reason: ${execution.stopReason}`,
    `- Summary: ${toSingleLineSummary(execution.result.summary)}`,
    `- Engineer attempts so far: ${state.iterations.engineerAttempts}`,
    `- Review cycles so far: ${state.iterations.reviewCycles}`,
    `- Consecutive failed required checks: ${execution.consecutiveFailedChecks}`,
    `- Project adapter: ${formatProjectAdapter(loadedConfig.resolvedProject.adapter)}`,
  );

  const lastCheck = execution.checks.at(-1);

  if (lastCheck !== undefined) {
    lines.push(
      `- Last required check: ${lastCheck.summary ?? lastCheck.status}`,
    );
  }

  const passingCheckCount = execution.checks.filter(
    (check) => check.status === "passed",
  ).length;
  const failedCheckCount = execution.checks.filter(
    (check) => check.status === "failed",
  ).length;

  lines.push(
    `- Required check history: ${passingCheckCount} passed, ${failedCheckCount} failed`,
  );
  lines.push(
    "- Historical failed checks earlier in the run do not by themselves block approval if the latest required check passes and the current workspace satisfies the acceptance criteria.",
  );

  if (execution.checks.length > 0) {
    lines.push("", "## Recent Required Checks", "");

    for (const check of execution.checks.slice(-3)) {
      lines.push(
        `- ${check.status}${check.exitCode === undefined ? "" : ` (exit ${check.exitCode})`}: ${check.command}`,
      );
    }
  }

  if (workspaceSnapshot.gitStatus !== undefined) {
    lines.push("", "## Workspace Snapshot", "", workspaceSnapshot.gitStatus);
  }

  lines.push(
    "",
    "## Command Context",
    "",
    `- Required check command: \`${getRequiredCheckCommand(loadedConfig)}\``,
  );

  const resolvedCommands = Object.entries(toResolvedCommandRecord(loadedConfig))
    .filter(([, command]) => command !== undefined)
    .slice(0, 4);

  for (const [commandName, command] of resolvedCommands) {
    lines.push(`- ${commandName}: \`${command}\``);
  }

  if (state.failureNotes.length > 0) {
    lines.push(
      "",
      "## Carry-Forward Failure Notes",
      "",
      ...renderArchitectFailureNoteSummary(state.failureNotes),
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
  workspaceSnapshot: ArchitectWorkspaceSnapshot,
): string {
  const acceptanceCriteriaPolicy = resolveAcceptanceCriteriaPolicy({
    architectPlan: state.architectPlan,
    requiredTestCommand: getRequiredCheckCommand(loadedConfig),
    requirePassingChecks:
      loadedConfig.config.stopConditions.requirePassingChecks,
  });
  const lines = [
    "## Objective",
    "",
    state.metadata.task.trim(),
    "",
    "## Architect Execution Order",
    "",
    "1. Follow the Architect plan literally.",
    "2. If a latest Architect review exists, treat its next actions as the highest priority.",
    "3. Prefer the smallest confirming step that can satisfy the current review.",
    "4. Avoid restarting broad exploration unless the current review explicitly requires it.",
    "5. Return `COMPLETE:` as soon as the acceptance criteria and required check are satisfied.",
    "",
    "## Architect Plan",
    "",
    `Summary: ${state.architectPlan?.summary ?? "No plan available."}`,
    "",
    ...((state.architectPlan?.steps ?? []).map(
      (step) => `- ${step}`,
    ) as string[]),
  ];

  lines.push("", "## Acceptance Criteria", "");
  lines.push(...renderAcceptanceCriteriaLines(acceptanceCriteriaPolicy));

  lines.push(
    "",
    "## Required Check",
    "",
    `- Command: \`${getRequiredCheckCommand(loadedConfig)}\``,
    `- Passing checks must be recorded before completion: ${loadedConfig.config.stopConditions.requirePassingChecks ? "yes" : "no"}`,
    "",
    "## Project Adapter",
    "",
    `- Adapter: ${formatProjectAdapter(loadedConfig.resolvedProject.adapter)}`,
    ...Object.entries(toResolvedCommandRecord(loadedConfig)).map(
      ([commandName, command]) =>
        `- ${commandName}: ${command === undefined ? "not resolved" : `\`${command}\``}`,
    ),
  );

  if (workspaceSnapshot.notes.length > 0) {
    lines.push("", "## Verified Workspace Hints", "");

    for (const note of workspaceSnapshot.notes) {
      lines.push(`- ${note}`);
    }
  }

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

  if (state.engineerExecution !== undefined) {
    const lastCheck = state.engineerExecution.checks.at(-1);
    const passingCheckCount = state.engineerExecution.checks.filter(
      (check) => check.status === "passed",
    ).length;
    const failedCheckCount = state.engineerExecution.checks.filter(
      (check) => check.status === "failed",
    ).length;

    lines.push(
      "",
      "## Current Run State",
      "",
      `- Previous Engineer status: ${state.engineerExecution.result.status}`,
      `- Previous Engineer summary: ${toSingleLineSummary(state.engineerExecution.result.summary)}`,
      `- Recorded required checks: ${state.engineerExecution.checks.length}`,
      `- Required check history: ${passingCheckCount} passed, ${failedCheckCount} failed`,
      `- Latest required check: ${lastCheck === undefined ? "none recorded" : (lastCheck.summary ?? lastCheck.status)}`,
    );

    if (
      state.architectReview?.decision === "revise" &&
      lastCheck?.status === "passed"
    ) {
      lines.push(
        "- The latest required check already passed.",
        "- If the task is already satisfied, avoid broad re-exploration. Prefer the smallest confirming step requested by the Architect, or reply `COMPLETE:` if no further work is needed.",
      );
    }
  }

  if (state.failureNotes.length > 0) {
    lines.push(
      "",
      "## Relevant Carry-Forward Notes",
      "",
      ...renderEngineerCarryForwardNotes(state.failureNotes),
    );
  }

  return lines.join("\n");
}

function renderEngineerCarryForwardNotes(
  failureNotes: readonly ArchitectEngineerFailureNote[],
): string[] {
  const relevantNotes = failureNotes.slice(-2);
  const lines: string[] = [];

  for (const failureNote of relevantNotes) {
    lines.push(
      `- ${capitalize(failureNote.author)}: ${failureNote.summary}`,
      ...failureNote.details
        .slice(0, 2)
        .map(
          (detail) => `- ${capitalize(failureNote.author)} detail: ${detail}`,
        ),
    );
  }

  if (failureNotes.length > relevantNotes.length) {
    lines.push(
      `- Older carry-forward notes omitted: ${failureNotes.length - relevantNotes.length}`,
    );
  }

  return lines;
}

function renderFinalReport(
  state: ArchitectEngineerState,
  finalOutcome: ArchitectEngineerFinalOutcome,
  loadedConfig: LoadedHarnessConfig,
  workspaceSnapshot: ArchitectWorkspaceSnapshot,
): string {
  const shouldPublishFailureNotes =
    finalOutcome.status !== "success" && state.failureNotes.length > 0;
  const completionPathSummary =
    state.engineerExecution === undefined
      ? undefined
      : renderEngineerCompletionPathSummary(
          finalOutcome,
          state.engineerExecution.stopReason,
        );
  const acceptanceCriteriaPolicy = resolveAcceptanceCriteriaPolicy({
    architectPlan: state.architectPlan,
    requiredTestCommand: getRequiredCheckCommand(loadedConfig),
    requirePassingChecks:
      loadedConfig.config.stopConditions.requirePassingChecks,
  });
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

  if (completionPathSummary !== undefined) {
    lines.splice(8, 0, `- Completion path: ${completionPathSummary}`);
  }

  if (state.architectPlan !== undefined) {
    lines.push(
      "",
      "## Architect Plan",
      "",
      `- Summary: ${state.architectPlan.summary}`,
    );
    lines.push(...state.architectPlan.steps.map((step) => `- ${step}`));
    lines.push("", "## Acceptance Criteria", "");
    lines.push(...renderAcceptanceCriteriaLines(acceptanceCriteriaPolicy));
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
      `- Built-in calls recorded: ${state.engineerExecution.toolSummary.builtInCallCount}`,
      `- MCP calls recorded: ${state.engineerExecution.toolSummary.mcpCallCount}`,
      `- MCP available servers: ${
        state.engineerExecution.toolSummary.mcpServers.available.length === 0
          ? "none"
          : state.engineerExecution.toolSummary.mcpServers.available.join(", ")
      }`,
    );

    if (state.engineerExecution.toolSummary.mcpServers.unavailable.length > 0) {
      lines.push("", "## MCP Diagnostics", "");

      for (const diagnostic of state.engineerExecution.toolSummary.mcpServers
        .unavailable) {
        lines.push(`- ${diagnostic.message}`);
      }
    }
  }

  lines.push(
    "",
    "## Project Adapter",
    "",
    `- Adapter: ${formatProjectAdapter(loadedConfig.resolvedProject.adapter)}`,
    ...Object.entries(toResolvedCommandRecord(loadedConfig)).map(
      ([commandName, command]) =>
        `- ${commandName}: ${command === undefined ? "not resolved" : `\`${command}\``}`,
    ),
  );

  lines.push("", ...renderRunGitSection(state.git));

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
    `- Failure notes: ${shouldPublishFailureNotes ? state.dossier?.paths.files.failureNotes.relativePath : "not written"}`,
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

function renderEngineerCompletionPathSummary(
  finalOutcome: ArchitectEngineerFinalOutcome,
  engineerStopReason: EngineerTaskStopReason,
): string | undefined {
  if (finalOutcome.stopReason !== "architect-approved") {
    return undefined;
  }

  return isCleanEngineerCompletionStopReason(engineerStopReason)
    ? "Architect approved after clean Engineer completion."
    : `Architect approval masked an Engineer completion-path anomaly (\`${engineerStopReason}\`).`;
}

function isCleanEngineerCompletionStopReason(
  stopReason: EngineerTaskStopReason,
): boolean {
  return stopReason === "engineer-complete" || stopReason === "passing-checks";
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
  task: string,
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
    const gitStatus = await safelyReadWithArchitect(
      executor,
      { toolName: "git.status" },
      notes,
    );
    const rootList = await safelyReadWithArchitect(
      executor,
      { path: ".", toolName: "file.list" },
      notes,
    );

    if (rootList?.toolName === "file.list") {
      notes.push(summarizeArchitectRootEntries(rootList));

      const packageJsonEntry = rootList.entries.find(
        (entry) => entry.kind === "file" && entry.path === "package.json",
      );

      if (packageJsonEntry !== undefined) {
        const packageJson = await safelyReadWithArchitect(
          executor,
          { path: packageJsonEntry.path, toolName: "file.read" },
          notes,
        );

        if (packageJson?.toolName === "file.read") {
          notes.push(summarizeArchitectPackageJson(packageJson));
        }
      }
    }

    for (const searchTerm of extractArchitectSearchTerms(task)) {
      const searchResult = await safelyReadWithArchitect(
        executor,
        {
          limit: MAX_ARCHITECT_SNAPSHOT_SEARCH_RESULTS,
          path: ".",
          query: searchTerm,
          toolName: "file.search",
        },
        notes,
      );

      if (searchResult?.toolName === "file.search") {
        const summary = summarizeArchitectSearchResult(searchResult);

        if (summary !== undefined) {
          notes.push(summary);
        }
      }
    }

    return {
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
  request:
    | { path: string; toolName: "file.read" }
    | { path: string; toolName: "file.list" }
    | { limit: number; path: string; query: string; toolName: "file.search" }
    | { toolName: "git.status" },
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

function summarizeArchitectRootEntries(result: FileListToolResult): string {
  const visibleEntries = result.entries
    .filter(
      (entry) =>
        !entry.path.startsWith(".agent-harness") &&
        !entry.path.startsWith(".git"),
    )
    .slice(0, MAX_ARCHITECT_SNAPSHOT_ROOT_ENTRIES)
    .map((entry) => `\`${entry.path}\``);

  if (visibleEntries.length === 0) {
    return "Verified repo root entries: none visible.";
  }

  return `Verified repo root entries: ${visibleEntries.join(", ")}.`;
}

function summarizeArchitectPackageJson(result: FileReadToolResult): string {
  try {
    const parsed = JSON.parse(result.content) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    const notes: string[] = [];

    if (typeof parsed.name === "string" && parsed.name.trim().length > 0) {
      notes.push(`package name \`${parsed.name}\``);
    }

    const scriptNames = Object.keys(parsed.scripts ?? {}).slice(0, 6);

    if (scriptNames.length > 0) {
      notes.push(
        `scripts ${scriptNames
          .map((scriptName) => `\`${scriptName}\``)
          .join(", ")}`,
      );
    }

    if (notes.length > 0) {
      return `Verified \`package.json\`: ${notes.join("; ")}.`;
    }
  } catch {
    // Ignore parse failures and fall through to the generic note.
  }

  return "Verified `package.json` exists.";
}

function extractArchitectSearchTerms(task: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const normalized = value.trim();

    if (normalized.length < 3 || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    terms.push(normalized);
  };

  for (const match of task.matchAll(/`([^`\n]{3,})`/gu)) {
    push(match[1] ?? "");
  }

  for (const match of task.matchAll(
    /\b[A-Za-z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*\b/gu,
  )) {
    push(match[0] ?? "");
  }

  return terms.slice(0, MAX_ARCHITECT_SNAPSHOT_SEARCH_TERMS);
}

function summarizeArchitectSearchResult(
  result: FileSearchToolResult,
): string | undefined {
  if (result.results.length === 0) {
    return undefined;
  }

  const paths = result.results
    .slice(0, MAX_ARCHITECT_SNAPSHOT_SEARCH_RESULTS)
    .map((entry) => `\`${entry.path}\``);

  return `Verified search hits for \`${result.query}\`: ${paths.join(", ")}.`;
}

function renderArchitectAssistantMessage(action: ArchitectToolAction): string {
  return renderArchitectToolHistoryLine(action.request);
}

function renderArchitectToolHistoryLine(request: ToolRequest): string {
  switch (request.toolName) {
    case "command.execute":
      return `Requested \`command.execute\` with \`${request.command}\`.`;
    case "file.list":
      return `Requested \`file.list\` on \`${request.path ?? "."}\`.`;
    case "file.read":
      return `Requested \`file.read\` on \`${request.path}\`.`;
    case "file.read_many":
      return `Requested \`file.read_many\` on ${request.paths.length} file${
        request.paths.length === 1 ? "" : "s"
      }.`;
    case "file.search":
      return `Requested \`file.search\` for \`${request.query}\` in \`${request.path ?? "."}\`.`;
    case "file.write":
      return `Requested \`file.write\` on \`${request.path}\`.`;
    case "git.diff":
      return `Requested \`git.diff\`${request.staged === true ? " (staged)" : ""}.`;
    case "git.status":
      return "Requested `git.status`.";
    case "mcp.call":
      return `Requested \`mcp.call\` for \`${request.server}.${request.name}\`.`;
    default:
      return "Requested one tool step.";
  }
}

function renderArchitectToolFeedbackForModel(
  feedback:
    | {
        ok: false;
        toolName: string;
        error: { code: string; message: string; name: string };
      }
    | { ok: true; toolName: string; result: ToolResult },
): string {
  if (feedback.ok === false) {
    return JSON.stringify({
      error: feedback.error,
      ok: false,
      toolName: feedback.toolName,
    });
  }

  switch (feedback.result.toolName) {
    case "command.execute":
      return JSON.stringify({
        ok: true,
        result: {
          command: feedback.result.command,
          durationMs: feedback.result.durationMs,
          exitCode: feedback.result.exitCode,
          stderr: truncateArchitectText(
            feedback.result.stderr,
            MAX_ARCHITECT_VISIBLE_COMMAND_OUTPUT_CHARS,
          ),
          stdout: truncateArchitectText(
            feedback.result.stdout,
            MAX_ARCHITECT_VISIBLE_COMMAND_OUTPUT_CHARS,
          ),
          summary:
            feedback.result.exitCode === 0
              ? "Command completed successfully."
              : `Command failed with exit code ${feedback.result.exitCode}.`,
          toolName: feedback.result.toolName,
        },
        toolName: feedback.toolName,
      });
    case "file.read":
      return JSON.stringify({
        ok: true,
        result: {
          byteLength: feedback.result.byteLength,
          content: truncateArchitectText(
            feedback.result.content,
            MAX_ARCHITECT_VISIBLE_FILE_READ_CHARS,
          ),
          path: feedback.result.path,
          toolName: feedback.result.toolName,
        },
        toolName: feedback.toolName,
      });
    case "file.read_many":
      return JSON.stringify({
        ok: true,
        result: {
          files: feedback.result.files.map((file) => ({
            byteLength: file.byteLength,
            content: truncateArchitectText(
              file.content,
              MAX_ARCHITECT_VISIBLE_FILE_READ_CHARS,
            ),
            path: file.path,
            truncatedCharCount: file.truncatedCharCount,
          })),
          hiddenPathCount: feedback.result.hiddenPathCount,
          requestedPathCount: feedback.result.requestedPathCount,
          toolName: feedback.result.toolName,
        },
        toolName: feedback.toolName,
      });
    case "file.list":
      return JSON.stringify({
        ok: true,
        result: {
          entries: feedback.result.entries.slice(0, 16),
          path: feedback.result.path,
          toolName: feedback.result.toolName,
        },
        toolName: feedback.toolName,
      });
    case "file.search":
      return JSON.stringify({
        ok: true,
        result: {
          path: feedback.result.path,
          query: feedback.result.query,
          results: feedback.result.results.slice(0, 8),
          searchedFileCount: feedback.result.searchedFileCount,
          skippedFileCount: feedback.result.skippedFileCount,
          toolName: feedback.result.toolName,
        },
        toolName: feedback.toolName,
      });
    case "git.status":
      return JSON.stringify({
        ok: true,
        result: {
          branch: feedback.result.branch,
          entries: feedback.result.entries.slice(0, 16),
          isClean: feedback.result.isClean,
          toolName: feedback.result.toolName,
        },
        toolName: feedback.toolName,
      });
    case "git.diff":
      return JSON.stringify({
        ok: true,
        result: {
          byteLength: feedback.result.byteLength,
          diff: truncateArchitectText(
            feedback.result.diff,
            MAX_ARCHITECT_VISIBLE_DIFF_CHARS,
          ),
          isEmpty: feedback.result.isEmpty,
          staged: feedback.result.staged,
          toolName: feedback.result.toolName,
        },
        toolName: feedback.toolName,
      });
    case "mcp.call":
      return JSON.stringify({
        ok: true,
        result: {
          content: feedback.result.content.map((entry) =>
            entry.type === "text"
              ? {
                  text: truncateArchitectText(
                    entry.text,
                    MAX_ARCHITECT_VISIBLE_MCP_TEXT_CHARS,
                  ),
                  type: entry.type,
                }
              : entry,
          ),
          isError: feedback.result.isError,
          name: feedback.result.name,
          server: feedback.result.server,
          structuredContent: feedback.result.structuredContent,
          toolName: feedback.result.toolName,
        },
        toolName: feedback.toolName,
      });
    default:
      return JSON.stringify(feedback);
  }
}

function truncateArchitectText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return [
    value.slice(0, maxChars),
    "",
    `[truncated ${value.length - maxChars} additional characters]`,
  ].join("\n");
}

function renderArchitectFailureNoteSummary(
  failureNotes: readonly ArchitectEngineerFailureNote[],
): string[] {
  const lines: string[] = [];

  for (const failureNote of failureNotes.slice(-2)) {
    lines.push(`- ${capitalize(failureNote.author)}: ${failureNote.summary}`);
  }

  if (failureNotes.length > 2) {
    lines.push(`- Older failure notes omitted: ${failureNotes.length - 2}`);
  }

  return lines;
}

function toSingleLineSummary(value: string, maxChars = 280): string {
  const normalized = value.replace(/\s+/gu, " ").trim();

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars - 1)}...`;
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

function getRequiredCheckCommand(loadedConfig: LoadedHarnessConfig): string {
  const requiredCheckCommand = getResolvedProjectCommand(
    loadedConfig.resolvedProject,
    "test",
  );

  if (requiredCheckCommand === undefined) {
    throw new Error("No required test command was resolved for this project.");
  }

  return requiredCheckCommand;
}

function toResolvedCommandRecord(
  loadedConfig: LoadedHarnessConfig,
): Record<string, string | undefined> {
  return {
    install: loadedConfig.resolvedProject.commands.install.command,
    lint: loadedConfig.resolvedProject.commands.lint.command,
    test: loadedConfig.resolvedProject.commands.test.command,
    typecheck: loadedConfig.resolvedProject.commands.typecheck.command,
  };
}

function formatProjectAdapter(
  adapter: LoadedHarnessConfig["resolvedProject"]["adapter"],
): string {
  return adapter.id === "unknown"
    ? "Unknown"
    : `${adapter.label} (${adapter.markers.join(", ")})`;
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
