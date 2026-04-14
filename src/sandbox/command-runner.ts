import { appendCommandLog } from "../runtime/run-dossier.js";
import type { LoadedHarnessConfig } from "../types/config.js";
import type { CommandLogRecord } from "../types/run.js";
import type { RunDossierPaths } from "../artifacts/paths.js";
import {
  createDockerContainerSession,
  type ContainerCommandEnvironment,
  type ContainerCommandResult,
  type ContainerSession,
  type CreateDockerContainerSessionOptions,
} from "./container-session.js";

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

export interface CreateProjectCommandRunnerOptions extends Omit<
  CreateDockerContainerSessionOptions,
  "loadedConfig"
> {
  dossierPaths?: RunDossierPaths;
  loadedConfig: LoadedHarnessConfig;
}

export interface ProjectCommandRunnerLike {
  close(reason?: string): void;
  executeArchitectCommand(
    request: CommandExecutionRequest,
  ): Promise<ContainerCommandResult>;
  executeEngineerCommand(
    request: EngineerCommandExecutionRequest,
  ): Promise<ContainerCommandResult>;
}

export class ProjectCommandRunner implements ProjectCommandRunnerLike {
  readonly #dossierPaths: RunDossierPaths | undefined;
  readonly #session: ContainerSession;

  constructor(options: CreateProjectCommandRunnerOptions) {
    this.#dossierPaths = options.dossierPaths;
    this.#session = createDockerContainerSession({
      loadedConfig: options.loadedConfig,
      ...(options.now === undefined ? {} : { now: options.now }),
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

  async #execute(
    request: Parameters<ContainerSession["execute"]>[0],
  ): Promise<ContainerCommandResult> {
    try {
      const result = await this.#session.execute(request);
      await this.#appendCommandLog({
        accessMode: result.accessMode,
        command: result.command,
        containerName: result.containerName,
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

export function createProjectCommandRunner(
  options: CreateProjectCommandRunnerOptions,
): ProjectCommandRunner {
  return new ProjectCommandRunner(options);
}
