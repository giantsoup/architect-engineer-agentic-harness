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
import { createRoleModelClient } from "../models/provider-factory.js";
import { createBuiltInToolExecutor } from "../tools/built-in-tools.js";
import type { BuiltInToolExecutor } from "../tools/built-in-tools.js";
import { createToolRouter, type ToolRouter } from "../tools/tool-router.js";
import type { CreateMcpServerClient } from "../tools/mcp/client.js";
import type {
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
  checksJson?: string | undefined;
  diff?: string | undefined;
  failureNotes?: string | undefined;
  gitStatus?: string | undefined;
  notes: string[];
}

const DEFAULT_ARCHITECT_SCHEMA_OPTIONS: ArchitectControlOutputOptions =
  Object.freeze({});
const MAX_ARCHITECT_TOOL_STEPS = 8;

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
  );
  const finalReport = renderFinalReport(
    finalizedState,
    resolvedFinalOutcome,
    context.loadedConfig,
    workspaceSnapshot,
  );

  if (finalizedState.failureNotes.length > 0) {
    await writeFailureNotes(
      dossier.paths,
      renderFailureNotesMarkdown(finalizedState.failureNotes),
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

  if (finalizedState.failureNotes.length > 0) {
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
        return {
          message: `Architect ${options.kind} failed: ${describeError(error)}`,
          ok: false,
        };
      }

      messages.push({
        content: modelResponse.rawContent,
        role: "assistant",
      });

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

      const toolFeedback = await executeArchitectTool(
        toolRouter,
        action.request,
      );

      messages.push({
        content: JSON.stringify(toolFeedback),
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
    "- Search file contents within a file or directory tree using a literal query.",
    '- Request shape: `{ "toolName": "file.search", "query": "createToolRouter", "path": "src", "limit": 8 }`',
    "",
    "### `file.read_many`",
    "- Read a few likely-relevant small files in one step.",
    '- Request shape: `{ "toolName": "file.read_many", "paths": ["src/example.ts", "test/example.test.ts"] }`',
    "",
    "### `file.list`",
    "- List directory entries.",
    '- Request shape: `{ "toolName": "file.list", "path": "." }`',
    "",
    "### `file.read`",
    "- Read a file from the workspace or artifacts.",
    '- Request shape: `{ "toolName": "file.read", "path": "src/example.ts" }`',
    "",
    "### `command.execute`",
    "- Run one shell command through the configured execution target.",
    '- Request shape: `{ "toolName": "command.execute", "command": "npm test", "accessMode": "inspect" }`',
    "",
    "### `git.status`",
    "- Inspect working tree state.",
    '- Request shape: `{ "toolName": "git.status" }`',
    "",
    "### `git.diff`",
    "- Capture the current patch.",
    '- Request shape: `{ "toolName": "git.diff", "staged": false }`',
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
      lines.push("", `### \`${tool.server}.${tool.name}\``);
      lines.push(`- Server: \`${tool.server}\``);

      if (tool.description !== undefined) {
        lines.push(`- Description: ${tool.description}`);
      }

      lines.push(
        `- Request shape: \`{ "toolName": "mcp.call", "server": "${tool.server}", "name": "${tool.name}", "arguments": {} }\``,
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
    `- Summary: ${execution.result.summary}`,
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

  if (workspaceSnapshot.gitStatus !== undefined) {
    lines.push("", "## Workspace Snapshot", "", workspaceSnapshot.gitStatus);
  }

  lines.push("", "## Resolved Commands", "");
  lines.push(
    ...Object.entries(toResolvedCommandRecord(loadedConfig)).map(
      ([commandName, command]) =>
        `- ${commandName}: ${command === undefined ? "not resolved" : `\`${command}\``}`,
    ),
  );

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
  const acceptanceCriteriaPolicy = resolveAcceptanceCriteriaPolicy({
    architectPlan: state.architectPlan,
    requiredTestCommand: getRequiredCheckCommand(loadedConfig),
    requirePassingChecks:
      loadedConfig.config.stopConditions.requirePassingChecks,
  });
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
