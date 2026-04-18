import { appendCommandLog } from "../runtime/run-dossier.js";
import type { HarnessEventBus } from "../runtime/harness-events.js";
import type { LoadedHarnessConfig } from "../types/config.js";
import type { CommandLogRecord } from "../types/run.js";
import type { RunDossierPaths } from "../artifacts/paths.js";
import type { RunProcess } from "./process-runner.js";
import {
  createDockerContainerSession,
  ContainerCommandCancelledError,
  type ContainerCommandEnvironment,
  ContainerCommandTimeoutError,
  type ContainerCommandResult,
  type ContainerSession,
} from "./container-session.js";
import { createHostCommandSession } from "./host-session.js";

export interface CommandExecutionRequest {
  command: string;
  environment?: ContainerCommandEnvironment;
  signal?: AbortSignal;
  timeoutMs?: number;
  workingDirectory?: string;
}

export interface EngineerCommandExecutionRequest extends CommandExecutionRequest {
  accessMode?: "inspect" | "mutate";
}

export interface CreateProjectCommandRunnerOptions {
  dossierPaths?: RunDossierPaths;
  eventBus?: HarnessEventBus;
  loadedConfig: LoadedHarnessConfig;
  now?: () => Date;
  runProcess?: RunProcess;
}

export interface ProjectCommandRunnerLike {
  close(reason?: string): void;
  executeAgentCommand?(
    request: EngineerCommandExecutionRequest,
  ): Promise<ContainerCommandResult>;
  executeArchitectCommand(
    request: CommandExecutionRequest,
  ): Promise<ContainerCommandResult>;
  executeEngineerCommand(
    request: EngineerCommandExecutionRequest,
  ): Promise<ContainerCommandResult>;
}

export class ProjectCommandRunner implements ProjectCommandRunnerLike {
  readonly #dossierPaths: RunDossierPaths | undefined;
  readonly #eventBus: HarnessEventBus | undefined;
  readonly #now: () => Date;
  readonly #session: ContainerSession;

  constructor(options: CreateProjectCommandRunnerOptions) {
    this.#dossierPaths = options.dossierPaths;
    this.#eventBus = options.eventBus;
    this.#now = options.now ?? (() => new Date());
    this.#session =
      options.loadedConfig.config.project.executionTarget === "docker"
        ? createDockerContainerSession({
            loadedConfig: options.loadedConfig,
            now: this.#now,
            ...(options.runProcess === undefined
              ? {}
              : { runProcess: options.runProcess }),
          })
        : createHostCommandSession({
            loadedConfig: options.loadedConfig,
            now: this.#now,
            ...(options.runProcess === undefined
              ? {}
              : { runProcess: options.runProcess }),
          });
  }

  get closed(): boolean {
    return this.#session.closed;
  }

  close(reason?: string): void {
    this.#session.close(reason);
  }

  async executeArchitectCommand(
    request: CommandExecutionRequest,
  ): Promise<ContainerCommandResult> {
    return this.#execute({
      accessMode: "inspect",
      command: request.command,
      role: "architect",
      ...(request.environment === undefined
        ? {}
        : { environment: request.environment }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.timeoutMs === undefined
        ? {}
        : { timeoutMs: request.timeoutMs }),
      ...(request.workingDirectory === undefined
        ? {}
        : { workingDirectory: request.workingDirectory }),
    });
  }

  async executeEngineerCommand(
    request: EngineerCommandExecutionRequest,
  ): Promise<ContainerCommandResult> {
    return this.#execute({
      accessMode: request.accessMode ?? "mutate",
      command: request.command,
      role: "engineer",
      ...(request.environment === undefined
        ? {}
        : { environment: request.environment }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.timeoutMs === undefined
        ? {}
        : { timeoutMs: request.timeoutMs }),
      ...(request.workingDirectory === undefined
        ? {}
        : { workingDirectory: request.workingDirectory }),
    });
  }

  async executeAgentCommand(
    request: EngineerCommandExecutionRequest,
  ): Promise<ContainerCommandResult> {
    return this.#execute({
      accessMode: request.accessMode ?? "mutate",
      command: request.command,
      role: "agent",
      ...(request.environment === undefined
        ? {}
        : { environment: request.environment }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.timeoutMs === undefined
        ? {}
        : { timeoutMs: request.timeoutMs }),
      ...(request.workingDirectory === undefined
        ? {}
        : { workingDirectory: request.workingDirectory }),
    });
  }

  async #execute(
    request: Parameters<ContainerSession["execute"]>[0],
  ): Promise<ContainerCommandResult> {
    const runId = this.#dossierPaths?.runId;
    const executionRequest = {
      ...request,
      onStderrChunk: (chunk: Buffer) => {
        this.#eventBus?.emit({
          type: "command:stderr",
          chunk: chunk.toString("utf8"),
          command: request.command,
          role: request.role,
          ...(runId === undefined ? {} : { runId }),
        });
      },
      onStdoutChunk: (chunk: Buffer) => {
        this.#eventBus?.emit({
          type: "command:stdout",
          chunk: chunk.toString("utf8"),
          command: request.command,
          role: request.role,
          ...(runId === undefined ? {} : { runId }),
        });
      },
    } satisfies Parameters<ContainerSession["execute"]>[0];

    this.#eventBus?.emit({
      type: "command:start",
      accessMode: request.accessMode,
      command: request.command,
      ...(Object.keys(request.environment ?? {}).length === 0
        ? {}
        : { environment: normalizeCommandEnvironment(request.environment) }),
      role: request.role,
      ...(runId === undefined ? {} : { runId }),
      ...(request.workingDirectory === undefined
        ? {}
        : { workingDirectory: request.workingDirectory }),
      timestamp: this.#now().toISOString(),
    });

    try {
      const result = await this.#session.execute(executionRequest);

      this.#eventBus?.emit({
        type: "command:end",
        accessMode: result.accessMode,
        command: result.command,
        ...(result.containerName === undefined
          ? {}
          : { containerName: result.containerName }),
        durationMs: result.durationMs,
        executionTarget: result.executionTarget,
        exitCode: result.exitCode,
        role: result.role,
        ...(runId === undefined ? {} : { runId }),
        status: "completed",
        timestamp: result.timestamp,
        workingDirectory: result.workingDirectory,
      });
      await this.#appendCommandLog({
        accessMode: result.accessMode,
        command: result.command,
        ...(result.containerName === undefined
          ? {}
          : { containerName: result.containerName }),
        durationMs: result.durationMs,
        environment: result.environment,
        executionTarget: result.executionTarget,
        exitCode: result.exitCode,
        role: result.role,
        status: "completed",
        stderr: result.stderr,
        stdout: result.stdout,
        timestamp: result.timestamp,
        workingDirectory: result.workingDirectory,
      });
      return result;
    } catch (error) {
      const commandLogRecord =
        error instanceof Error &&
        "commandLogRecord" in error &&
        error.commandLogRecord !== undefined
          ? (error.commandLogRecord as CommandLogRecord)
          : undefined;

      if (commandLogRecord !== undefined) {
        const errorStatus = normalizeCommandErrorStatus(
          commandLogRecord.status,
        );

        this.#eventBus?.emit({
          type: "command:error",
          accessMode: commandLogRecord.accessMode ?? request.accessMode,
          command: commandLogRecord.command,
          ...(commandLogRecord.containerName === undefined
            ? {}
            : { containerName: commandLogRecord.containerName }),
          durationMs: commandLogRecord.durationMs,
          errorName:
            error instanceof Error ? error.name : "CommandExecutionError",
          ...(commandLogRecord.executionTarget === undefined
            ? {}
            : { executionTarget: commandLogRecord.executionTarget }),
          exitCode: commandLogRecord.exitCode,
          message: error instanceof Error ? error.message : String(error),
          role: request.role,
          ...(runId === undefined ? {} : { runId }),
          status: errorStatus,
          timestamp: commandLogRecord.timestamp,
          ...(error instanceof ContainerCommandTimeoutError
            ? { timeoutMs: error.timeoutMs }
            : {}),
          ...(commandLogRecord.workingDirectory === undefined
            ? {}
            : { workingDirectory: commandLogRecord.workingDirectory }),
        });
      } else if (error instanceof Error) {
        this.#eventBus?.emit({
          type: "command:error",
          accessMode: request.accessMode,
          command: request.command,
          durationMs: 0,
          errorName: error.name,
          exitCode: null,
          message: error.message,
          role: request.role,
          ...(runId === undefined ? {} : { runId }),
          status:
            error instanceof ContainerCommandCancelledError
              ? "cancelled"
              : error instanceof ContainerCommandTimeoutError
                ? "timed-out"
                : "failed-to-start",
          timestamp: this.#now().toISOString(),
          ...(error instanceof ContainerCommandTimeoutError
            ? { timeoutMs: error.timeoutMs }
            : {}),
          ...(request.workingDirectory === undefined
            ? {}
            : { workingDirectory: request.workingDirectory }),
        });
      }

      if (
        error instanceof Error &&
        "commandLogRecord" in error &&
        error.commandLogRecord !== undefined
      ) {
        await this.#appendCommandLog(
          error.commandLogRecord as CommandLogRecord,
        );
      }

      throw error;
    }
  }

  async #appendCommandLog(commandLog: CommandLogRecord): Promise<void> {
    if (this.#dossierPaths === undefined) {
      return;
    }

    await appendCommandLog(this.#dossierPaths, commandLog);
  }
}

function normalizeCommandEnvironment(
  environment: ContainerCommandEnvironment | undefined,
): Record<string, string> {
  if (environment === undefined) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(environment)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => [name, String(value)]),
  );
}

function normalizeCommandErrorStatus(
  status: CommandLogRecord["status"] | undefined,
): "cancelled" | "failed-to-start" | "timed-out" {
  switch (status) {
    case "cancelled":
    case "timed-out":
      return status;
    case "completed":
    case "failed-to-start":
    default:
      return "failed-to-start";
  }
}

export function createProjectCommandRunner(
  options: CreateProjectCommandRunnerOptions,
): ProjectCommandRunner {
  return new ProjectCommandRunner(options);
}
