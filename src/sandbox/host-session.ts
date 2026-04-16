import path from "node:path";
import { stat } from "node:fs/promises";

import type { LoadedHarnessConfig } from "../types/config.js";
import type { CommandLogRecord } from "../types/run.js";
import {
  ContainerCommandCancelledError,
  ContainerCommandTimeoutError,
  ContainerRuntimeError,
  ContainerSessionConfigError,
  ContainerSessionError,
  ContainerSessionStateError,
  type ContainerCommandEnvironment,
  type ContainerCommandRequest,
  type ContainerCommandResult,
  type ContainerSession,
  type ContainerSessionMetadata,
  type CreateDockerContainerSessionOptions,
} from "./container-session.js";
import {
  ProcessCancelledError,
  ProcessSpawnError,
  ProcessTimeoutError,
  runProcessCommand,
  type RunProcess,
} from "./process-runner.js";

const DEFAULT_HOST_WORKING_DIRECTORY = ".";
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export type CreateHostCommandSessionOptions =
  CreateDockerContainerSessionOptions;

export function createHostCommandSession(
  options: CreateHostCommandSessionOptions,
): ContainerSession {
  return new HostCommandSession(options);
}

class HostCommandSession implements ContainerSession {
  readonly #loadedConfig: LoadedHarnessConfig;
  readonly #now: () => Date;
  readonly #runProcess: RunProcess;
  readonly #closeController = new AbortController();
  readonly #activeCommandControllers = new Set<AbortController>();
  readonly #metadata: ContainerSessionMetadata;
  #closed = false;

  constructor(options: CreateHostCommandSessionOptions) {
    validateHostExecutionTarget(options.loadedConfig);

    this.#loadedConfig = options.loadedConfig;
    this.#now = options.now ?? (() => new Date());
    this.#runProcess = options.runProcess ?? runProcessCommand;
    this.#metadata = {
      defaultWorkingDirectory: path.resolve(
        this.#loadedConfig.projectRoot,
        DEFAULT_HOST_WORKING_DIRECTORY,
      ),
      executionTarget: "host",
    };
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(reason?: string): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#closeController.abort(
      reason ?? "Host command session closed before command completion.",
    );

    for (const controller of this.#activeCommandControllers) {
      controller.abort(reason ?? "Host command session closed.");
    }
  }

  async getMetadata(): Promise<ContainerSessionMetadata> {
    this.#assertOpen();
    return this.#metadata;
  }

  async execute(
    command: ContainerCommandRequest,
  ): Promise<ContainerCommandResult> {
    this.#assertOpen();
    validateCommandRequest(command);

    const environment = normalizeCommandEnvironment(command.environment);
    const pendingCommandContext = {
      accessMode: command.accessMode,
      command: command.command,
      environment,
      executionTarget: "host" as const,
      role: command.role,
      workingDirectory:
        command.workingDirectory?.trim() ??
        this.#metadata.defaultWorkingDirectory,
    } as const;

    if (command.signal?.aborted === true) {
      throw new ContainerCommandCancelledError(
        "Command was cancelled before host execution started.",
        createCommandLogRecord(pendingCommandContext, {
          durationMs: 0,
          exitCode: null,
          status: "cancelled",
          timestamp: this.#now().toISOString(),
        }),
      );
    }

    const workingDirectory = resolveHostWorkingDirectory(
      this.#loadedConfig.projectRoot,
      command.workingDirectory,
    );
    const commandContext = {
      ...pendingCommandContext,
      workingDirectory,
    } as const;

    await assertWorkingDirectory(workingDirectory, commandContext, this.#now);

    const commandController = new AbortController();
    const signal = AbortSignal.any(
      [
        command.signal,
        this.#closeController.signal,
        commandController.signal,
      ].filter(
        (nextSignal): nextSignal is AbortSignal => nextSignal !== undefined,
      ),
    );

    this.#activeCommandControllers.add(commandController);

    try {
      const result = await this.#runProcess({
        args: buildHostExecArgs(command.command),
        cwd: workingDirectory,
        env: {
          ...process.env,
          ...environment,
        },
        file: resolveHostShellFile(),
        ...(command.onStderrChunk === undefined
          ? {}
          : { onStderrChunk: command.onStderrChunk }),
        ...(command.onStdoutChunk === undefined
          ? {}
          : { onStdoutChunk: command.onStdoutChunk }),
        signal,
        ...(command.timeoutMs === undefined
          ? {}
          : { timeoutMs: command.timeoutMs }),
      });

      return {
        ...commandContext,
        durationMs: result.durationMs,
        exitCode: result.exitCode ?? 0,
        stderr: result.stderr,
        stdout: result.stdout,
        timestamp: this.#now().toISOString(),
      };
    } catch (error) {
      if (error instanceof ContainerSessionError) {
        throw error;
      }

      if (error instanceof ProcessTimeoutError) {
        throw new ContainerCommandTimeoutError(
          `Command exceeded timeout on the host after ${command.timeoutMs}ms.`,
          command.timeoutMs ?? 0,
          createCommandLogRecord(commandContext, {
            durationMs: error.result.durationMs,
            exitCode: error.result.exitCode,
            status: "timed-out",
            stderr: error.result.stderr,
            stdout: error.result.stdout,
            timestamp: this.#now().toISOString(),
          }),
        );
      }

      if (error instanceof ProcessCancelledError) {
        throw new ContainerCommandCancelledError(
          this.#closeController.signal.aborted
            ? "Command was cancelled because the host command session was closed."
            : "Command was cancelled on the host.",
          createCommandLogRecord(commandContext, {
            durationMs: error.result.durationMs,
            exitCode: error.result.exitCode,
            status: "cancelled",
            stderr: error.result.stderr,
            stdout: error.result.stdout,
            timestamp: this.#now().toISOString(),
          }),
        );
      }

      if (error instanceof ProcessSpawnError) {
        throw new ContainerRuntimeError(
          `Could not start the host shell for command execution: ${describeError(error)}`,
          createCommandLogRecord(commandContext, {
            durationMs: error.result.durationMs,
            exitCode: error.result.exitCode,
            status: "failed-to-start",
            stderr: error.result.stderr,
            stdout: error.result.stdout,
            timestamp: this.#now().toISOString(),
          }),
        );
      }

      throw error;
    } finally {
      this.#activeCommandControllers.delete(commandController);
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ContainerSessionStateError(
        "Host command session is closed and cannot run additional commands.",
      );
    }
  }
}

function resolveHostShellFile(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec?.trim() || "cmd.exe";
  }

  return "sh";
}

function buildHostExecArgs(command: string): string[] {
  if (process.platform === "win32") {
    return ["/d", "/s", "/c", command];
  }

  return ["-lc", command];
}

function resolveHostWorkingDirectory(
  projectRoot: string,
  workingDirectory: string | undefined,
): string {
  return path.resolve(
    projectRoot,
    workingDirectory?.trim() || DEFAULT_HOST_WORKING_DIRECTORY,
  );
}

async function assertWorkingDirectory(
  workingDirectory: string,
  context: Omit<
    ContainerCommandResult,
    "durationMs" | "exitCode" | "stderr" | "stdout" | "timestamp"
  >,
  now: () => Date,
): Promise<void> {
  try {
    const workingDirectoryStats = await stat(workingDirectory);

    if (!workingDirectoryStats.isDirectory()) {
      throw new ContainerSessionConfigError(
        `Host working directory \`${workingDirectory}\` is not a directory.`,
        createCommandLogRecord(context, {
          durationMs: 0,
          exitCode: null,
          status: "failed-to-start",
          timestamp: now().toISOString(),
        }),
      );
    }
  } catch (error) {
    if (error instanceof ContainerSessionError) {
      throw error;
    }

    const maybeNodeError = error as NodeJS.ErrnoException;

    if (maybeNodeError.code === "ENOENT") {
      throw new ContainerSessionConfigError(
        `Host working directory \`${workingDirectory}\` does not exist.`,
        createCommandLogRecord(context, {
          durationMs: 0,
          exitCode: null,
          status: "failed-to-start",
          timestamp: now().toISOString(),
        }),
      );
    }

    throw new ContainerRuntimeError(
      `Could not access host working directory \`${workingDirectory}\`: ${describeError(error)}`,
      createCommandLogRecord(context, {
        durationMs: 0,
        exitCode: null,
        status: "failed-to-start",
        timestamp: now().toISOString(),
      }),
    );
  }
}

function createCommandLogRecord(
  context: Omit<
    ContainerCommandResult,
    "durationMs" | "exitCode" | "stderr" | "stdout" | "timestamp"
  >,
  details: {
    durationMs: number;
    exitCode: number | null;
    status: "cancelled" | "completed" | "failed-to-start" | "timed-out";
    stderr?: string;
    stdout?: string;
    timestamp: string;
  },
): CommandLogRecord {
  return {
    accessMode: context.accessMode,
    command: context.command,
    ...(context.containerName === undefined
      ? {}
      : { containerName: context.containerName }),
    durationMs: details.durationMs,
    environment: context.environment,
    executionTarget: context.executionTarget,
    exitCode: details.exitCode,
    role: context.role,
    status: details.status,
    timestamp: details.timestamp,
    workingDirectory: context.workingDirectory,
    ...(details.stderr === undefined ? {} : { stderr: details.stderr }),
    ...(details.stdout === undefined ? {} : { stdout: details.stdout }),
  };
}

function normalizeCommandEnvironment(
  environment?: ContainerCommandEnvironment,
): Record<string, string> {
  const normalizedEnvironment: Record<string, string> = {};

  for (const [name, value] of Object.entries(environment ?? {})) {
    if (value === undefined) {
      continue;
    }

    if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
      throw new ContainerSessionConfigError(
        `Invalid environment variable name \`${name}\`. Use shell-compatible names only.`,
      );
    }

    normalizedEnvironment[name] = String(value);
  }

  return normalizedEnvironment;
}

function validateCommandRequest(command: ContainerCommandRequest): void {
  if (command.command.trim().length === 0) {
    throw new ContainerSessionConfigError("Command must not be empty.");
  }

  if (
    command.timeoutMs !== undefined &&
    (!Number.isInteger(command.timeoutMs) || command.timeoutMs <= 0)
  ) {
    throw new ContainerSessionConfigError(
      "timeoutMs must be a positive integer when provided.",
    );
  }

  if (
    command.workingDirectory !== undefined &&
    command.workingDirectory.trim().length === 0
  ) {
    throw new ContainerSessionConfigError(
      "workingDirectory must not be empty.",
    );
  }
}

function validateHostExecutionTarget(loadedConfig: LoadedHarnessConfig): void {
  if (loadedConfig.config.project.executionTarget !== "host") {
    throw new ContainerSessionConfigError(
      `Host command session requires \`project.executionTarget = "host"\`, received \`${loadedConfig.config.project.executionTarget}\`.`,
    );
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
