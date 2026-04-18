import type { LoadedHarnessConfig } from "../types/config.js";
import type { CommandLogRecord } from "../types/run.js";
import {
  ProcessCancelledError,
  type ProcessOutputObserver,
  ProcessSpawnError,
  ProcessTimeoutError,
  runProcessCommand,
  type RunProcess,
} from "./process-runner.js";

export type ContainerCommandRole = "agent" | "architect" | "engineer";
export type ContainerCommandAccessMode = "inspect" | "mutate";

export interface ContainerCommandEnvironment {
  [key: string]: boolean | number | string | undefined;
}

export interface ContainerCommandRequest {
  accessMode: ContainerCommandAccessMode;
  command: string;
  environment?: ContainerCommandEnvironment;
  onStderrChunk?: ProcessOutputObserver;
  onStdoutChunk?: ProcessOutputObserver;
  role: ContainerCommandRole;
  signal?: AbortSignal;
  timeoutMs?: number;
  workingDirectory?: string;
}

export interface ContainerCommandResult {
  accessMode: ContainerCommandAccessMode;
  command: string;
  containerName?: string;
  durationMs: number;
  environment: Record<string, string>;
  executionTarget: "docker" | "host";
  exitCode: number;
  role: ContainerCommandRole;
  stderr: string;
  stdout: string;
  timestamp: string;
  workingDirectory: string;
}

export interface ContainerSessionMetadata {
  containerName?: string;
  defaultWorkingDirectory: string;
  executionTarget: "docker" | "host";
}

export interface CreateDockerContainerSessionOptions {
  loadedConfig: LoadedHarnessConfig;
  now?: () => Date;
  runProcess?: RunProcess;
}

export interface ContainerSession {
  readonly closed: boolean;
  close(reason?: string): void;
  execute(command: ContainerCommandRequest): Promise<ContainerCommandResult>;
  getMetadata(): Promise<ContainerSessionMetadata>;
}

interface DockerInspectRecord {
  Config?: {
    WorkingDir?: string;
  };
  State?: {
    Running?: boolean;
  };
}

const DEFAULT_CONTAINER_WORKING_DIRECTORY = "/";
const DEFAULT_INSPECT_TIMEOUT_MS = 10_000;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export class ContainerSessionError extends Error {
  readonly commandLogRecord: CommandLogRecord | undefined;

  constructor(message: string, commandLogRecord?: CommandLogRecord) {
    super(message);

    this.name = "ContainerSessionError";
    this.commandLogRecord = commandLogRecord;
  }
}

export class ContainerSessionConfigError extends ContainerSessionError {
  constructor(message: string, commandLogRecord?: CommandLogRecord) {
    super(message, commandLogRecord);

    this.name = "ContainerSessionConfigError";
  }
}

export class ContainerSessionStateError extends ContainerSessionError {
  constructor(message: string, commandLogRecord?: CommandLogRecord) {
    super(message, commandLogRecord);

    this.name = "ContainerSessionStateError";
  }
}

export class ContainerNotFoundError extends ContainerSessionError {
  constructor(message: string, commandLogRecord?: CommandLogRecord) {
    super(message, commandLogRecord);

    this.name = "ContainerNotFoundError";
  }
}

export class ContainerRuntimeError extends ContainerSessionError {
  constructor(message: string, commandLogRecord?: CommandLogRecord) {
    super(message, commandLogRecord);

    this.name = "ContainerRuntimeError";
  }
}

export class ContainerCommandTimeoutError extends ContainerSessionError {
  readonly timeoutMs: number;

  constructor(
    message: string,
    timeoutMs: number,
    commandLogRecord?: CommandLogRecord,
  ) {
    super(message, commandLogRecord);

    this.name = "ContainerCommandTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class ContainerCommandCancelledError extends ContainerSessionError {
  constructor(message: string, commandLogRecord?: CommandLogRecord) {
    super(message, commandLogRecord);

    this.name = "ContainerCommandCancelledError";
  }
}

export function createDockerContainerSession(
  options: CreateDockerContainerSessionOptions,
): ContainerSession {
  return new DockerContainerSession(options);
}

export function buildDockerExecArgs(options: {
  command: string;
  containerName: string;
  environment?: Record<string, string>;
  workingDirectory: string;
}): string[] {
  const args = ["exec", "--workdir", options.workingDirectory];

  for (const [name, value] of Object.entries(options.environment ?? {})) {
    args.push("--env", `${name}=${value}`);
  }

  args.push(options.containerName, "sh", "-lc", options.command);
  return args;
}

class DockerContainerSession implements ContainerSession {
  readonly #loadedConfig: LoadedHarnessConfig;
  readonly #now: () => Date;
  readonly #runProcess: RunProcess;
  readonly #closeController = new AbortController();
  readonly #activeCommandControllers = new Set<AbortController>();
  #closed = false;
  #metadataPromise?: Promise<ContainerSessionMetadata>;

  constructor(options: CreateDockerContainerSessionOptions) {
    validateDockerExecutionTarget(options.loadedConfig);

    this.#loadedConfig = options.loadedConfig;
    this.#now = options.now ?? (() => new Date());
    this.#runProcess = options.runProcess ?? runProcessCommand;
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
      reason ?? "Container session closed before command completion.",
    );

    for (const controller of this.#activeCommandControllers) {
      controller.abort(reason ?? "Container session closed.");
    }
  }

  async getMetadata(): Promise<ContainerSessionMetadata> {
    this.#assertOpen();

    this.#metadataPromise ??= this.#loadMetadata();
    return this.#metadataPromise;
  }

  async execute(
    command: ContainerCommandRequest,
  ): Promise<ContainerCommandResult> {
    this.#assertOpen();
    validateCommandRequest(command);

    const environment = normalizeCommandEnvironment(command.environment);
    const configuredContainerName =
      this.#loadedConfig.config.project.containerName ?? "[unconfigured]";
    const requestedWorkingDirectory =
      command.workingDirectory?.trim() || DEFAULT_CONTAINER_WORKING_DIRECTORY;
    const pendingCommandContext = {
      accessMode: command.accessMode,
      command: command.command,
      containerName: configuredContainerName,
      environment,
      executionTarget: "docker" as const,
      role: command.role,
      workingDirectory: requestedWorkingDirectory,
    } as const;

    if (command.signal?.aborted === true) {
      throw new ContainerCommandCancelledError(
        `Command was cancelled before Docker execution started for container \`${configuredContainerName}\`.`,
        createCommandLogRecord(pendingCommandContext, {
          durationMs: 0,
          exitCode: null,
          status: "cancelled",
          timestamp: this.#now().toISOString(),
        }),
      );
    }

    let metadata: ContainerSessionMetadata;

    try {
      metadata = await this.getMetadata();
    } catch (error) {
      if (error instanceof ContainerSessionError) {
        throw attachCommandLogRecord(
          error,
          createCommandLogRecord(pendingCommandContext, {
            durationMs: 0,
            exitCode: null,
            status:
              error instanceof ContainerCommandCancelledError
                ? "cancelled"
                : "failed-to-start",
            timestamp: this.#now().toISOString(),
          }),
        );
      }

      throw error;
    }

    const workingDirectory =
      command.workingDirectory?.trim() || metadata.defaultWorkingDirectory;
    const commandContext = {
      ...pendingCommandContext,
      containerName: metadata.containerName ?? configuredContainerName,
      executionTarget: "docker" as const,
      workingDirectory,
    } as const;
    const commandController = new AbortController();
    const signal = mergeAbortSignals([
      command.signal,
      this.#closeController.signal,
      commandController.signal,
    ]);

    this.#activeCommandControllers.add(commandController);

    try {
      const result = await this.#runProcess({
        args: buildDockerExecArgs({
          command: command.command,
          containerName: metadata.containerName ?? configuredContainerName,
          environment,
          workingDirectory,
        }),
        cwd: this.#loadedConfig.projectRoot,
        file: "docker",
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

      const runtimeError = createDockerExecFailure(
        commandContext.containerName,
        commandContext,
        result.exitCode,
        result.stderr,
        result.stdout,
        result.durationMs,
        this.#now().toISOString(),
      );

      if (runtimeError !== undefined) {
        throw runtimeError;
      }

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
          `Command exceeded timeout inside Docker container \`${metadata.containerName}\` after ${command.timeoutMs}ms.`,
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
            ? `Command was cancelled because the Docker container session for \`${metadata.containerName}\` was closed.`
            : `Command was cancelled inside Docker container \`${metadata.containerName}\`.`,
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
          "Could not start the Docker CLI. Ensure Docker is installed and available on PATH.",
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

  async #loadMetadata(): Promise<ContainerSessionMetadata> {
    const containerName = this.#loadedConfig.config.project.containerName;

    if (containerName === undefined) {
      throw new ContainerSessionConfigError(
        "Missing `project.containerName` for Docker execution.",
      );
    }

    const inspection = await this.#runProcess({
      args: ["inspect", containerName],
      cwd: this.#loadedConfig.projectRoot,
      file: "docker",
      signal: this.#closeController.signal,
      timeoutMs: DEFAULT_INSPECT_TIMEOUT_MS,
    }).catch((error: unknown) => {
      if (error instanceof ProcessSpawnError) {
        throw new ContainerRuntimeError(
          "Could not start the Docker CLI. Ensure Docker is installed and available on PATH.",
        );
      }

      if (error instanceof ProcessTimeoutError) {
        throw new ContainerRuntimeError(
          `Timed out while inspecting Docker container \`${containerName}\`.`,
        );
      }

      if (error instanceof ProcessCancelledError) {
        throw new ContainerCommandCancelledError(
          `Docker container inspection was cancelled for \`${containerName}\`.`,
        );
      }

      throw error;
    });

    if (inspection.exitCode !== 0) {
      if (looksLikeMissingContainer(inspection.stderr)) {
        throw new ContainerNotFoundError(
          `Configured Docker container \`${containerName}\` was not found. Start the predefined project container or update \`project.containerName\` in agent-harness.toml.`,
        );
      }

      throw new ContainerRuntimeError(
        `Could not inspect Docker container \`${containerName}\`: ${summarizeStderr(inspection.stderr)}`,
      );
    }

    const records = parseDockerInspectOutput(containerName, inspection.stdout);
    const firstRecord = records[0];

    if (firstRecord?.State?.Running !== true) {
      throw new ContainerRuntimeError(
        `Configured Docker container \`${containerName}\` is not running. Start the predefined project container and retry.`,
      );
    }

    return {
      containerName,
      defaultWorkingDirectory:
        firstRecord.Config?.WorkingDir?.trim() ||
        DEFAULT_CONTAINER_WORKING_DIRECTORY,
      executionTarget: "docker",
    };
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ContainerSessionStateError(
        "Container session is closed and cannot run additional commands.",
      );
    }
  }
}

function createDockerExecFailure(
  containerName: string,
  context: Omit<
    ContainerCommandResult,
    "durationMs" | "exitCode" | "stderr" | "stdout" | "timestamp"
  >,
  exitCode: number | null,
  stderr: string,
  stdout: string,
  durationMs: number,
  timestamp: string,
): ContainerSessionError | undefined {
  if (looksLikeMissingContainer(stderr)) {
    return new ContainerNotFoundError(
      `Configured Docker container \`${containerName}\` was not found while running a command. Start the predefined project container or update \`project.containerName\` in agent-harness.toml.`,
      createCommandLogRecord(context, {
        durationMs,
        exitCode,
        status: "failed-to-start",
        stderr,
        stdout,
        timestamp,
      }),
    );
  }

  if (stderr.includes("is not running")) {
    return new ContainerRuntimeError(
      `Configured Docker container \`${containerName}\` is not running. Start the predefined project container and retry.`,
      createCommandLogRecord(context, {
        durationMs,
        exitCode,
        status: "failed-to-start",
        stderr,
        stdout,
        timestamp,
      }),
    );
  }

  if (
    exitCode === 125 ||
    stderr.toLowerCase().includes("error response from daemon") ||
    stderr.toLowerCase().includes("cannot connect to the docker daemon")
  ) {
    return new ContainerRuntimeError(
      `Docker exec failed for container \`${containerName}\`: ${summarizeStderr(stderr)}`,
      createCommandLogRecord(context, {
        durationMs,
        exitCode,
        status: "failed-to-start",
        stderr,
        stdout,
        timestamp,
      }),
    );
  }

  return undefined;
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

function attachCommandLogRecord(
  error: ContainerSessionError,
  commandLogRecord: CommandLogRecord,
): ContainerSessionError {
  if (error.commandLogRecord !== undefined) {
    return error;
  }

  if (error instanceof ContainerCommandTimeoutError) {
    return new ContainerCommandTimeoutError(
      error.message,
      error.timeoutMs,
      commandLogRecord,
    );
  }

  if (error instanceof ContainerCommandCancelledError) {
    return new ContainerCommandCancelledError(error.message, commandLogRecord);
  }

  if (error instanceof ContainerNotFoundError) {
    return new ContainerNotFoundError(error.message, commandLogRecord);
  }

  if (error instanceof ContainerRuntimeError) {
    return new ContainerRuntimeError(error.message, commandLogRecord);
  }

  if (error instanceof ContainerSessionStateError) {
    return new ContainerSessionStateError(error.message, commandLogRecord);
  }

  if (error instanceof ContainerSessionConfigError) {
    return new ContainerSessionConfigError(error.message, commandLogRecord);
  }

  return new ContainerSessionError(error.message, commandLogRecord);
}

function looksLikeMissingContainer(stderr: string): boolean {
  const normalizedStderr = stderr.toLowerCase();

  return (
    normalizedStderr.includes("no such container") ||
    normalizedStderr.includes("no such object")
  );
}

function mergeAbortSignals(
  signals: Array<AbortSignal | undefined>,
): AbortSignal {
  const availableSignals = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );

  return AbortSignal.any(availableSignals);
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

function parseDockerInspectOutput(
  containerName: string,
  stdout: string,
): DockerInspectRecord[] {
  let parsedValue: unknown;

  try {
    parsedValue = JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new ContainerRuntimeError(
      `Docker inspect returned invalid JSON for container \`${containerName}\`: ${message}`,
    );
  }

  if (!Array.isArray(parsedValue) || parsedValue.length === 0) {
    throw new ContainerRuntimeError(
      `Docker inspect returned no container metadata for \`${containerName}\`.`,
    );
  }

  return parsedValue as DockerInspectRecord[];
}

function summarizeStderr(stderr: string): string {
  const firstLine = stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine ?? "No error details were reported.";
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

function validateDockerExecutionTarget(
  loadedConfig: LoadedHarnessConfig,
): void {
  if (loadedConfig.config.project.executionTarget !== "docker") {
    throw new ContainerSessionConfigError(
      `Container session requires \`project.executionTarget = "docker"\`, received \`${loadedConfig.config.project.executionTarget}\`.`,
    );
  }
}
