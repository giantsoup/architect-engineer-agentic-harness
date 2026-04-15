import { readFile } from "node:fs/promises";

import { getResolvedProjectCommand } from "../adapters/detect-project.js";
import type { LoadedHarnessConfig } from "../types/config.js";
import type { RunCheckResult, RunResult } from "../types/run.js";
import type {
  ModelChatMessage,
  ModelChatRequest,
  ModelChatResponse,
} from "../models/types.js";
import {
  createEngineerStructuredOutputFormat,
  type EngineerAction,
} from "../models/engineer-output.js";
import { createRoleModelClient } from "../models/provider-factory.js";
import { ModelClientError } from "../models/openai-compatible-client.js";
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
const MAX_CONSECUTIVE_EXPLORATION_STEPS = 12;
const MAX_CONSECUTIVE_RETRYABLE_MODEL_ERRORS = 3;
const MAX_CONSECUTIVE_DUPLICATE_EXPLORATION_STEPS = 2;
const LOW_VALUE_EXPLORATION_PATH_SEGMENTS = new Set([
  ".agent-harness",
  ".git",
  "dist",
  "node_modules",
]);

export type EngineerTaskStopReason =
  | "blocked"
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

type ToolFeedback =
  | {
      ok: false;
      toolName: string;
      error: { code: string; message: string; name: string };
    }
  | { ok: true; toolName: string; result: ToolResult };

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

    const [systemPrompt, executePrompt, structuredOutput] = await Promise.all([
      loadPromptAsset(`prompts/${DEFAULT_PROMPT_VERSION}/engineer/system.md`),
      loadPromptAsset(`prompts/${DEFAULT_PROMPT_VERSION}/engineer/execute.md`),
      createEngineerStructuredOutputFormat(),
    ]);

    const messages: ModelChatMessage[] = [
      {
        content: systemPrompt,
        role: "system",
      },
      {
        content: [
          executePrompt.trim(),
          "",
          renderEngineerProtocol({
            maxConsecutiveFailedChecks,
            maxIterations,
            preferNonThinkingMode: shouldPreferNonThinkingMode(
              options.loadedConfig,
            ),
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
    let consecutiveDuplicateExplorationSteps = 0;
    let consecutiveRetryableModelErrors = 0;
    const exploredTargets = new Set<string>();
    const exploredTargetOrder: string[] = [];
    let hasPassingCheck = !requirePassingChecks;
    let iterationCount = 0;
    let outcome: FinalizedOutcome | undefined;

    if (requirePassingChecks) {
      hasPassingCheck = checks.some((check) => check.status === "passed");
    }

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

      let modelResponse: ModelChatResponse<EngineerAction>;

      try {
        modelResponse = await modelClient.chat({
          messages,
          metadata: {
            iteration: iterationCount,
            requiredCheckCommand,
            runId: dossier.paths.runId,
          },
          structuredOutput,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const modelError =
          error instanceof ModelClientError ? error : undefined;

        if (
          modelError?.retryable === true &&
          consecutiveRetryableModelErrors <
            MAX_CONSECUTIVE_RETRYABLE_MODEL_ERRORS
        ) {
          consecutiveRetryableModelErrors += 1;
          const reminder = createRetryableModelErrorGuidance({
            error: modelError,
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
        content: modelResponse.rawContent,
        role: "assistant",
      });

      const action = modelResponse.structuredOutput;

      if (action === undefined) {
        outcome = {
          status: "failed",
          stopReason: "model-error",
          summary: "Engineer model returned no structured action.",
        };
        break;
      }

      await appendRunEvent(dossier.paths, {
        actionType: action.type,
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

        if (requirePassingChecks && !hasPassingCheck) {
          const reminder = [
            `Required check \`${requiredCheckCommand}\` has not passed yet.`,
            "Run it through `command.execute` before returning `final`.",
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

      const toolRequest = applyRemainingTimeToToolRequest(
        action.request,
        remainingTimeMs,
      );
      const toolFeedback = await executeEngineerTool({
        executor: toolExecutor,
        request: toolRequest,
      });

      messages.push({
        content: renderToolFeedbackForModel(toolFeedback),
        name: toolRequest.toolName,
        role: "tool",
      });

      if (isExplorationToolRequest(toolRequest)) {
        consecutiveExplorationSteps += 1;
        const explorationTarget = getExplorationTarget(toolRequest);

        if (explorationTarget !== undefined) {
          if (exploredTargets.has(explorationTarget)) {
            consecutiveDuplicateExplorationSteps += 1;
          } else {
            consecutiveDuplicateExplorationSteps = 0;
            exploredTargets.add(explorationTarget);
            exploredTargetOrder.push(explorationTarget);
          }
        }
      } else {
        consecutiveExplorationSteps = 0;
        consecutiveDuplicateExplorationSteps = 0;
      }

      const guidance = createPostToolGuidance({
        consecutiveDuplicateExplorationSteps,
        consecutiveExplorationSteps,
        exploredTargetOrder,
        requiredCheckCommand,
        toolFeedback,
        toolRequest,
      });

      if (guidance !== undefined) {
        messages.push({
          content: guidance,
          role: "user",
        });
        await appendStructuredMessage(dossier.paths, {
          content: guidance,
          role: "system",
          timestamp: now().toISOString(),
        });
      }

      if (isRequiredCheckCommand(toolRequest, requiredCheckCommand)) {
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
          hasPassingCheck = true;

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

    return await finalizeEngineerRun({
      checks,
      consecutiveFailedChecks,
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
    status: options.outcome.status,
    summary: options.outcome.summary,
  };

  await appendRunEvent(options.dossier.paths, {
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
    return JSON.stringify(feedback);
  }

  switch (feedback.result.toolName) {
    case "file.search":
    case "file.read_many":
    case "file.list":
      return JSON.stringify({
        ok: true,
        result:
          feedback.result.toolName === "file.list"
            ? summarizeFileListForModel(feedback.result)
            : feedback.result,
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
    case "command.execute":
      return JSON.stringify({
        ok: true,
        result: {
          ...feedback.result,
          stderr: truncateWithNotice(
            feedback.result.stderr,
            MAX_MODEL_VISIBLE_COMMAND_OUTPUT_CHARS,
          ),
          stdout: truncateWithNotice(
            feedback.result.stdout,
            MAX_MODEL_VISIBLE_COMMAND_OUTPUT_CHARS,
          ),
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

function createPostToolGuidance(options: {
  consecutiveDuplicateExplorationSteps: number;
  consecutiveExplorationSteps: number;
  exploredTargetOrder: string[];
  requiredCheckCommand: string;
  toolFeedback: ToolFeedback;
  toolRequest: ToolRequest;
}): string | undefined {
  if (
    options.toolFeedback.ok === false &&
    options.toolFeedback.error.code === "path-violation"
  ) {
    return [
      `The previous ${options.toolRequest.toolName} request used an invalid path: ${options.toolFeedback.error.message}`,
      "Do not retry the same missing path.",
      "List a known existing parent directory or switch to another known path.",
    ].join(" ");
  }

  if (
    options.consecutiveDuplicateExplorationSteps >=
    MAX_CONSECUTIVE_DUPLICATE_EXPLORATION_STEPS
  ) {
    const exploredTargets =
      options.exploredTargetOrder.length === 0
        ? "the current workspace"
        : formatList(
            options.exploredTargetOrder
              .slice(-6)
              .map((target) => `\`${target}\``),
          );

    return [
      `You are repeating exploration on files or directories you already inspected: ${exploredTargets}.`,
      "Do not reread the same file or relist the same directory again right now.",
      "Choose one inspected file for the smallest reasonable change, or run the required check if the work is already done.",
    ].join(" ");
  }

  if (
    options.consecutiveExplorationSteps >= MAX_CONSECUTIVE_EXPLORATION_STEPS
  ) {
    return [
      `You have spent ${options.consecutiveExplorationSteps} consecutive steps exploring without editing files or running \`${options.requiredCheckCommand}\`.`,
      "Stop broad exploration.",
      "Choose one already-inspected file for the smallest reasonable change, or run the required check if the work is done.",
      "Do not reread files or relist directories unless you need one specific missing detail.",
    ].join(" ");
  }

  return undefined;
}

function createRetryableModelErrorGuidance(options: {
  error: ModelClientError;
  requiredCheckCommand: string;
}): string {
  const issueDetails =
    options.error.issues === undefined || options.error.issues.length === 0
      ? "The previous response did not match the required engineer_action schema."
      : `The previous response did not match the required engineer_action schema: ${options.error.issues.join("; ")}`;

  return [
    issueDetails,
    "Return exactly one JSON object matching the schema and nothing else.",
    "Use only one tool request or one final action.",
    "Match the chosen tool's exact request shape and omit extra fields.",
    "For example, `file.read`, `file.write`, `file.list`, and `file.search` may include `path`, while `file.read_many` uses `paths`.",
    `If the work is already done, run \`${options.requiredCheckCommand}\` or return a valid \`final\` action after a passing check is recorded.`,
  ].join(" ");
}

function renderFinalReport(options: {
  checks: RunCheckResult[];
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
  timeoutMs: number;
  toolCatalog: ToolCatalog;
}): string {
  const builtInTools = renderBuiltInToolsMarkdown();
  const mcpTools = renderMcpToolsMarkdown(options.toolCatalog);
  const requiredCheckCommand = getRequiredCheckCommand(options.loadedConfig);

  return [
    "# Engineer Task Brief",
    "",
    "## Objective",
    "",
    options.task.trim(),
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
    "",
    "## Stop Conditions",
    "",
    `- Max iterations: ${formatIterationLimit(options.maxIterations)}`,
    `- Timeout: ${options.timeoutMs}ms`,
    `- Consecutive failed required checks allowed: ${options.maxConsecutiveFailedChecks}`,
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
  maxConsecutiveFailedChecks: number;
  maxIterations: number;
  preferNonThinkingMode: boolean;
  requiredCheckCommand: string;
  requirePassingChecks: boolean;
  timeoutMs: number;
}): string {
  return [
    "Return exactly one JSON action per turn.",
    "",
    "Rules:",
    `- Use \`type: "tool"\` to request exactly one tool call, either a built-in tool or \`mcp.call\`.`,
    `- Use \`type: "final"\` only when the task is complete or blocked.`,
    `- Set \`stopWhenSuccessful: true\` only when running the required check \`${options.requiredCheckCommand}\` and the run should end immediately if it passes.`,
    `- The harness stops after ${formatIterationLimit(options.maxIterations)} Engineer iterations, ${options.timeoutMs}ms, or ${options.maxConsecutiveFailedChecks} consecutive failed required checks.`,
    `- Passing checks required: ${options.requirePassingChecks ? "yes" : "no"}.`,
    "- Built-in tool names always route to built-in tools. MCP is only available through `mcp.call`.",
    "- Keep tool use explicit and auditable.",
    ...(options.preferNonThinkingMode
      ? [
          "- Stay in non-thinking mode. Do not emit `<think>` blocks, hidden reasoning, or extra analysis outside the required JSON action.",
        ]
      : []),
    "- Ignore `.agent-harness`, `.git`, `node_modules`, and other generated or vendor paths unless the task explicitly depends on them.",
    "- Explore search-first: prefer `file.search` to locate symbols, strings, and likely files before using `file.list`.",
    "- Once search yields a few candidates, prefer `file.read_many` for a small batch snapshot instead of repeated one-file reads.",
    "- When you need initial context, prefer `README.md`, `package.json`, `docs/`, `src/`, and `test/` over broad root relisting.",
    "- Prefer converging quickly: after a few discovery steps, choose one concrete file and make the smallest reasonable change.",
    "- Do not reread the same file or relist the same directory unless the state changed or you need one specific missing detail.",
    "- If a path does not exist or a tool fails, adapt to that error instead of retrying the same invalid request.",
    "- Once you have enough context, stop exploring and either edit a file, run the required check, or return `final` if complete or blocked.",
  ].join("\n");
}

function formatIterationLimit(maxIterations: number): string {
  return Number.isFinite(maxIterations) ? `${maxIterations}` : "no fixed limit";
}

function shouldPreferNonThinkingMode(
  loadedConfig: LoadedHarnessConfig,
): boolean {
  return /qwen/i.test(loadedConfig.config.models.engineer.model);
}

function renderBuiltInToolsMarkdown(): string {
  return [
    "### `file.search`",
    "- Search file contents within a file or directory tree using a literal query. Prefer this over directory walking when you know what text you need.",
    '- Request shape: `{ "toolName": "file.search", "query": "createToolRouter", "path": "src", "limit": 8 }`',
    "",
    "### `file.read_many`",
    "- Read a few likely-relevant small files in one step. Prefer this over repeated `file.read` calls once search narrows the candidates.",
    '- Request shape: `{ "toolName": "file.read_many", "paths": ["src/example.ts", "test/example.test.ts"] }`',
    "",
    "### `file.list`",
    "- List directory entries when structure matters. Do not use directory listing as a stand-in for text search.",
    '- Request shape: `{ "toolName": "file.list", "path": "." }`',
    "",
    "### `file.read`",
    "- Read one specific file from the workspace after search or listing identifies it.",
    '- Request shape: `{ "toolName": "file.read", "path": "src/example.ts" }`',
    "",
    "### `file.write`",
    "- Write a file inside permitted workspace paths.",
    '- Request shape: `{ "toolName": "file.write", "path": "src/example.ts", "content": "..." }`',
    "",
    "### `command.execute`",
    "- Run one shell command through the configured execution target.",
    '- Request shape: `{ "toolName": "command.execute", "command": "npm test", "accessMode": "mutate" }`',
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

function getExplorationTarget(request: ToolRequest): string | undefined {
  switch (request.toolName) {
    case "file.search":
      return `${request.path ?? "."}:${request.query}`;
    case "file.read_many":
      return request.paths.join(",");
    case "file.list":
      return request.path ?? ".";
    case "file.read":
      return request.path;
    case "git.diff":
    case "git.status":
      return request.toolName;
    default:
      return undefined;
  }
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
