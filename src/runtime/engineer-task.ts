import { readFile } from "node:fs/promises";

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
import {
  createBuiltInToolExecutor,
  type BuiltInToolExecutor,
} from "../tools/built-in-tools.js";
import type { BuiltInToolRequest, BuiltInToolResult } from "../tools/types.js";
import { BuiltInToolError } from "../tools/errors.js";
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
}

interface FinalizedOutcome {
  blockedNotes?: string[] | undefined;
  status: RunResult["status"];
  stopReason: EngineerTaskStopReason;
  summary: string;
}

interface WorkspaceArtifactCollection {
  diff: Extract<BuiltInToolResult, { toolName: "git.diff" }> | undefined;
  notes: string[];
  status: Extract<BuiltInToolResult, { toolName: "git.status" }> | undefined;
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
  const taskBrief = renderEngineerTaskBrief({
    loadedConfig: options.loadedConfig,
    maxConsecutiveFailedChecks:
      options.maxConsecutiveFailedChecks ??
      options.loadedConfig.config.stopConditions.maxEngineerAttempts,
    maxIterations:
      options.maxIterations ??
      options.loadedConfig.config.stopConditions.maxIterations,
    task: options.task,
    timeoutMs: options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
  });
  const requiredCheckCommand = options.loadedConfig.config.commands.test;
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
      ? createBuiltInToolExecutor({
          dossierPaths: dossier.paths,
          loadedConfig: options.loadedConfig,
          now,
          ...(options.runProcess === undefined
            ? {}
            : { runProcess: options.runProcess }),
        })
      : createBuiltInToolExecutor({
          dossierPaths: dossier.paths,
          loadedConfig: options.loadedConfig,
          now,
          projectCommandRunner: options.projectCommandRunner,
          ...(options.runProcess === undefined
            ? {}
            : { runProcess: options.runProcess }),
        });

  try {
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
      requiredCheckCommand,
      requirePassingChecks,
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

        outcome = {
          status: "failed",
          stopReason: "model-error",
          summary: `Engineer model request failed: ${message}`,
        };
        break;
      }

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
        content: JSON.stringify(toolFeedback),
        name: toolRequest.toolName,
        role: "tool",
      });

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
      now,
      outcome,
      persistFinalArtifacts: options.persistFinalArtifacts ?? true,
      requiredCheckCommand,
      requirePassingChecks,
      task: options.task,
      toolExecutor,
    });
  } finally {
    toolExecutor.close();
  }
}

async function finalizeEngineerRun(options: {
  checks: RunCheckResult[];
  consecutiveFailedChecks: number;
  dossier: RunDossier;
  iterationCount: number;
  now: () => Date;
  outcome: FinalizedOutcome;
  persistFinalArtifacts: boolean;
  requiredCheckCommand: string;
  requirePassingChecks: boolean;
  task: string;
  toolExecutor: BuiltInToolExecutor;
}): Promise<EngineerTaskExecution> {
  const finalizedAt = options.now().toISOString();
  const workspaceArtifacts = await collectWorkspaceArtifacts(
    options.toolExecutor,
  );
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
      requiredCheckCommand: options.requiredCheckCommand,
      requirePassingChecks: options.requirePassingChecks,
      runDir: options.dossier.paths.runDirRelativePath,
      task: options.task,
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
  };
}

async function executeEngineerTool(options: {
  executor: BuiltInToolExecutor;
  request: BuiltInToolRequest;
}): Promise<
  | {
      ok: false;
      toolName: string;
      error: { code: string; message: string; name: string };
    }
  | { ok: true; toolName: string; result: BuiltInToolResult }
> {
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
    if (error instanceof BuiltInToolError) {
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
      `Unexpected built-in tool failure for ${options.request.toolName}: ${message}`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

async function collectWorkspaceArtifacts(
  executor: BuiltInToolExecutor,
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
  executor: BuiltInToolExecutor,
  request: BuiltInToolRequest,
  notes: string[],
  context: string,
): Promise<BuiltInToolResult | undefined> {
  try {
    return await executor.execute({ role: "engineer" }, request);
  } catch (error) {
    if (error instanceof BuiltInToolError) {
      notes.push(`${context}: ${error.message}`);
      return undefined;
    }

    const message = error instanceof Error ? error.message : String(error);

    notes.push(`${context}: ${message}`);
    return undefined;
  }
}

function applyRemainingTimeToToolRequest(
  request: BuiltInToolRequest,
  remainingTimeMs: number,
): BuiltInToolRequest {
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

function isRequiredCheckCommand(
  request: BuiltInToolRequest,
  requiredCheckCommand: string,
): boolean {
  return (
    request.toolName === "command.execute" &&
    normalizeCommand(request.command) === normalizeCommand(requiredCheckCommand)
  );
}

function toCheckResult(
  feedback:
    | {
        ok: false;
        toolName: string;
        error: { code: string; message: string; name: string };
      }
    | { ok: true; toolName: string; result: BuiltInToolResult },
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

function renderFinalReport(options: {
  checks: RunCheckResult[];
  diffPath: string;
  failureNotesPath?: string | undefined;
  gitStatus: Extract<BuiltInToolResult, { toolName: "git.status" }> | undefined;
  outcome: FinalizedOutcome;
  requiredCheckCommand: string;
  requirePassingChecks: boolean;
  runDir: string;
  task: string;
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
}): string {
  const builtInTools = renderBuiltInToolsMarkdown();

  return [
    "# Engineer Task Brief",
    "",
    "## Objective",
    "",
    options.task.trim(),
    "",
    "## Required Check",
    "",
    `Run \`${options.loadedConfig.config.commands.test}\` through \`command.execute\` before final completion when passing checks are required.`,
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
  ].join("\n");
}

function renderEngineerProtocol(options: {
  maxConsecutiveFailedChecks: number;
  maxIterations: number;
  requiredCheckCommand: string;
  requirePassingChecks: boolean;
  timeoutMs: number;
}): string {
  return [
    "Return exactly one JSON action per turn.",
    "",
    "Rules:",
    `- Use \`type: "tool"\` to request exactly one built-in tool.`,
    `- Use \`type: "final"\` only when the task is complete or blocked.`,
    `- Set \`stopWhenSuccessful: true\` only when running the required check \`${options.requiredCheckCommand}\` and the run should end immediately if it passes.`,
    `- The harness stops after ${formatIterationLimit(options.maxIterations)} Engineer iterations, ${options.timeoutMs}ms, or ${options.maxConsecutiveFailedChecks} consecutive failed required checks.`,
    `- Passing checks required: ${options.requirePassingChecks ? "yes" : "no"}.`,
    "- Keep tool use explicit and auditable.",
  ].join("\n");
}

function formatIterationLimit(maxIterations: number): string {
  return Number.isFinite(maxIterations) ? `${maxIterations}` : "no fixed limit";
}

function renderBuiltInToolsMarkdown(): string {
  return [
    "### `file.list`",
    "- List directory entries.",
    '- Request shape: `{ "toolName": "file.list", "path": "." }`',
    "",
    "### `file.read`",
    "- Read a file from the workspace.",
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
