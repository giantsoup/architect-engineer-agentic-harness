import {
  createArchitectEngineerState,
  withFinalOutcome,
  type ArchitectEngineerState,
  type ArchitectEngineerStopReason,
} from "./architect-engineer-state.js";
import {
  getStopConditionOutcome,
  hasArchitectEngineerTimedOut,
} from "./architect-engineer-guards.js";
import {
  architectPlanningNode,
  architectReviewNode,
  engineerExecutionNode,
  finalizeArchitectEngineerRunNode,
  prepareArchitectEngineerRunNode,
  type ArchitectEngineerNodeContext,
  type ArchitectRunModelClient,
} from "./architect-engineer-nodes.js";
import type { LoadedHarnessConfig } from "../types/config.js";
import type { ProjectCommandRunnerLike } from "../sandbox/command-runner.js";
import type { RunProcess } from "../sandbox/process-runner.js";
import type { EngineerTaskModelClient } from "./engineer-task.js";
import type { RunDossier } from "./run-dossier.js";
import type { RunResult } from "../types/run.js";
import type { HarnessEventBus } from "./harness-events.js";
import { createProjectCommandRunner } from "../sandbox/command-runner.js";
import { createRunId } from "../artifacts/run-id.js";
import type { CreateMcpServerClient } from "../tools/mcp/client.js";

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MAX_CONSECUTIVE_FAILED_CHECKS = 5;

export interface ExecuteArchitectEngineerRunOptions {
  architectModelClient?: ArchitectRunModelClient;
  createdAt?: Date;
  engineerModelClient?: EngineerTaskModelClient;
  eventBus?: HarnessEventBus;
  loadedConfig: LoadedHarnessConfig;
  maxConsecutiveFailedChecks?: number;
  mcpClientFactory?: CreateMcpServerClient;
  now?: () => Date;
  projectCommandRunner?: ProjectCommandRunnerLike;
  runId?: string;
  runProcess?: RunProcess;
  signal?: AbortSignal;
  task: string;
  timeoutMs?: number;
}

export interface ArchitectEngineerRunExecution {
  dossier: RunDossier;
  result: RunResult;
  state: ArchitectEngineerState;
  stopReason: ArchitectEngineerStopReason;
}

export async function executeArchitectEngineerRun(
  options: ExecuteArchitectEngineerRunOptions,
): Promise<ArchitectEngineerRunExecution> {
  const now = options.now ?? (() => new Date());
  const createdAt = options.createdAt ?? now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxConsecutiveFailedChecks =
    options.maxConsecutiveFailedChecks ?? DEFAULT_MAX_CONSECUTIVE_FAILED_CHECKS;
  const runId = options.runId ?? createRunId({ date: createdAt });
  let state = createArchitectEngineerState({
    createdAt,
    maxConsecutiveFailedRequiredChecks: maxConsecutiveFailedChecks,
    runId,
    task: options.task,
    timeoutMs,
  });
  const nodeContext: ArchitectEngineerNodeContext = {
    loadedConfig: options.loadedConfig,
    now,
    ...(options.architectModelClient === undefined
      ? {}
      : { architectModelClient: options.architectModelClient }),
    ...(options.engineerModelClient === undefined
      ? {}
      : { engineerModelClient: options.engineerModelClient }),
    ...(options.eventBus === undefined ? {} : { eventBus: options.eventBus }),
    ...(options.mcpClientFactory === undefined
      ? {}
      : { mcpClientFactory: options.mcpClientFactory }),
    ...(options.runProcess === undefined
      ? {}
      : { runProcess: options.runProcess }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const ownsProjectCommandRunner = options.projectCommandRunner === undefined;
  let projectCommandRunner = options.projectCommandRunner;
  const handleAbort = () => {
    projectCommandRunner?.close("run cancelled by user request");
  };

  if (projectCommandRunner !== undefined) {
    nodeContext.projectCommandRunner = projectCommandRunner;
  }

  try {
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    while (state.nextNode !== "finalize") {
      if (options.signal?.aborted === true) {
        const cancelledOutcome = createCancelledOutcome();

        state = withFinalOutcome(state, cancelledOutcome);
        emitRunStatus(
          options.eventBus,
          state.metadata.runId,
          state.nextNode,
          cancelledOutcome.status,
          cancelledOutcome.summary,
          cancelledOutcome.stopReason,
          now().toISOString(),
        );
        break;
      }

      const stopConditionOutcome = getStopConditionOutcome(state, now());

      if (stopConditionOutcome !== undefined && state.nextNode !== "prepare") {
        state = withFinalOutcome(state, stopConditionOutcome);
        emitRunStatus(
          options.eventBus,
          state.metadata.runId,
          state.nextNode,
          stopConditionOutcome.status,
          stopConditionOutcome.summary,
          stopConditionOutcome.stopReason,
          now().toISOString(),
        );
        break;
      }

      const nextNode = state.nextNode;
      const loopTimestamp = now().toISOString();

      emitRunStatus(
        options.eventBus,
        state.metadata.runId,
        nextNode,
        nextNode === "prepare" ? "initialized" : "running",
        describeNodeStatus(nextNode),
        undefined,
        loopTimestamp,
      );
      emitAgentStatus(
        options.eventBus,
        state,
        nextNode,
        "active",
        loopTimestamp,
      );

      if (
        projectCommandRunner === undefined &&
        nextNode !== "prepare" &&
        state.dossier !== undefined
      ) {
        projectCommandRunner = createProjectCommandRunner({
          dossierPaths: state.dossier.paths,
          ...(options.eventBus === undefined
            ? {}
            : { eventBus: options.eventBus }),
          loadedConfig: options.loadedConfig,
          now,
          ...(options.runProcess === undefined
            ? {}
            : { runProcess: options.runProcess }),
        });
        nodeContext.projectCommandRunner = projectCommandRunner;

        if (options.signal?.aborted) {
          projectCommandRunner.close("run cancelled by user request");
        }
      }

      switch (nextNode) {
        case "prepare":
          state = await prepareArchitectEngineerRunNode(state, nodeContext);
          break;
        case "plan":
          state = await architectPlanningNode(state, nodeContext);
          break;
        case "execute":
          state = await engineerExecutionNode(state, nodeContext);
          break;
        case "review":
          state = await architectReviewNode(state, nodeContext);
          break;
      }

      emitAgentStatus(
        options.eventBus,
        state,
        nextNode,
        "completed",
        now().toISOString(),
      );

      if (options.signal?.aborted) {
        state = withFinalOutcome(state, createCancelledOutcome());
      }

      if (
        state.finalOutcome === undefined &&
        hasArchitectEngineerTimedOut(state, now())
      ) {
        state = withFinalOutcome(state, {
          status: "stopped",
          stopReason: "timeout",
          summary: `Run timed out after ${timeoutMs}ms.`,
        });
        const timeoutOutcome = state.finalOutcome;

        emitRunStatus(
          options.eventBus,
          state.metadata.runId,
          state.nextNode,
          timeoutOutcome?.status ?? "stopped",
          timeoutOutcome?.summary,
          timeoutOutcome?.stopReason,
          now().toISOString(),
        );
      }
    }

    state = await finalizeArchitectEngineerRunNode(state, nodeContext);
    emitRunStatus(
      options.eventBus,
      state.metadata.runId,
      "finalize",
      state.finalOutcome?.status ?? "stopped",
      state.finalOutcome?.summary ??
        `Run timed out after ${state.metadata.timeoutMs}ms.`,
      state.finalOutcome?.stopReason,
      now().toISOString(),
    );

    return {
      dossier: state.dossier!,
      result: {
        artifacts: [
          state.dossier!.paths.files.run.relativePath,
          state.dossier!.paths.files.events.relativePath,
          state.dossier!.paths.files.commandLog.relativePath,
          state.dossier!.paths.files.architectPlan.relativePath,
          state.dossier!.paths.files.engineerTask.relativePath,
          state.dossier!.paths.files.architectReview.relativePath,
          state.dossier!.paths.files.checks.relativePath,
          state.dossier!.paths.files.diff.relativePath,
          state.dossier!.paths.files.finalReport.relativePath,
          state.dossier!.paths.files.result.relativePath,
          ...(state.failureNotes.length === 0 ||
          state.finalOutcome?.status === "success"
            ? []
            : [state.dossier!.paths.files.failureNotes.relativePath]),
        ],
        ...(state.engineerExecution?.result.convergence === undefined
          ? {}
          : { convergence: state.engineerExecution.result.convergence }),
        git: state.git,
        status: state.finalOutcome?.status ?? "stopped",
        summary:
          state.finalOutcome?.summary ??
          `Run timed out after ${state.metadata.timeoutMs}ms.`,
      },
      state,
      stopReason: state.finalOutcome?.stopReason ?? "timeout",
    };
  } finally {
    options.signal?.removeEventListener("abort", handleAbort);
    if (ownsProjectCommandRunner && projectCommandRunner !== undefined) {
      projectCommandRunner.close();
    }
  }
}

function createCancelledOutcome() {
  return {
    status: "stopped" as const,
    stopReason: "cancelled" as const,
    summary: "Run cancelled by user request.",
  };
}

function describeNodeStatus(
  nextNode: ArchitectEngineerState["nextNode"],
): string {
  switch (nextNode) {
    case "prepare":
      return "Preparing run dossier.";
    case "plan":
      return "Architect planning in progress.";
    case "execute":
      return "Engineer execution in progress.";
    case "review":
      return "Architect review in progress.";
    case "finalize":
      return "Finalizing run.";
  }
}

function emitRunStatus(
  eventBus: HarnessEventBus | undefined,
  runId: string,
  phase: ArchitectEngineerState["nextNode"],
  status: RunResult["status"] | "initialized" | "running" | "stopped",
  summary: string | undefined,
  stopReason: ArchitectEngineerStopReason | undefined,
  timestamp: string,
): void {
  eventBus?.emit({
    type: "run:status",
    phase,
    runId,
    status,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(summary === undefined ? {} : { summary }),
    timestamp,
  });
}

function emitAgentStatus(
  eventBus: HarnessEventBus | undefined,
  state: ArchitectEngineerState,
  phase: ArchitectEngineerState["nextNode"],
  status: "active" | "completed",
  timestamp: string,
): void {
  if (phase !== "plan" && phase !== "execute" && phase !== "review") {
    return;
  }

  if (phase === "plan") {
    eventBus?.emit({
      type: "agent:update",
      agent: "architect",
      phase,
      runId: state.metadata.runId,
      status,
      summary:
        status === "completed"
          ? (state.architectPlan?.summary ?? "Architect planning finished.")
          : "Architect planning in progress.",
      timestamp,
    });
    return;
  }

  if (phase === "execute") {
    eventBus?.emit({
      type: "agent:update",
      agent: "engineer",
      iteration:
        state.iterations.engineerAttempts + (status === "active" ? 1 : 0),
      phase,
      runId: state.metadata.runId,
      status,
      summary:
        status === "completed"
          ? (state.engineerExecution?.result.summary ??
            "Engineer execution finished.")
          : "Engineer execution in progress.",
      timestamp,
    });
    return;
  }

  eventBus?.emit({
    type: "agent:update",
    agent: "architect",
    iteration: state.iterations.reviewCycles + (status === "active" ? 1 : 0),
    phase,
    runId: state.metadata.runId,
    status,
    summary:
      status === "completed"
        ? (state.architectReview?.summary ?? "Architect review finished.")
        : "Architect review in progress.",
    timestamp,
  });
}
