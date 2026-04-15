import { readFile } from "node:fs/promises";

import { getResolvedProjectCommand } from "../adapters/detect-project.js";
import type { LoadedHarnessConfig } from "../types/config.js";
import type {
  RunCheckResult,
  RunConvergenceMetrics,
  RunResult,
} from "../types/run.js";
import type {
  ModelChatMessage,
  ModelChatRequest,
  ModelChatResponse,
} from "../models/types.js";
import {
  createEngineerToolDefinitions,
  EngineerTurnValidationError,
  resolveEngineerTurn,
  type EngineerTurn,
} from "../models/engineer-output.js";
import { createRoleModelClient } from "../models/provider-factory.js";
import {
  ModelClientError,
  ModelStructuredOutputError,
} from "../models/openai-compatible-client.js";
import { createToolRouter, type ToolRouter } from "../tools/tool-router.js";
import type { CreateMcpServerClient } from "../tools/mcp/client.js";
import type {
  ToolCatalog,
  ToolExecutionSummary,
  ToolRequest,
  ToolResult,
} from "../tools/types.js";
import { BuiltInToolError, McpToolError } from "../tools/errors.js";
import type { ProjectCommandRunnerLike } from "../sandbox/command-runner.js";
import type { RunProcess } from "../sandbox/process-runner.js";
import { DEFAULT_PROMPT_VERSION } from "../versioning.js";
import {
  appendRunEvent,
  appendStructuredMessage,
  initializeRunDossier,
  writeChecks,
  writeDiff,
  writeEngineerTask,
  writeFailureNotes,
  writeFinalReport,
  writeRunLifecycleStatus,
  writeRunResult,
  type RunDossier,
} from "./run-dossier.js";

const DEFAULT_RUN_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_MODEL_VISIBLE_FILE_READ_CHARS = 4000;
const MAX_MODEL_VISIBLE_COMMAND_OUTPUT_CHARS = 3000;
const MAX_MODEL_VISIBLE_FILE_LIST_ENTRIES = 12;
const EXPLORATION_BUDGET_STEPS = 12;
const MAX_CONSECUTIVE_RETRYABLE_MODEL_ERRORS = 3;
const LOW_VALUE_EXPLORATION_PATH_SEGMENTS = new Set([
  ".agent-harness",
  ".git",
  "dist",
  "node_modules",
]);

export type EngineerTaskStopReason =
  | "blocked"
  | "completion-path-failed"
  | "engineer-complete"
  | "max-consecutive-failed-checks"
  | "max-iterations"
  | "model-error"
  | "passing-checks"
  | "timeout";

export interface EngineerTaskModelClient {
  chat<TStructured = never>(
    request: ModelChatRequest<TStructured>,
  ): Promise<ModelChatResponse<TStructured>>;
}

export interface ExecuteEngineerTaskOptions {
  createdAt?: Date;
  dossier?: RunDossier;
  initialChecks?: readonly RunCheckResult[];
  initialConsecutiveFailedChecks?: number;
  loadedConfig: LoadedHarnessConfig;
  maxConsecutiveFailedChecks?: number;
  maxIterations?: number;
  mcpClientFactory?: CreateMcpServerClient;
  modelClient?: EngineerTaskModelClient;
  now?: () => Date;
  persistFinalArtifacts?: boolean;
  projectCommandRunner?: ProjectCommandRunnerLike;
  runId?: string;
  runProcess?: RunProcess;
  task: string;
  taskFormat?: "brief" | "objective";
  timeoutMs?: number;
}

export interface EngineerTaskExecution {
  checks: RunCheckResult[];
  consecutiveFailedChecks: number;
  dossier: RunDossier;
  failureNotes?: string | undefined;
  iterationCount: number;
  result: RunResult;
  stopReason: EngineerTaskStopReason;
  toolSummary: ToolExecutionSummary;
}

interface FinalizedOutcome {
  blockedNotes?: string[] | undefined;
  status: RunResult["status"];
  stopReason: EngineerTaskStopReason;
  summary: string;
}

interface WorkspaceArtifactCollection {
  diff: Extract<ToolResult, { toolName: "git.diff" }> | undefined;
  notes: string[];
  status: Extract<ToolResult, { toolName: "git.status" }> | undefined;
}

interface RepoFact {
  key: string;
  paths: string[];
  summary: string;
}

type ToolFeedback =
  | {
      ok: false;
      toolName: string;
      error: { code: string; message: string; name: string };
    }
  | { ok: true; toolName: string; result: ToolResult };

interface PostToolGuidance {
  content: string;
  usedRepoMemory: boolean;
}

interface PostPassCompletionGateState {
  active: boolean;
  completionOnly: boolean;
}

type EngineerConvergenceGuardReason =
  | "exploration-budget"
  | "post-pass-no-progress"
  | "post-pass-completion-gate"
  | "required-check-without-progress";

interface NoOpWriteFact {
  path: string;
  signature: string;
}

export async function executeEngineerTask(
  options: ExecuteEngineerTaskOptions,
): Promise<EngineerTaskExecution> {
  const now = options.now ?? (() => new Date());
  const dossier =
    options.dossier ??
    (await initializeRunDossier(options.loadedConfig, {
      ...(options.createdAt === undefined
        ? {}
        : { createdAt: options.createdAt }),
      ...(options.runId === undefined ? {} : { runId: options.runId }),
    }));
  const requiredCheckCommand = getRequiredCheckCommand(options.loadedConfig);
  const requirePassingChecks =
    options.loadedConfig.config.stopConditions.requirePassingChecks;
  const maxIterations =
    options.maxIterations ??
    options.loadedConfig.config.stopConditions.maxIterations;
  const maxConsecutiveFailedChecks =
    options.maxConsecutiveFailedChecks ??
    options.loadedConfig.config.stopConditions.maxEngineerAttempts;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const startedAt = now();
  const deadlineMs = startedAt.getTime() + timeoutMs;
  const toolExecutor =
    options.projectCommandRunner === undefined
      ? createToolRouter({
          dossierPaths: dossier.paths,
          loadedConfig: options.loadedConfig,
          ...(options.mcpClientFactory === undefined
            ? {}
            : { mcpClientFactory: options.mcpClientFactory }),
          now,
          ...(options.runProcess === undefined
            ? {}
            : { runProcess: options.runProcess }),
        })
      : createToolRouter({
          dossierPaths: dossier.paths,
          loadedConfig: options.loadedConfig,
          ...(options.mcpClientFactory === undefined
            ? {}
            : { mcpClientFactory: options.mcpClientFactory }),
          now,
          projectCommandRunner: options.projectCommandRunner,
          ...(options.runProcess === undefined
            ? {}
            : { runProcess: options.runProcess }),
        });

  try {
    const toolCatalog = await toolExecutor.prepare();
    const taskBrief = renderEngineerTaskBrief({
      loadedConfig: options.loadedConfig,
      maxConsecutiveFailedChecks,
      maxIterations,
      task: options.task,
      taskFormat: options.taskFormat ?? "objective",
      timeoutMs,
      toolCatalog,
    });
    const initialTimestamp = startedAt.toISOString();

    await writeRunLifecycleStatus(dossier.paths, "running", initialTimestamp);
    await writeEngineerTask(dossier.paths, taskBrief, initialTimestamp);
    await appendStructuredMessage(dossier.paths, {
      content: taskBrief,
      format: "markdown",
      role: "user",
      timestamp: initialTimestamp,
    });
    await appendRunEvent(dossier.paths, {
      explorationBudget: EXPLORATION_BUDGET_STEPS,
      maxConsecutiveFailedChecks,
      maxIterations,
      projectAdapter: options.loadedConfig.resolvedProject.adapter,
      resolvedCommands: toResolvedCommandRecord(options.loadedConfig),
      requiredCheckCommand,
      requirePassingChecks,
      toolCatalog: {
        builtInTools: toolCatalog.builtInTools,
        mcpServers: toolCatalog.mcpServers,
        mcpTools: toolCatalog.mcpTools,
      },
      timeoutMs,
      timestamp: initialTimestamp,
      type: "engineer-run-started",
    });

    const [systemPrompt, executePrompt] = await Promise.all([
      loadPromptAsset(`prompts/${DEFAULT_PROMPT_VERSION}/engineer/system.md`),
      loadPromptAsset(`prompts/${DEFAULT_PROMPT_VERSION}/engineer/execute.md`),
    ]);
    const engineerTools = createEngineerToolDefinitions();

    const messages: ModelChatMessage[] = [
      {
        content: systemPrompt,
        role: "system",
      },
      {
        content: [
          executePrompt.trim(),
          "",
          `Exploration budget before you must edit, run \`${requiredCheckCommand}\`, or declare blocked: ${EXPLORATION_BUDGET_STEPS} consecutive exploration steps.`,
          "",
          renderEngineerProtocol({
            explorationBudget: EXPLORATION_BUDGET_STEPS,
            maxConsecutiveFailedChecks,
            maxIterations,
            requiredCheckCommand,
            requirePassingChecks,
            timeoutMs,
          }),
        ].join("\n"),
        role: "developer",
      },
      {
        content: taskBrief,
        role: "user",
      },
    ];
    const checks: RunCheckResult[] = [...(options.initialChecks ?? [])];
    let consecutiveFailedChecks = options.initialConsecutiveFailedChecks ?? 0;
    let consecutiveExplorationSteps = 0;
    let consecutiveRetryableModelErrors = 0;
    let actionStepCount = 0;
    let explorationBudgetExhaustedAtStep: number | null = null;
    let iterationCount = 0;
    const recentRepoFacts: RepoFact[] = [];
    let repoMemoryFeedbackCount = 0;
    let stepsToFirstCheck: number | null = null;
    let stepsToFirstEdit: number | null = null;
    let editSinceLastFailedCheck = false;
    let groundingSinceLastFailedCheck = false;
    let lastNoOpWrite: NoOpWriteFact | undefined;
    let outcome: FinalizedOutcome | undefined;
    const postPassCompletionGate: PostPassCompletionGateState = {
      active: requirePassingChecks && checks.at(-1)?.status === "passed",
      completionOnly: false,
    };

    while (iterationCount < maxIterations) {
      const iterationTimestamp = now().toISOString();
      const remainingTimeMs = deadlineMs - now().getTime();

      if (remainingTimeMs <= 0) {
        outcome = {
          status: "stopped",
          stopReason: "timeout",
          summary: `Run timed out after ${timeoutMs}ms before the next Engineer step.`,
        };
        break;
      }

      iterationCount += 1;
      await appendRunEvent(dossier.paths, {
        iteration: iterationCount,
        remainingTimeMs,
        timestamp: iterationTimestamp,
        type: "engineer-iteration-started",
      });

      const modelClient =
        options.modelClient ??
        createRoleModelClient({
          dossierPaths: dossier.paths,
          loadedConfig: withEngineerTimeout(
            options.loadedConfig,
            Math.max(1, remainingTimeMs),
          ),
          role: "engineer",
        });

      let modelResponse: ModelChatResponse;
      let action: EngineerTurn;
      const completionOnlyTurn =
        postPassCompletionGate.active && postPassCompletionGate.completionOnly;

      try {
        modelResponse = await modelClient.chat({
          messages,
          metadata: {
            iteration: iterationCount,
            requiredCheckCommand,
            runId: dossier.paths.runId,
          },
          ...(completionOnlyTurn
            ? {}
            : {
                toolFallbackInstruction:
                  createEngineerToolFallbackInstruction(requiredCheckCommand),
                tools: engineerTools,
              }),
        });
        action = completionOnlyTurn
          ? resolveEngineerCompletionOnlyTurn({
              rawContent: modelResponse.rawContent,
              toolCalls: modelResponse.toolCalls,
            })
          : await resolveEngineerTurn({
              rawContent: modelResponse.rawContent,
              toolCalls: modelResponse.toolCalls,
            });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const modelError =
          error instanceof EngineerTurnValidationError
            ? new ModelStructuredOutputError(
                "Engineer response did not follow the required tool-call/final protocol.",
                {
                  issues: error.issues,
                  retryable: true,
                  schemaName: "engineer_turn",
                },
              )
            : error instanceof ModelClientError
              ? error
              : undefined;

        if (completionOnlyTurn && modelError?.retryable === true) {
          outcome = {
            status: "failed",
            stopReason: "completion-path-failed",
            summary: `Engineer failed to complete from the green-check completion path: ${message}`,
          };
          break;
        }

        if (
          modelError?.retryable === true &&
          consecutiveRetryableModelErrors <
            MAX_CONSECUTIVE_RETRYABLE_MODEL_ERRORS
        ) {
          consecutiveRetryableModelErrors += 1;
          const reminder = createRetryableModelErrorGuidance({
            error: modelError,
            recentRepoFacts,
            requiredCheckCommand,
          });

          messages.push({
            content: reminder,
            role: "user",
          });
          await appendStructuredMessage(dossier.paths, {
            content: reminder,
            role: "system",
            timestamp: now().toISOString(),
          });
          continue;
        }

        outcome = {
          status: "failed",
          stopReason: "model-error",
          summary: `Engineer model request failed: ${message}`,
        };
        break;
      }

      consecutiveRetryableModelErrors = 0;

      messages.push({
        content: renderEngineerAssistantMessage(
          action,
          modelResponse.rawContent,
        ),
        role: "assistant",
      });

      actionStepCount += 1;

      await appendRunEvent(dossier.paths, {
        actionType: action.type,
        actionStep: actionStepCount,
        iteration: iterationCount,
        ...(action.type === "tool"
          ? { toolRequest: summarizeToolRequestForEvent(action.request) }
          : { outcome: action.outcome }),
        summary: action.summary,
        timestamp: now().toISOString(),
        type: "engineer-action-selected",
      });

      if (action.type === "final") {
        if (action.outcome === "blocked") {
          outcome = {
            blockedNotes: action.blockers,
            status: "failed",
            stopReason: "blocked",
            summary: action.summary,
          };
          break;
        }

        if (requirePassingChecks && !postPassCompletionGate.active) {
          const reminder = [
            `Required check \`${requiredCheckCommand}\` is not currently green for the latest workspace state.`,
            "Run it through `command.execute` before replying with `COMPLETE:`.",
          ].join(" ");

          messages.push({
            content: reminder,
            role: "user",
          });
          await appendStructuredMessage(dossier.paths, {
            content: reminder,
            role: "system",
            timestamp: now().toISOString(),
          });
          continue;
        }

        outcome = {
          status: "success",
          stopReason: "engineer-complete",
          summary: action.summary,
        };
        break;
      }

      const usedGreenCheckFollowUpStep =
        postPassCompletionGate.active && !postPassCompletionGate.completionOnly;
      const toolRequest = applyRemainingTimeToToolRequest(
        action.request,
        remainingTimeMs,
      );

      if (
        stepsToFirstCheck === null &&
        isRequiredCheckCommand(toolRequest, requiredCheckCommand)
      ) {
        stepsToFirstCheck = actionStepCount;
      }

      let toolFeedback: ToolFeedback;
      let convergenceGuardReason: EngineerConvergenceGuardReason | undefined;

      if (
        isRequiredCheckCommand(toolRequest, requiredCheckCommand) &&
        consecutiveFailedChecks > 0 &&
        !editSinceLastFailedCheck &&
        !groundingSinceLastFailedCheck
      ) {
        convergenceGuardReason = "required-check-without-progress";
        toolFeedback = createRepeatedRequiredCheckFeedback({
          recentRepoFacts,
          requiredCheckCommand,
        });
        if (recentRepoFacts.length > 0) {
          repoMemoryFeedbackCount += 1;
        }
        await appendRunEvent(dossier.paths, {
          actionStep: actionStepCount,
          reason: "required-check-without-progress",
          recentRepoFacts: recentRepoFacts
            .slice(-4)
            .map((fact) => fact.summary),
          timestamp: now().toISOString(),
          toolRequest: summarizeToolRequestForEvent(toolRequest),
          type: "engineer-convergence-guard-triggered",
        });
      } else if (
        isExplorationToolRequest(toolRequest) &&
        consecutiveExplorationSteps >= EXPLORATION_BUDGET_STEPS
      ) {
        convergenceGuardReason = "exploration-budget";
        explorationBudgetExhaustedAtStep ??= actionStepCount;
        toolFeedback = createExplorationBudgetFeedback({
          recentRepoFacts,
          request: toolRequest,
        });
        if (recentRepoFacts.length > 0) {
          repoMemoryFeedbackCount += 1;
        }
        await appendRunEvent(dossier.paths, {
          actionStep: actionStepCount,
          explorationBudget: EXPLORATION_BUDGET_STEPS,
          recentRepoFacts: recentRepoFacts
            .slice(-4)
            .map((fact) => fact.summary),
          timestamp: now().toISOString(),
          toolRequest: summarizeToolRequestForEvent(toolRequest),
          type: "engineer-convergence-guard-triggered",
        });
      } else if (
        shouldBlockAfterPassingCheck(toolRequest, requiredCheckCommand) &&
        postPassCompletionGate.active
      ) {
        convergenceGuardReason = "post-pass-completion-gate";
        toolFeedback = createPostPassCompletionGateFeedback({
          toolName: toolRequest.toolName,
        });
        await appendRunEvent(dossier.paths, {
          actionStep: actionStepCount,
          reason: "post-pass-completion-gate",
          timestamp: now().toISOString(),
          toolRequest: summarizeToolRequestForEvent(toolRequest),
          type: "engineer-convergence-guard-triggered",
        });
      } else if (
        isRepeatedNoOpWriteRequest(toolRequest, lastNoOpWrite) &&
        postPassCompletionGate.active
      ) {
        convergenceGuardReason = "post-pass-no-progress";
        toolFeedback = createRepeatedNoOpWriteFeedback(toolRequest);
        await appendRunEvent(dossier.paths, {
          actionStep: actionStepCount,
          reason: "post-pass-no-progress",
          timestamp: now().toISOString(),
          toolRequest: summarizeToolRequestForEvent(toolRequest),
          type: "engineer-convergence-guard-triggered",
        });
      } else {
        toolFeedback = await executeEngineerTool({
          executor: toolExecutor,
          request: toolRequest,
        });
      }

      messages.push({
        content: renderToolFeedbackForModel(toolFeedback),
        name: toolRequest.toolName,
        role: "tool",
      });

      if (isExplorationToolRequest(toolRequest)) {
        consecutiveExplorationSteps = Math.min(
          EXPLORATION_BUDGET_STEPS,
          consecutiveExplorationSteps + 1,
        );
      } else {
        consecutiveExplorationSteps = 0;
      }

      updateRecentRepoFacts(recentRepoFacts, toolFeedback);

      if (
        toolFeedback.ok &&
        toolRequest.toolName === "file.write" &&
        toolFeedback.result.toolName === "file.write"
      ) {
        if (toolFeedback.result.changed) {
          if (stepsToFirstEdit === null) {
            stepsToFirstEdit = actionStepCount;
          }
          editSinceLastFailedCheck = true;
          lastNoOpWrite = undefined;
        } else {
          lastNoOpWrite = {
            path: toolFeedback.result.path,
            signature: createFileWriteSignature(toolRequest),
          };
        }
      }

      if (toolFeedback.ok && isGroundingToolRequest(toolRequest)) {
        groundingSinceLastFailedCheck = true;
      }

      if (
        toolFeedback.ok &&
        invalidatesPassingCheck(toolFeedback, toolRequest, requiredCheckCommand)
      ) {
        postPassCompletionGate.active = false;
        postPassCompletionGate.completionOnly = false;
      }

      const guidance = createPostToolGuidance({
        consecutiveExplorationSteps,
        explorationBudget: EXPLORATION_BUDGET_STEPS,
        postPassCompletionGateActive: postPassCompletionGate.active,
        requiredCheckCommand,
        recentRepoFacts,
        toolFeedback,
        toolRequest,
      });

      if (guidance !== undefined) {
        if (guidance.usedRepoMemory) {
          repoMemoryFeedbackCount += 1;
        }
        messages.push({
          content: guidance.content,
          role: "user",
        });
        await appendStructuredMessage(dossier.paths, {
          content: guidance.content,
          role: "system",
          timestamp: now().toISOString(),
        });
      }

      if (
        postPassCompletionGate.active &&
        (usedGreenCheckFollowUpStep ||
          convergenceGuardReason === "post-pass-completion-gate" ||
          convergenceGuardReason === "post-pass-no-progress")
      ) {
        postPassCompletionGate.completionOnly = true;
        const completionOnlyGuidance = createCompletionOnlyGuidance(
          convergenceGuardReason,
          usedGreenCheckFollowUpStep,
        );

        messages.push({
          content: completionOnlyGuidance,
          role: "user",
        });
        await appendStructuredMessage(dossier.paths, {
          content: completionOnlyGuidance,
          role: "system",
          timestamp: now().toISOString(),
        });
      }

      if (
        isRequiredCheckCommand(toolRequest, requiredCheckCommand) &&
        !shouldSkipRequiredCheckRecording(convergenceGuardReason)
      ) {
        const recordedCheck = toCheckResult(toolFeedback, requiredCheckCommand);

        checks.push(recordedCheck);
        await writeChecks(
          dossier.paths,
          {
            checks,
            recordedAt: now().toISOString(),
          },
          now().toISOString(),
        );

        if (recordedCheck.status === "passed") {
          consecutiveFailedChecks = 0;
          editSinceLastFailedCheck = false;
          groundingSinceLastFailedCheck = false;
          postPassCompletionGate.active = true;
          postPassCompletionGate.completionOnly = false;

          if (action.stopWhenSuccessful === true) {
            outcome = {
              status: "success",
              stopReason: "passing-checks",
              summary: action.summary,
            };
            break;
          }
        } else {
          consecutiveFailedChecks += 1;
          editSinceLastFailedCheck = false;
          groundingSinceLastFailedCheck = false;
          postPassCompletionGate.active = false;
          postPassCompletionGate.completionOnly = false;

          if (consecutiveFailedChecks >= maxConsecutiveFailedChecks) {
            outcome = {
              status: "failed",
              stopReason: "max-consecutive-failed-checks",
              summary: `Required check failed ${consecutiveFailedChecks} consecutive times.`,
            };
            break;
          }
        }
      }
    }

    if (outcome === undefined) {
      outcome = {
        status: "stopped",
        stopReason: "max-iterations",
        summary: `Reached the configured Engineer iteration limit of ${maxIterations}.`,
      };
    }

    const toolSummary = toolExecutor.getExecutionSummary();
    const convergence = createRunConvergenceMetrics({
      explorationBudgetExhaustedAtStep,
      repoMemoryFeedbackCount,
      stepsToFirstCheck,
      stepsToFirstEdit,
      toolSummary,
    });

    return await finalizeEngineerRun({
      checks,
      consecutiveFailedChecks,
      convergence,
      dossier,
      iterationCount,
      loadedConfig: options.loadedConfig,
      now,
      outcome,
      persistFinalArtifacts: options.persistFinalArtifacts ?? true,
      requiredCheckCommand,
      requirePassingChecks,
      task: options.task,
      toolExecutor,
    });
  } finally {
    await toolExecutor.close();
  }
}

async function finalizeEngineerRun(options: {
  checks: RunCheckResult[];
  consecutiveFailedChecks: number;
  convergence: RunConvergenceMetrics;
  dossier: RunDossier;
  iterationCount: number;
  loadedConfig: LoadedHarnessConfig;
  now: () => Date;
  outcome: FinalizedOutcome;
  persistFinalArtifacts: boolean;
  requiredCheckCommand: string;
  requirePassingChecks: boolean;
  task: string;
  toolExecutor: ToolRouter;
}): Promise<EngineerTaskExecution> {
  const finalizedAt = options.now().toISOString();
  const workspaceArtifacts = await collectWorkspaceArtifacts(
    options.toolExecutor,
  );
  const toolSummary = options.toolExecutor.getExecutionSummary();
  let failureNotesMarkdown: string | undefined;

  if (workspaceArtifacts.diff !== undefined) {
    await writeDiff(
      options.dossier.paths,
      workspaceArtifacts.diff.diff,
      finalizedAt,
    );
  }

  if (options.outcome.status !== "success") {
    failureNotesMarkdown = renderFailureNotes({
      blockedNotes: options.outcome.blockedNotes,
      checks: options.checks,
      summary: options.outcome.summary,
    });
    await writeFailureNotes(
      options.dossier.paths,
      failureNotesMarkdown,
      finalizedAt,
    );
  }

  if (options.persistFinalArtifacts) {
    const finalReport = renderFinalReport({
      checks: options.checks,
      diffPath: options.dossier.paths.files.diff.relativePath,
      failureNotesPath:
        options.outcome.status === "success"
          ? undefined
          : options.dossier.paths.files.failureNotes.relativePath,
      gitStatus: workspaceArtifacts.status,
      outcome: options.outcome,
      projectAdapter: options.loadedConfig.resolvedProject.adapter,
      resolvedCommands: toResolvedCommandRecord(options.loadedConfig),
      requiredCheckCommand: options.requiredCheckCommand,
      requirePassingChecks: options.requirePassingChecks,
      runDir: options.dossier.paths.runDirRelativePath,
      task: options.task,
      convergence: options.convergence,
      toolSummary,
      workspaceNotes: workspaceArtifacts.notes,
    });

    await writeFinalReport(options.dossier.paths, finalReport, finalizedAt);
  }

  if (workspaceArtifacts.notes.length > 0) {
    await appendRunEvent(options.dossier.paths, {
      notes: workspaceArtifacts.notes,
      timestamp: finalizedAt,
      type: "engineer-finalization-warning",
    });
  }

  const resultArtifacts = [
    options.dossier.paths.files.run.relativePath,
    options.dossier.paths.files.events.relativePath,
    options.dossier.paths.files.commandLog.relativePath,
    options.dossier.paths.files.engineerTask.relativePath,
    options.dossier.paths.files.checks.relativePath,
    options.dossier.paths.files.diff.relativePath,
  ];

  if (options.outcome.status !== "success") {
    resultArtifacts.push(options.dossier.paths.files.failureNotes.relativePath);
  }

  if (options.persistFinalArtifacts) {
    resultArtifacts.push(options.dossier.paths.files.finalReport.relativePath);
    resultArtifacts.push(options.dossier.paths.files.result.relativePath);
  }

  const result: RunResult = {
    artifacts: resultArtifacts,
    convergence: options.convergence,
    status: options.outcome.status,
    summary: options.outcome.summary,
  };

  await appendRunEvent(options.dossier.paths, {
    convergence: options.convergence,
    status: options.outcome.status,
    stopReason: options.outcome.stopReason,
    summary: options.outcome.summary,
    timestamp: finalizedAt,
    type: "engineer-run-finished",
  });

  if (options.persistFinalArtifacts) {
    await writeRunResult(options.dossier.paths, result, finalizedAt);
  }

  return {
    checks: [...options.checks],
    consecutiveFailedChecks: options.consecutiveFailedChecks,
    dossier: options.dossier,
    failureNotes: failureNotesMarkdown,
    iterationCount: options.iterationCount,
    result,
    stopReason: options.outcome.stopReason,
    toolSummary,
  };
}

async function executeEngineerTool(options: {
  executor: ToolRouter;
  request: ToolRequest;
}): Promise<ToolFeedback> {
  try {
    const result = await options.executor.execute(
      { role: "engineer" },
      options.request,
    );

    return {
      ok: true,
      result,
      toolName: options.request.toolName,
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
        toolName: options.request.toolName,
      };
    }

    const message = error instanceof Error ? error.message : String(error);

    throw new Error(
      `Unexpected tool failure for ${options.request.toolName}: ${message}`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

async function collectWorkspaceArtifacts(
  executor: ToolRouter,
): Promise<WorkspaceArtifactCollection> {
  const notes: string[] = [];
  const status = await safelyExecuteToolWithNotes(
    executor,
    { toolName: "git.status" },
    notes,
    "Git status was unavailable for the final report",
  );
  const diff = await safelyExecuteToolWithNotes(
    executor,
    { toolName: "git.diff" },
    notes,
    "Git diff was unavailable for the final report",
  );

  return {
    diff: diff?.toolName === "git.diff" ? diff : undefined,
    notes,
    status: status?.toolName === "git.status" ? status : undefined,
  };
}

async function safelyExecuteToolWithNotes(
  executor: ToolRouter,
  request: ToolRequest,
  notes: string[],
  context: string,
): Promise<ToolResult | undefined> {
  try {
    return await executor.execute({ role: "engineer" }, request);
  } catch (error) {
    if (error instanceof BuiltInToolError || error instanceof McpToolError) {
      notes.push(`${context}: ${error.message}`);
      return undefined;
    }

    const message = error instanceof Error ? error.message : String(error);

    notes.push(`${context}: ${message}`);
    return undefined;
  }
}

function applyRemainingTimeToToolRequest(
  request: ToolRequest,
  remainingTimeMs: number,
): ToolRequest {
  if (request.toolName !== "command.execute") {
    return request;
  }

  const boundedTimeoutMs =
    request.timeoutMs === undefined
      ? Math.max(1, remainingTimeMs)
      : Math.max(1, Math.min(request.timeoutMs, remainingTimeMs));

  return {
    ...request,
    timeoutMs: boundedTimeoutMs,
  };
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

function isRequiredCheckCommand(
  request: ToolRequest,
  requiredCheckCommand: string,
): boolean {
  return (
    request.toolName === "command.execute" &&
    normalizeCommand(request.command) === normalizeCommand(requiredCheckCommand)
  );
}

function toCheckResult(
  feedback: ToolFeedback,
  requiredCheckCommand: string,
): RunCheckResult {
  if (feedback.ok === false) {
    return {
      command: requiredCheckCommand,
      name: "test",
      status: "failed",
      summary: `${feedback.error.name}: ${feedback.error.message}`,
    };
  }

  if (feedback.result.toolName !== "command.execute") {
    return {
      command: requiredCheckCommand,
      name: "test",
      status: "failed",
      summary: "Required check did not produce a command result.",
    };
  }

  return {
    command: feedback.result.command,
    durationMs: feedback.result.durationMs,
    exitCode: feedback.result.exitCode,
    name: "test",
    status: feedback.result.exitCode === 0 ? "passed" : "failed",
    summary:
      feedback.result.exitCode === 0
        ? "Required check passed."
        : `Required check failed with exit code ${feedback.result.exitCode}.`,
  };
}

function renderFailureNotes(options: {
  blockedNotes?: string[] | undefined;
  checks: RunCheckResult[];
  summary: string;
}): string {
  const lines = ["# Failure Notes", "", options.summary];

  if ((options.blockedNotes?.length ?? 0) > 0) {
    lines.push("", "## Blockers", "");

    for (const blocker of options.blockedNotes ?? []) {
      lines.push(`- ${blocker}`);
    }
  }

  const lastCheck = options.checks.at(-1);

  if (lastCheck !== undefined) {
    lines.push(
      "",
      "## Last Check",
      "",
      `- ${lastCheck.summary ?? lastCheck.status}`,
    );
  }

  return lines.join("\n");
}

function renderToolFeedbackForModel(feedback: ToolFeedback): string {
  if (feedback.ok === false) {
    return JSON.stringify({
      error: {
        code: feedback.error.code,
        message: feedback.error.message,
        name: feedback.error.name,
      },
      ok: false,
      toolName: feedback.toolName,
    });
  }

  switch (feedback.result.toolName) {
    case "file.search":
    case "file.list":
      return JSON.stringify({
        ok: true,
        result:
          feedback.result.toolName === "file.list"
            ? summarizeFileListForModel(feedback.result)
            : feedback.result,
        toolName: feedback.toolName,
      });
    case "file.read_many":
      return JSON.stringify({
        ok: true,
        result: {
          ...feedback.result,
          files: feedback.result.files.map((file) => ({
            ...file,
            content: truncateWithNotice(
              file.content,
              Math.min(1600, MAX_MODEL_VISIBLE_FILE_READ_CHARS),
            ),
          })),
          summary:
            feedback.result.files.length === 0
              ? "No files were returned."
              : `Read ${feedback.result.files.length} file${feedback.result.files.length === 1 ? "" : "s"}.`,
        },
        toolName: feedback.toolName,
      });
    case "file.read":
      return JSON.stringify({
        ok: true,
        result: {
          ...feedback.result,
          content: truncateWithNotice(
            feedback.result.content,
            MAX_MODEL_VISIBLE_FILE_READ_CHARS,
          ),
        },
        toolName: feedback.toolName,
      });
    case "file.write":
      return JSON.stringify({
        ok: true,
        result: {
          ...feedback.result,
          summary: feedback.result.created
            ? `Created \`${feedback.result.path}\`.`
            : feedback.result.changed
              ? `Updated \`${feedback.result.path}\`.`
              : `No changes written to \`${feedback.result.path}\`; the file already matched the requested content.`,
        },
        toolName: feedback.toolName,
      });
    case "command.execute":
      return JSON.stringify({
        ok: true,
        result: {
          command: feedback.result.command,
          durationMs: feedback.result.durationMs,
          exitCode: feedback.result.exitCode,
          summary:
            feedback.result.exitCode === 0
              ? "Command completed successfully."
              : `Command failed with exit code ${feedback.result.exitCode}.`,
          stderr: truncateWithNotice(
            feedback.result.stderr,
            MAX_MODEL_VISIBLE_COMMAND_OUTPUT_CHARS,
          ),
          stdout: truncateWithNotice(
            feedback.result.stdout,
            MAX_MODEL_VISIBLE_COMMAND_OUTPUT_CHARS,
          ),
          toolName: feedback.result.toolName,
        },
        toolName: feedback.toolName,
      });
    case "git.status":
      return JSON.stringify({
        ok: true,
        result: {
          branch: feedback.result.branch,
          entries: feedback.result.entries.slice(0, 12),
          isClean: feedback.result.isClean,
          summary: feedback.result.isClean
            ? "Working tree is clean."
            : `Working tree has ${feedback.result.entries.length} changed path${
                feedback.result.entries.length === 1 ? "" : "s"
              }.`,
          toolName: feedback.result.toolName,
        },
        toolName: feedback.toolName,
      });
    case "git.diff":
      return JSON.stringify({
        ok: true,
        result: {
          byteLength: feedback.result.byteLength,
          diff: truncateWithNotice(feedback.result.diff, 4000),
          isEmpty: feedback.result.isEmpty,
          staged: feedback.result.staged,
          summary: feedback.result.isEmpty
            ? "Diff is empty."
            : "Diff contains workspace changes.",
          toolName: feedback.result.toolName,
        },
        toolName: feedback.toolName,
      });
    default:
      return JSON.stringify(feedback);
  }
}

function truncateWithNotice(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return [
    value.slice(0, maxChars),
    "",
    `[truncated ${value.length - maxChars} additional characters]`,
  ].join("\n");
}

function isExplorationToolRequest(request: ToolRequest): boolean {
  return (
    request.toolName === "file.search" ||
    request.toolName === "file.read_many" ||
    request.toolName === "file.list" ||
    request.toolName === "file.read" ||
    request.toolName === "git.diff" ||
    request.toolName === "git.status"
  );
}

function isGroundingToolRequest(request: ToolRequest): boolean {
  return (
    request.toolName === "file.search" ||
    request.toolName === "file.read_many" ||
    request.toolName === "file.list" ||
    request.toolName === "file.read"
  );
}

function shouldBlockAfterPassingCheck(
  request: ToolRequest,
  requiredCheckCommand: string,
): boolean {
  return (
    request.toolName === "file.search" ||
    request.toolName === "file.list" ||
    request.toolName === "git.diff" ||
    request.toolName === "git.status" ||
    isRequiredCheckCommand(request, requiredCheckCommand)
  );
}

function shouldSkipRequiredCheckRecording(
  convergenceGuardReason: EngineerConvergenceGuardReason | undefined,
): boolean {
  return (
    convergenceGuardReason === "post-pass-no-progress" ||
    convergenceGuardReason === "post-pass-completion-gate" ||
    convergenceGuardReason === "required-check-without-progress"
  );
}

function invalidatesPassingCheck(
  feedback: ToolFeedback,
  request: ToolRequest,
  requiredCheckCommand: string,
): boolean {
  if (request.toolName === "file.write") {
    return feedback.ok && feedback.result.toolName === "file.write"
      ? feedback.result.changed
      : true;
  }

  if (isRequiredCheckCommand(request, requiredCheckCommand)) {
    return false;
  }

  if (request.toolName === "command.execute") {
    return request.accessMode !== "inspect";
  }

  return request.toolName === "mcp.call";
}

function createFileWriteSignature(
  request: Extract<ToolRequest, { toolName: "file.write" }>,
): string {
  return JSON.stringify({
    content: request.content,
    path: request.path,
  });
}

function isRepeatedNoOpWriteRequest(
  request: ToolRequest,
  lastNoOpWrite: NoOpWriteFact | undefined,
): request is Extract<ToolRequest, { toolName: "file.write" }> {
  return (
    request.toolName === "file.write" &&
    lastNoOpWrite !== undefined &&
    request.path === lastNoOpWrite.path &&
    createFileWriteSignature(request) === lastNoOpWrite.signature
  );
}

function isDuplicateExplorationRequest(request: ToolRequest): boolean {
  return (
    request.toolName === "file.read" ||
    request.toolName === "file.read_many" ||
    request.toolName === "file.list"
  );
}

function createPostToolGuidance(options: {
  consecutiveExplorationSteps: number;
  explorationBudget: number;
  postPassCompletionGateActive: boolean;
  requiredCheckCommand: string;
  recentRepoFacts: RepoFact[];
  toolFeedback: ToolFeedback;
  toolRequest: ToolRequest;
}): PostToolGuidance | undefined {
  if (
    options.toolFeedback.ok === false &&
    (options.toolFeedback.error.code === "path-violation" ||
      options.toolFeedback.error.code === "invalid-input")
  ) {
    const knownPathsHint = renderKnownPathsHint(options.recentRepoFacts);

    return {
      content: [
        `The previous ${options.toolRequest.toolName} request used an invalid path: ${options.toolFeedback.error.message}`,
        "Do not retry the same missing path.",
        "Use a project-relative path that is already verified by the run context.",
        ...(knownPathsHint === undefined ? [] : [knownPathsHint]),
        "List a known existing parent directory or switch to another known path.",
      ].join(" "),
      usedRepoMemory: knownPathsHint !== undefined,
    };
  }

  if (
    options.toolFeedback.ok === false &&
    options.toolFeedback.error.code === "invalid-state" &&
    options.toolRequest.toolName === "file.write"
  ) {
    return {
      content: [
        options.toolFeedback.error.message,
        "If the requested change is already present and no other work is needed, reply with `COMPLETE: <summary>`.",
        "Otherwise make one concrete new change before running the required check again.",
      ].join(" "),
      usedRepoMemory: false,
    };
  }

  if (
    options.toolFeedback.ok === false &&
    options.toolFeedback.error.code === "invalid-state" &&
    options.postPassCompletionGateActive &&
    shouldBlockAfterPassingCheck(
      options.toolRequest,
      options.requiredCheckCommand,
    )
  ) {
    return {
      content: [
        `The latest required check already passed.`,
        "Do not restart broad exploration or rerun the required check from this green state.",
        "Reply with `COMPLETE: <summary>` if the task is satisfied, or take one concrete follow-up step that is still required.",
      ].join(" "),
      usedRepoMemory: false,
    };
  }

  if (
    options.toolFeedback.ok === false &&
    options.toolFeedback.error.code === "invalid-state" &&
    isRequiredCheckCommand(options.toolRequest, options.requiredCheckCommand)
  ) {
    return {
      content: [
        options.toolFeedback.error.message,
        "Inspect one real file or edit one verified target before re-running the required check.",
      ].join(" "),
      usedRepoMemory: options.recentRepoFacts.length > 0,
    };
  }

  if (
    options.toolFeedback.ok === false &&
    options.toolFeedback.error.code === "invalid-state" &&
    isDuplicateExplorationRequest(options.toolRequest)
  ) {
    return {
      content: [
        options.toolFeedback.error.message,
        "Choose one already-inspected file for the smallest reasonable change, or run the required check if the work is ready.",
      ].join(" "),
      usedRepoMemory: false,
    };
  }

  if (options.consecutiveExplorationSteps >= options.explorationBudget) {
    return {
      content: [
        `You have spent ${options.consecutiveExplorationSteps} consecutive steps exploring without editing files or running \`${options.requiredCheckCommand}\`.`,
        `The exploration budget is exhausted for this run segment (${options.explorationBudget} steps).`,
        ...(options.recentRepoFacts.length === 0
          ? []
          : [
              `Recent stable facts: ${options.recentRepoFacts
                .slice(-4)
                .map((fact) => fact.summary)
                .join(" ")}`,
            ]),
        "Choose one already-inspected file for the smallest reasonable change, or run the required check if the work is done.",
        "If neither is possible, reply with `BLOCKED: <summary>` and concrete blocker lines.",
      ].join(" "),
      usedRepoMemory: options.recentRepoFacts.length > 0,
    };
  }

  return undefined;
}

function createExplorationBudgetFeedback(options: {
  recentRepoFacts: RepoFact[];
  request: ToolRequest;
}): ToolFeedback {
  const recentFacts =
    options.recentRepoFacts.length === 0
      ? "No additional stable repo facts are cached yet."
      : `Recent stable facts: ${options.recentRepoFacts
          .slice(-4)
          .map((fact) => fact.summary)
          .join(" ")}`;

  return {
    error: {
      code: "invalid-state",
      message: [
        `Exploration budget exhausted. The harness refused ${options.request.toolName}.`,
        recentFacts,
        "Edit a file, run the required check, or reply with `BLOCKED: <summary>`.",
      ].join(" "),
      name: "BuiltInToolStateError",
    },
    ok: false,
    toolName: options.request.toolName,
  };
}

function createPostPassCompletionGateFeedback(options: {
  toolName: ToolRequest["toolName"];
}): ToolFeedback {
  return {
    error: {
      code: "invalid-state",
      message: [
        `The latest required check already passed.`,
        "Do not restart broad exploration or rerun the required check from this green state.",
        "Reply with `COMPLETE: <summary>` if the task is already done, or take one concrete follow-up step that still needs verification.",
      ].join(" "),
      name: "BuiltInToolStateError",
    },
    ok: false,
    toolName: options.toolName,
  };
}

function createRepeatedNoOpWriteFeedback(
  request: Extract<ToolRequest, { toolName: "file.write" }>,
): ToolFeedback {
  return {
    error: {
      code: "invalid-state",
      message: [
        `The previous write to \`${request.path}\` did not change the workspace.`,
        "Do not repeat the same no-op write from a green required-check state.",
        "Reply with `COMPLETE: <summary>` if the task is done, or make one different concrete change that still needs verification.",
      ].join(" "),
      name: "BuiltInToolStateError",
    },
    ok: false,
    toolName: request.toolName,
  };
}

function createCompletionOnlyGuidance(
  reason: EngineerConvergenceGuardReason | undefined,
  usedGreenCheckFollowUpStep: boolean,
): string {
  return [
    "The latest required check is already green and the previous post-pass step did not justify more tool work.",
    reason === "post-pass-no-progress"
      ? "That step repeated a no-op write from the green-check state."
      : reason === "post-pass-completion-gate"
        ? "That step restarted blocked exploration or re-ran the required check from the green-check state."
        : usedGreenCheckFollowUpStep
          ? "The single allowed post-pass follow-up step has already been used."
          : "Do not continue tool work from this green-check state.",
    "The next turn is completion-only.",
    "Do not call tools.",
    "Reply with plain-text `COMPLETE: <summary>` if the task is done, or plain-text `BLOCKED: <summary>` with optional `- blocker` lines.",
  ].join(" ");
}

function createRepeatedRequiredCheckFeedback(options: {
  recentRepoFacts: RepoFact[];
  requiredCheckCommand: string;
}): ToolFeedback {
  const knownPathsHint = renderKnownPathsHint(options.recentRepoFacts);

  return {
    error: {
      code: "invalid-state",
      message: [
        `The previous required check already failed and no verified progress was made since then.`,
        `Do not run \`${options.requiredCheckCommand}\` again until you either inspect a real repo path or edit a file.`,
        ...(knownPathsHint === undefined ? [] : [knownPathsHint]),
      ].join(" "),
      name: "BuiltInToolStateError",
    },
    ok: false,
    toolName: "command.execute",
  };
}

function updateRecentRepoFacts(
  recentRepoFacts: RepoFact[],
  toolFeedback: ToolFeedback,
): void {
  if (toolFeedback.ok === false) {
    return;
  }

  for (const fact of createRepoFactsFromToolResult(toolFeedback.result)) {
    const existingIndex = recentRepoFacts.findIndex(
      (entry) => entry.key === fact.key,
    );

    if (existingIndex !== -1) {
      recentRepoFacts.splice(existingIndex, 1);
    }

    recentRepoFacts.push(fact);

    if (recentRepoFacts.length > 8) {
      recentRepoFacts.shift();
    }
  }
}

function createRepoFactsFromToolResult(result: ToolResult): RepoFact[] {
  switch (result.toolName) {
    case "file.list":
      return [
        {
          key: `file.list:${result.path}`,
          paths: result.entries.map((entry) => entry.path),
          summary: summarizeListRepoFact(result),
        },
      ];
    case "file.read":
      return [
        {
          key: `file.read:${result.path}`,
          paths: [result.path],
          summary: `Read \`${result.path}\` (${result.byteLength} bytes).`,
        },
      ];
    case "file.read_many":
      return result.files.map((file) => ({
        key: `file.read:${file.path}`,
        paths: [file.path],
        summary: `Read \`${file.path}\` (${file.byteLength} bytes).`,
      }));
    case "file.search":
      return [
        {
          key: `file.search:${result.path}:${result.query}`,
          paths: result.results.map((entry) => entry.path),
          summary: summarizeSearchRepoFact(result),
        },
      ];
    default:
      return [];
  }
}

function summarizeListRepoFact(
  result: Extract<ToolResult, { toolName: "file.list" }>,
): string {
  const sample = result.entries
    .slice(0, 4)
    .map((entry) => `\`${entry.path}\``)
    .join(", ");

  return sample.length === 0
    ? `Listed \`${result.path}\` (no entries).`
    : `Listed \`${result.path}\`: ${sample}.`;
}

function summarizeSearchRepoFact(
  result: Extract<ToolResult, { toolName: "file.search" }>,
): string {
  const sample = result.results
    .slice(0, 4)
    .map((entry) => `\`${entry.path}\``)
    .join(", ");

  return sample.length === 0
    ? `Searched \`${result.path}\` for \`${result.query}\` with no matches.`
    : `Searched \`${result.path}\` for \`${result.query}\`: ${sample}.`;
}

function renderKnownPathsHint(
  recentRepoFacts: readonly RepoFact[],
): string | undefined {
  const candidatePaths = Array.from(
    new Set(
      recentRepoFacts
        .flatMap((fact) => fact.paths)
        .filter((path) => path.length > 0),
    ),
  ).slice(0, 6);

  if (candidatePaths.length === 0) {
    return undefined;
  }

  return `Known verified paths: ${candidatePaths
    .map((path) => `\`${path}\``)
    .join(", ")}.`;
}

function createRunConvergenceMetrics(options: {
  explorationBudgetExhaustedAtStep: number | null;
  repoMemoryFeedbackCount: number;
  stepsToFirstCheck: number | null;
  stepsToFirstEdit: number | null;
  toolSummary: ToolExecutionSummary;
}): RunConvergenceMetrics {
  return {
    duplicateExplorationSuppressions:
      options.toolSummary.duplicateExplorationSuppressions,
    explorationBudget: EXPLORATION_BUDGET_STEPS,
    explorationBudgetExhaustedAtStep: options.explorationBudgetExhaustedAtStep,
    repeatedListingCount: options.toolSummary.repeatedListingCount,
    repeatedReadCount: options.toolSummary.repeatedReadCount,
    repoMemoryHits:
      options.toolSummary.repoMemoryHits + options.repoMemoryFeedbackCount,
    stepsToFirstCheck: options.stepsToFirstCheck,
    stepsToFirstEdit: options.stepsToFirstEdit,
  };
}

function createRetryableModelErrorGuidance(options: {
  error: ModelClientError;
  recentRepoFacts: readonly RepoFact[];
  requiredCheckCommand: string;
}): string {
  const issueDetails =
    options.error.issues === undefined || options.error.issues.length === 0
      ? "The previous response could not be applied as a single Engineer step."
      : `The previous response could not be applied as a single Engineer step: ${options.error.issues.join("; ")}`;
  const knownPathsHint = renderKnownPathsHint(options.recentRepoFacts);

  return [
    issueDetails,
    "Return exactly one next step.",
    "If you need repository or workspace access, call exactly one native tool and do not wrap it in a JSON envelope.",
    "Commands already run from the project root by default. Do not prepend `cd` or invent workspace paths.",
    `For the required check, prefer \`command.execute\` with \`command: "${options.requiredCheckCommand}"\` and omit \`workingDirectory\` unless you verified a real relative subdirectory.`,
    ...(knownPathsHint === undefined ? [] : [knownPathsHint]),
    "If you are done, put `COMPLETE:` on the first completion line with no prose before it.",
    "If you are blocked, put `BLOCKED:` on the first completion line with no prose before it.",
    "If you call a tool, keep any assistant text brief. Use `STOP_ON_SUCCESS` only when the tool call is the required check and the run should end immediately if it passes.",
    "If the task is done, reply with `COMPLETE: <summary>` after the required check has passed.",
    "If you cannot continue, reply with `BLOCKED: <summary>` and optional `- blocker` lines.",
    "If this endpoint already received a fallback tool instruction because native tools were rejected, follow that fallback exactly instead of inventing a new format.",
    `The required check is \`${options.requiredCheckCommand}\`.`,
  ].join(" ");
}

function renderFinalReport(options: {
  checks: RunCheckResult[];
  convergence: RunConvergenceMetrics;
  diffPath: string;
  failureNotesPath?: string | undefined;
  gitStatus: Extract<ToolResult, { toolName: "git.status" }> | undefined;
  outcome: FinalizedOutcome;
  projectAdapter: LoadedHarnessConfig["resolvedProject"]["adapter"];
  resolvedCommands: Record<string, string | undefined>;
  requiredCheckCommand: string;
  requirePassingChecks: boolean;
  runDir: string;
  task: string;
  toolSummary: ToolExecutionSummary;
  workspaceNotes: string[];
}): string {
  const lines = [
    "# Final Report",
    "",
    "## Outcome",
    "",
    `- Status: ${options.outcome.status}`,
    `- Stop reason: ${options.outcome.stopReason}`,
    `- Summary: ${options.outcome.summary}`,
    "",
    "## Task",
    "",
    options.task.trim(),
    "",
    "## Project Adapter",
    "",
    `- Adapter: ${formatProjectAdapter(options.projectAdapter)}`,
    ...Object.entries(options.resolvedCommands).map(
      ([commandName, command]) =>
        `- ${commandName}: ${command === undefined ? "not resolved" : `\`${command}\``}`,
    ),
    "",
    "## Verification",
    "",
    `- Required check enforced: ${options.requirePassingChecks ? "yes" : "no"}`,
    `- Required check command: \`${options.requiredCheckCommand}\``,
    `- Check attempts recorded: ${options.checks.length}`,
    `- Dossier: ${options.runDir}`,
    `- Diff artifact: ${options.diffPath}`,
    `- Failure notes artifact: ${options.failureNotesPath ?? "not written"}`,
    "",
  ];

  const lastCheck = options.checks.at(-1);

  if (lastCheck !== undefined) {
    lines.push(
      `- Last check: ${lastCheck.status}${lastCheck.exitCode === undefined ? "" : ` (exit ${lastCheck.exitCode})`}`,
    );
  } else {
    lines.push("- Last check: not run");
  }

  lines.push(
    "",
    "## Tooling",
    "",
    `- Built-in calls recorded: ${options.toolSummary.builtInCallCount}`,
    `- MCP calls recorded: ${options.toolSummary.mcpCallCount}`,
    `- MCP configured servers: ${formatList(options.toolSummary.mcpServers.configured)}`,
    `- MCP available servers: ${formatList(options.toolSummary.mcpServers.available)}`,
    `- MCP available tools: ${
      options.toolSummary.mcpTools.length === 0
        ? "none"
        : options.toolSummary.mcpTools
            .map((tool) => `${tool.server}.${tool.name}`)
            .join(", ")
    }`,
    `- MCP calls: ${
      options.toolSummary.mcpCalls.length === 0
        ? "none"
        : options.toolSummary.mcpCalls
            .map((call) => `${call.server}.${call.name} (${call.status})`)
            .join(", ")
    }`,
  );

  lines.push(
    "",
    "## Convergence",
    "",
    `- Exploration budget: ${options.convergence.explorationBudget}`,
    `- Exploration budget exhausted at step: ${options.convergence.explorationBudgetExhaustedAtStep ?? "not reached"}`,
    `- Steps to first edit: ${options.convergence.stepsToFirstEdit ?? "not reached"}`,
    `- Steps to first required check: ${options.convergence.stepsToFirstCheck ?? "not reached"}`,
    `- Repeated reads suppressed: ${options.convergence.repeatedReadCount}`,
    `- Repeated listings suppressed: ${options.convergence.repeatedListingCount}`,
    `- Duplicate exploration suppressions: ${options.convergence.duplicateExplorationSuppressions}`,
    `- Repo-memory feedback uses: ${options.convergence.repoMemoryHits}`,
  );

  lines.push("", "## Workspace", "");

  if (options.gitStatus !== undefined) {
    const changedPaths = options.gitStatus.entries.map((entry) => entry.path);

    lines.push(`- Branch: ${options.gitStatus.branch.head}`);
    lines.push(
      `- Clean working tree: ${options.gitStatus.isClean ? "yes" : "no"}`,
    );
    lines.push(
      `- Changed paths: ${changedPaths.length === 0 ? "none" : changedPaths.join(", ")}`,
    );
  } else {
    lines.push("- Git status: unavailable");
  }

  if (options.toolSummary.mcpServers.unavailable.length > 0) {
    lines.push("", "## MCP Diagnostics", "");

    for (const diagnostic of options.toolSummary.mcpServers.unavailable) {
      lines.push(`- ${diagnostic.message}`);
    }
  }

  if (options.workspaceNotes.length > 0) {
    lines.push("", "## Notes", "");

    for (const note of options.workspaceNotes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
}

function renderEngineerTaskBrief(options: {
  loadedConfig: LoadedHarnessConfig;
  maxConsecutiveFailedChecks: number;
  maxIterations: number;
  task: string;
  taskFormat: "brief" | "objective";
  timeoutMs: number;
  toolCatalog: ToolCatalog;
}): string {
  const builtInTools = renderBuiltInToolsMarkdown();
  const mcpTools = renderMcpToolsMarkdown(options.toolCatalog);
  const requiredCheckCommand = getRequiredCheckCommand(options.loadedConfig);

  const taskSection =
    options.taskFormat === "brief"
      ? [
          "# Engineer Task Brief",
          "",
          "Follow the Architect brief literally. The harness rules, stop conditions, and available tools appear after it.",
          "",
          options.task.trim(),
        ]
      : [
          "# Engineer Task Brief",
          "",
          "## Objective",
          "",
          options.task.trim(),
          "",
          "## Execution Order",
          "",
          "1. Follow the objective literally and prefer the smallest correct action.",
          "2. If the task already names exact files or commands, act on those first.",
          "3. Avoid broad repository exploration unless the task is ambiguous.",
          `4. Before finishing, run \`${requiredCheckCommand}\` if passing checks are required.`,
          "5. As soon as the acceptance criteria are satisfied, return `COMPLETE:` instead of continuing to explore.",
          "",
          "## Project Adapter",
          "",
          `- Adapter: ${formatProjectAdapter(options.loadedConfig.resolvedProject.adapter)}`,
          ...Object.entries(toResolvedCommandRecord(options.loadedConfig)).map(
            ([commandName, command]) =>
              `- ${commandName}: ${command === undefined ? "not resolved" : `\`${command}\``}`,
          ),
          "",
          "## Required Check",
          "",
          `Run \`${requiredCheckCommand}\` through \`command.execute\` before final completion when passing checks are required.`,
        ];

  return [
    ...taskSection,
    "",
    "## Stop Conditions",
    "",
    `- Max iterations: ${formatIterationLimit(options.maxIterations)}`,
    `- Timeout: ${options.timeoutMs}ms`,
    `- Consecutive failed required checks allowed: ${options.maxConsecutiveFailedChecks}`,
    `- Exploration budget before edit/check/blocker: ${EXPLORATION_BUDGET_STEPS}`,
    `- Passing checks required: ${options.loadedConfig.config.stopConditions.requirePassingChecks ? "yes" : "no"}`,
    "",
    "## Available Built-in Tools",
    "",
    builtInTools,
    "",
    "## Available MCP Tools",
    "",
    mcpTools,
  ].join("\n");
}

function renderEngineerProtocol(options: {
  explorationBudget: number;
  maxConsecutiveFailedChecks: number;
  maxIterations: number;
  requiredCheckCommand: string;
  requirePassingChecks: boolean;
  timeoutMs: number;
}): string {
  return [
    "Return exactly one Engineer step per turn.",
    "",
    "Rules:",
    "- If you need a tool, call exactly one native tool.",
    `- If the task is complete, reply with \`COMPLETE: <summary>\` on the first completion line with no prose before it.`,
    `- If you are blocked, reply with \`BLOCKED: <summary>\` on the first completion line and optional \`- blocker\` lines after it.`,
    `- Include \`STOP_ON_SUCCESS\` in the same assistant message only when running the required check \`${options.requiredCheckCommand}\` and the run should end immediately if it passes.`,
    `- The harness stops after ${formatIterationLimit(options.maxIterations)} Engineer iterations, ${options.timeoutMs}ms, or ${options.maxConsecutiveFailedChecks} consecutive failed required checks.`,
    `- After ${options.explorationBudget} consecutive exploration steps, you must either edit a file, run \`${options.requiredCheckCommand}\`, or return \`BLOCKED:\`. Additional exploration requests will be refused.`,
    `- Passing checks required: ${options.requirePassingChecks ? "yes" : "no"}.`,
    "- Built-in tool names always route to built-in tools. MCP is only available through `mcp.call`.",
    "- Keep tool use explicit and auditable.",
    "- Ignore `.agent-harness`, `.git`, `node_modules`, and other generated or vendor paths unless the task explicitly depends on them.",
    "- If the task already gives you an exact file path, exact content target, or exact command, prefer acting on that directly before exploring.",
    "- `command.execute` already runs from the project root by default. Do not prepend `cd` unless you have verified a real relative subdirectory.",
    "- If the brief includes verified workspace hints, prefer those real paths before guessing new ones.",
    "- Explore search-first: prefer `file.search` to locate symbols, strings, and likely files before using `file.list`.",
    "- Once search yields a few candidates, prefer `file.read_many` for a small batch snapshot instead of repeated one-file reads.",
    "- When you need initial context, prefer `README.md`, `package.json`, `docs/`, `src/`, and `test/` over broad root relisting.",
    "- Prefer converging quickly: after a few discovery steps, choose one concrete file and make the smallest reasonable change.",
    "- Do not reread the same file or relist the same directory unless the workspace changed. The harness will reuse stable repo facts and refuse duplicate rereads/listings.",
    "- If a path does not exist or a tool fails, adapt to that error instead of retrying the same invalid request.",
    "- Once you have enough context, stop exploring and either edit a file, run the required check, or return `COMPLETE:` / `BLOCKED:`.",
    "- If the latest required check already passed and the task appears satisfied, prefer `COMPLETE:` or one minimal confirmation step instead of restarting repository exploration.",
  ].join("\n");
}

function createEngineerToolFallbackInstruction(
  requiredCheckCommand: string,
): string {
  return [
    "Native tool calling is unavailable for this model endpoint.",
    "Fallback protocol: return exactly one JSON object and nothing else.",
    'Tool step: {"type":"tool","summary":"...","request":{"toolName":"file.read","path":"README.md"}}',
    'Final step: {"type":"final","outcome":"complete","summary":"..."}',
    'Blocked step: {"type":"final","outcome":"blocked","summary":"...","blockers":["..."]}',
    `Set \`stopWhenSuccessful: true\` only when the tool request runs \`${requiredCheckCommand}\` and the run should end immediately if it passes.`,
  ].join("\n");
}

function resolveEngineerCompletionOnlyTurn(options: {
  rawContent: string;
  toolCalls?: ModelChatResponse["toolCalls"];
}): Extract<EngineerTurn, { type: "final" }> {
  if ((options.toolCalls?.length ?? 0) > 0) {
    throw new EngineerTurnValidationError([
      "Completion-only turns cannot call tools.",
      "Reply with plain-text `COMPLETE:` or `BLOCKED:` only.",
    ]);
  }

  const lines = options.rawContent
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new EngineerTurnValidationError([
      "Completion-only turns must reply with plain-text `COMPLETE:` or `BLOCKED:`.",
    ]);
  }

  const matchedPrefix = /^(COMPLETE|BLOCKED)\s*:?\s*(.*)$/iu.exec(lines[0]!);

  if (matchedPrefix === null) {
    throw new EngineerTurnValidationError([
      "Completion-only turns must start with plain-text `COMPLETE:` or `BLOCKED:`.",
    ]);
  }

  const outcome =
    matchedPrefix[1]!.toLowerCase() === "blocked" ? "blocked" : "complete";
  const summary = [
    matchedPrefix[2]!,
    ...lines.slice(1).filter((line) => !line.startsWith("- ")),
  ]
    .join(" ")
    .trim();

  if (summary.length === 0) {
    throw new EngineerTurnValidationError([
      `Final ${matchedPrefix[1]!.toUpperCase()} response must include a short summary.`,
    ]);
  }

  const blockers =
    outcome === "blocked"
      ? lines
          .slice(1)
          .filter((line) => line.startsWith("- "))
          .map((line) => line.slice(2).trim())
          .filter((line) => line.length > 0)
      : undefined;

  return blockers === undefined || blockers.length === 0
    ? {
        outcome,
        summary,
        type: "final",
      }
    : {
        blockers,
        outcome,
        summary,
        type: "final",
      };
}

function renderEngineerAssistantMessage(
  action: EngineerTurn,
  rawContent: string,
): string {
  if (action.type === "final") {
    if (rawContent.trim().length > 0) {
      return rawContent;
    }

    if (action.outcome === "blocked") {
      return [
        `BLOCKED: ${action.summary}`,
        ...(action.blockers ?? []).map((blocker) => `- ${blocker}`),
      ].join("\n");
    }

    return `COMPLETE: ${action.summary}`;
  }

  const lines = [renderEngineerToolHistoryLine(action.request)];

  if (action.stopWhenSuccessful === true) {
    lines.push("STOP_ON_SUCCESS");
  }

  return lines.join("\n");
}

function renderEngineerToolHistoryLine(request: ToolRequest): string {
  switch (request.toolName) {
    case "command.execute":
      return `Used \`command.execute\` with \`${request.command}\`.`;
    case "file.list":
      return `Used \`file.list\` on \`${request.path ?? "."}\`.`;
    case "file.read":
      return `Used \`file.read\` on \`${request.path}\`.`;
    case "file.read_many":
      return `Used \`file.read_many\` on ${request.paths.length} file${
        request.paths.length === 1 ? "" : "s"
      }.`;
    case "file.search":
      return `Used \`file.search\` for \`${request.query}\` in \`${request.path ?? "."}\`.`;
    case "file.write":
      return `Used \`file.write\` on \`${request.path}\`.`;
    case "git.diff":
      return `Used \`git.diff\`${request.staged === true ? " (staged)" : ""}.`;
    case "git.status":
      return "Used `git.status`.";
    case "mcp.call":
      return `Used \`mcp.call\` for \`${request.server}.${request.name}\`.`;
    default:
      return "Used one tool step.";
  }
}

function formatIterationLimit(maxIterations: number): string {
  return Number.isFinite(maxIterations) ? `${maxIterations}` : "no fixed limit";
}

function renderBuiltInToolsMarkdown(): string {
  return [
    "### `file.search`",
    "- Search text first. Required: `query`. Optional: `path`, `limit`.",
    "",
    "### `file.read_many`",
    "- Read a small batch after search narrows candidates. Required: `paths`.",
    "",
    "### `file.list`",
    "- List structure only when needed. Optional: `path`. Not a text-search substitute.",
    "",
    "### `file.read`",
    "- Read one file after search or listing identifies it. Required: `path`.",
    "",
    "### `file.write`",
    "- Write one file. Required: `path`, `content`.",
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

function summarizeFileListForModel(
  result: Extract<ToolResult, { toolName: "file.list" }>,
): {
  entries: typeof result.entries;
  hiddenEntryCount?: number | undefined;
  path: string;
  toolName: "file.list";
} {
  const shouldFilterLowValueEntries = !isLowValueExplorationPath(result.path);
  const candidateEntries = shouldFilterLowValueEntries
    ? result.entries.filter((entry) => !isLowValueExplorationPath(entry.path))
    : result.entries;
  const filteredEntries =
    candidateEntries.length === 0 ? result.entries : candidateEntries;
  const rankedEntries = [...filteredEntries].sort((left, right) => {
    const rankingDifference =
      getModelVisibleEntryRank(left.path) -
      getModelVisibleEntryRank(right.path);

    if (rankingDifference !== 0) {
      return rankingDifference;
    }

    return left.path.localeCompare(right.path, "en", { sensitivity: "base" });
  });
  const visibleEntries = rankedEntries.slice(
    0,
    MAX_MODEL_VISIBLE_FILE_LIST_ENTRIES,
  );
  const hiddenEntryCount = result.entries.length - visibleEntries.length;

  return {
    entries: visibleEntries,
    ...(hiddenEntryCount <= 0 ? {} : { hiddenEntryCount }),
    path: result.path,
    toolName: result.toolName,
  };
}

function isLowValueExplorationPath(pathValue: string): boolean {
  return pathValue
    .split("/")
    .some((segment) => LOW_VALUE_EXPLORATION_PATH_SEGMENTS.has(segment));
}

function getModelVisibleEntryRank(pathValue: string): number {
  switch (pathValue) {
    case "README.md":
      return 0;
    case "package.json":
      return 1;
    case "docs":
      return 2;
    case "src":
      return 3;
    case "test":
      return 4;
    default:
      return 10;
  }
}

function renderMcpToolsMarkdown(toolCatalog: ToolCatalog): string {
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

function withEngineerTimeout(
  loadedConfig: LoadedHarnessConfig,
  timeoutMs: number,
): LoadedHarnessConfig {
  return {
    ...loadedConfig,
    config: {
      ...loadedConfig.config,
      models: {
        ...loadedConfig.config.models,
        engineer: {
          ...loadedConfig.config.models.engineer,
          timeoutMs:
            loadedConfig.config.models.engineer.timeoutMs === undefined
              ? timeoutMs
              : Math.min(
                  loadedConfig.config.models.engineer.timeoutMs,
                  timeoutMs,
                ),
        },
      },
    },
  };
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/gu, " ");
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
