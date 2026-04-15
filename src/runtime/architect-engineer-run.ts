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
import { createProjectCommandRunner } from "../sandbox/command-runner.js";
import { createRunId } from "../artifacts/run-id.js";
import type { CreateMcpServerClient } from "../tools/mcp/client.js";

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MAX_CONSECUTIVE_FAILED_CHECKS = 5;

export interface ExecuteArchitectEngineerRunOptions {
  architectModelClient?: ArchitectRunModelClient;
  createdAt?: Date;
  engineerModelClient?: EngineerTaskModelClient;
  loadedConfig: LoadedHarnessConfig;
  maxConsecutiveFailedChecks?: number;
  mcpClientFactory?: CreateMcpServerClient;
  now?: () => Date;
  projectCommandRunner?: ProjectCommandRunnerLike;
  runId?: string;
  runProcess?: RunProcess;
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
    ...(options.mcpClientFactory === undefined
      ? {}
      : { mcpClientFactory: options.mcpClientFactory }),
    ...(options.runProcess === undefined
      ? {}
      : { runProcess: options.runProcess }),
  };
  const ownsProjectCommandRunner = options.projectCommandRunner === undefined;
  let projectCommandRunner = options.projectCommandRunner;

  if (projectCommandRunner !== undefined) {
    nodeContext.projectCommandRunner = projectCommandRunner;
  }

  try {
    while (state.nextNode !== "finalize") {
      const stopConditionOutcome = getStopConditionOutcome(state, now());

      if (stopConditionOutcome !== undefined && state.nextNode !== "prepare") {
        state = withFinalOutcome(state, stopConditionOutcome);
        break;
      }

      const nextNode = state.nextNode;

      if (
        projectCommandRunner === undefined &&
        nextNode !== "prepare" &&
        state.dossier !== undefined
      ) {
        projectCommandRunner = createProjectCommandRunner({
          dossierPaths: state.dossier.paths,
          loadedConfig: options.loadedConfig,
          now,
          ...(options.runProcess === undefined
            ? {}
            : { runProcess: options.runProcess }),
        });
        nodeContext.projectCommandRunner = projectCommandRunner;
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

      if (
        state.finalOutcome === undefined &&
        hasArchitectEngineerTimedOut(state, now())
      ) {
        state = withFinalOutcome(state, {
          status: "stopped",
          stopReason: "timeout",
          summary: `Run timed out after ${timeoutMs}ms.`,
        });
      }
    }

    state = await finalizeArchitectEngineerRunNode(state, nodeContext);

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
    if (ownsProjectCommandRunner && projectCommandRunner !== undefined) {
      projectCommandRunner.close();
    }
  }
}
