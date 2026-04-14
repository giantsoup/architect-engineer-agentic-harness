import path from "node:path";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";

import { GitStatusParseError, parseGitStatusPorcelain } from "../git/status.js";
import { appendToolCall } from "../runtime/run-dossier.js";
import {
  ContainerCommandCancelledError,
  ContainerCommandTimeoutError,
  ContainerNotFoundError,
  ContainerRuntimeError,
  ContainerSessionConfigError,
  ContainerSessionStateError,
  type ContainerCommandResult,
} from "../sandbox/container-session.js";
import {
  createProjectCommandRunner,
  type CreateProjectCommandRunnerOptions,
  type ProjectCommandRunnerLike,
} from "../sandbox/command-runner.js";
import {
  ProcessSpawnError,
  runProcessCommand,
  type RunProcess,
} from "../sandbox/process-runner.js";
import type { RunDossierPaths } from "../artifacts/paths.js";
import type { LoadedHarnessConfig } from "../types/config.js";
import type { JsonValue, ToolCallRecord } from "../types/run.js";
import {
  BuiltInToolCommandError,
  BuiltInToolError,
  BuiltInToolGitError,
  BuiltInToolInputError,
  BuiltInToolPathError,
  BuiltInToolStateError,
} from "./errors.js";
import {
  resolveBuiltInToolPaths,
  resolveBuiltInToolWritePolicy,
  type BuiltInToolPaths,
  type BuiltInToolWritePolicy,
} from "./permissions.js";
import {
  resolveReadableToolPath,
  resolveWritableToolPath,
} from "./path-guards.js";
import type {
  BuiltInToolExecutionContext,
  BuiltInToolName,
  BuiltInToolRequest,
  BuiltInToolResult,
  CommandExecutionToolRequest,
  CommandExecutionToolResult,
  FileListEntry,
  FileListToolResult,
  FileReadToolResult,
  FileWriteToolResult,
  GitDiffToolResult,
  GitStatusToolResult,
} from "./types.js";

export interface CreateBuiltInToolExecutorOptions extends Omit<
  CreateProjectCommandRunnerOptions,
  "loadedConfig"
> {
  dossierPaths?: RunDossierPaths;
  loadedConfig: LoadedHarnessConfig;
  now?: () => Date;
  projectCommandRunner?: ProjectCommandRunnerLike;
  runProcess?: RunProcess;
}

export class BuiltInToolExecutor {
  readonly #dossierPaths: RunDossierPaths | undefined;
  readonly #createProjectCommandRunner: () => ProjectCommandRunnerLike;
  readonly #loadedConfig: LoadedHarnessConfig;
  readonly #now: () => Date;
  readonly #paths: BuiltInToolPaths;
  readonly #runProcess: RunProcess;
  readonly #writePolicies: {
    readonly architect: BuiltInToolWritePolicy;
    readonly engineer: BuiltInToolWritePolicy;
  };
  readonly #ownsProjectCommandRunner: boolean;
  #closed = false;
  #projectCommandRunner: ProjectCommandRunnerLike | undefined;

  constructor(options: CreateBuiltInToolExecutorOptions) {
    this.#dossierPaths = options.dossierPaths;
    this.#loadedConfig = options.loadedConfig;
    this.#now = options.now ?? (() => new Date());
    this.#paths = resolveBuiltInToolPaths(this.#loadedConfig);
    this.#runProcess = options.runProcess ?? runProcessCommand;
    this.#writePolicies = {
      architect: resolveBuiltInToolWritePolicy("architect", this.#paths),
      engineer: resolveBuiltInToolWritePolicy("engineer", this.#paths),
    } as const;
    this.#createProjectCommandRunner = () =>
      createProjectCommandRunner({
        loadedConfig: options.loadedConfig,
        ...(options.dossierPaths === undefined
          ? {}
          : { dossierPaths: options.dossierPaths }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.runProcess === undefined
          ? {}
          : { runProcess: options.runProcess }),
      });
    this.#projectCommandRunner = options.projectCommandRunner;
    this.#ownsProjectCommandRunner = options.projectCommandRunner === undefined;
  }

  close(reason?: string): void {
    this.#closed = true;

    if (this.#ownsProjectCommandRunner) {
      this.#projectCommandRunner?.close(reason);
    }
  }

  async execute(
    context: BuiltInToolExecutionContext,
    request: BuiltInToolRequest,
  ): Promise<BuiltInToolResult> {
    this.#assertOpen(request.toolName);
    const startedAt = process.hrtime.bigint();

    try {
      const result = await this.#executeUnchecked(context, request);
      const timestamp = this.#now().toISOString();

      await this.#appendToolCall({
        durationMs: getDurationMs(startedAt),
        request: summarizeToolRequest(request),
        result: summarizeToolResult(result),
        role: context.role,
        status: "completed",
        timestamp,
        toolName: request.toolName,
      });

      return result;
    } catch (error) {
      const normalizedError = normalizeToolError(request.toolName, error);
      const timestamp = this.#now().toISOString();

      await this.#appendToolCall({
        durationMs: getDurationMs(startedAt),
        error: {
          code: normalizedError.code,
          message: normalizedError.message,
          name: normalizedError.name,
        },
        request: summarizeToolRequest(request),
        role: context.role,
        status: "failed",
        timestamp,
        toolName: request.toolName,
      });

      throw normalizedError;
    }
  }

  #getProjectCommandRunner(): ProjectCommandRunnerLike {
    this.#assertOpen("command.execute");
    this.#projectCommandRunner ??= this.#createProjectCommandRunner();
    return this.#projectCommandRunner as ProjectCommandRunnerLike;
  }

  #assertOpen(toolName: BuiltInToolName): void {
    if (this.#closed) {
      throw new BuiltInToolStateError(
        toolName,
        "Built-in tool executor is closed and cannot run additional tools.",
      );
    }
  }

  async #executeUnchecked(
    context: BuiltInToolExecutionContext,
    request: BuiltInToolRequest,
  ): Promise<BuiltInToolResult> {
    switch (request.toolName) {
      case "file.read":
        return this.#readFile(request);
      case "file.write":
        return this.#writeFile(context, request);
      case "file.list":
        return this.#listFiles(request);
      case "command.execute":
        return this.#executeCommand(context, request);
      case "git.status":
        return this.#getGitStatus();
      case "git.diff":
        return this.#getGitDiff(request);
      default:
        return assertNever(request);
    }
  }

  async #readFile(
    request: Extract<BuiltInToolRequest, { toolName: "file.read" }>,
  ): Promise<FileReadToolResult> {
    const guardedPath = await resolveReadableToolPath(
      request.toolName,
      request.path,
      this.#paths,
    );
    const fileContents = await this.#readExistingFile(
      request.toolName,
      guardedPath.absolutePath,
      guardedPath.path,
    );

    return {
      byteLength: fileContents.byteLength,
      content: fileContents.toString("utf8"),
      path: guardedPath.path,
      toolName: request.toolName,
    };
  }

  async #writeFile(
    context: BuiltInToolExecutionContext,
    request: Extract<BuiltInToolRequest, { toolName: "file.write" }>,
  ): Promise<FileWriteToolResult> {
    if (typeof request.content !== "string") {
      throw new BuiltInToolInputError(
        request.toolName,
        "Expected `content` to be a string.",
      );
    }

    const guardedPath = await resolveWritableToolPath(
      request.toolName,
      context.role,
      request.path,
      this.#writePolicies[context.role],
    );

    const created = !(await pathExists(guardedPath.absolutePath));
    const parentDirectory = path.dirname(guardedPath.absolutePath);

    try {
      await mkdir(parentDirectory, { recursive: true });
      await writeFile(guardedPath.absolutePath, request.content, "utf8");
    } catch (error) {
      throw new BuiltInToolPathError(
        request.toolName,
        `Could not write \`${guardedPath.path}\`: ${describeUnknownError(error)}`,
        { cause: error },
      );
    }

    return {
      byteLength: Buffer.byteLength(request.content, "utf8"),
      created,
      path: guardedPath.path,
      toolName: request.toolName,
    };
  }

  async #listFiles(
    request: Extract<BuiltInToolRequest, { toolName: "file.list" }>,
  ): Promise<FileListToolResult> {
    const guardedPath = await resolveReadableToolPath(
      request.toolName,
      request.path ?? ".",
      this.#paths,
    );
    const directoryStats = await this.#statExistingPath(
      request.toolName,
      guardedPath.absolutePath,
      guardedPath.path,
    );

    if (!directoryStats.isDirectory()) {
      throw new BuiltInToolPathError(
        request.toolName,
        `Path \`${guardedPath.path}\` is not a directory.`,
      );
    }

    const entries = (
      await readdir(guardedPath.absolutePath, { withFileTypes: true })
    )
      .map<FileListEntry>((entry) => ({
        kind: entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : entry.isSymbolicLink()
              ? "symlink"
              : "other",
        name: entry.name,
        path: toPortableRelativePath(
          this.#paths.projectRoot,
          path.join(guardedPath.absolutePath, entry.name),
        ),
      }))
      .sort((left, right) =>
        left.path.localeCompare(right.path, "en", { sensitivity: "base" }),
      );

    return {
      entries,
      path: guardedPath.path,
      toolName: request.toolName,
    };
  }

  async #executeCommand(
    context: BuiltInToolExecutionContext,
    request: CommandExecutionToolRequest,
  ): Promise<CommandExecutionToolResult> {
    if (
      request.accessMode !== undefined &&
      request.accessMode !== "inspect" &&
      request.accessMode !== "mutate"
    ) {
      throw new BuiltInToolInputError(
        request.toolName,
        "Expected `accessMode` to be `inspect` or `mutate`.",
      );
    }

    if (
      request.timeoutMs !== undefined &&
      (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0)
    ) {
      throw new BuiltInToolInputError(
        request.toolName,
        "Expected `timeoutMs` to be a positive integer.",
      );
    }

    if (
      typeof request.command !== "string" ||
      request.command.trim().length === 0
    ) {
      throw new BuiltInToolInputError(
        request.toolName,
        "Expected `command` to be a non-empty string.",
      );
    }

    if (context.role === "architect" && request.accessMode === "mutate") {
      throw new BuiltInToolStateError(
        request.toolName,
        "Architect commands may only use inspect access mode.",
      );
    }

    try {
      const projectCommandRunner = this.#getProjectCommandRunner();
      const commandResult: ContainerCommandResult =
        context.role === "architect"
          ? await projectCommandRunner.executeArchitectCommand({
              command: request.command,
              ...(request.environment === undefined
                ? {}
                : { environment: request.environment }),
              ...(request.timeoutMs === undefined
                ? {}
                : { timeoutMs: request.timeoutMs }),
              ...(request.workingDirectory === undefined
                ? {}
                : { workingDirectory: request.workingDirectory }),
            })
          : await projectCommandRunner.executeEngineerCommand({
              accessMode: request.accessMode ?? "mutate",
              command: request.command,
              ...(request.environment === undefined
                ? {}
                : { environment: request.environment }),
              ...(request.timeoutMs === undefined
                ? {}
                : { timeoutMs: request.timeoutMs }),
              ...(request.workingDirectory === undefined
                ? {}
                : { workingDirectory: request.workingDirectory }),
            });

      return {
        ...commandResult,
        toolName: request.toolName,
      };
    } catch (error) {
      if (
        error instanceof ContainerCommandCancelledError ||
        error instanceof ContainerCommandTimeoutError ||
        error instanceof ContainerNotFoundError ||
        error instanceof ContainerRuntimeError
      ) {
        throw new BuiltInToolCommandError(request.toolName, error.message, {
          cause: error,
        });
      }

      if (
        error instanceof ContainerSessionConfigError ||
        error instanceof ContainerSessionStateError
      ) {
        throw new BuiltInToolStateError(request.toolName, error.message, {
          cause: error,
        });
      }

      throw error;
    }
  }

  async #getGitStatus(): Promise<GitStatusToolResult> {
    const result = await this.#runGitCommand("git.status", [
      "status",
      "--porcelain=v1",
      "--branch",
    ]);
    let status;

    try {
      status = parseGitStatusPorcelain(result.stdout);
    } catch (error) {
      if (error instanceof GitStatusParseError) {
        throw new BuiltInToolGitError("git.status", error.message, {
          cause: error,
        });
      }

      throw error;
    }

    return {
      branch: status.branch,
      entries: status.entries,
      isClean: status.entries.length === 0,
      toolName: "git.status",
    };
  }

  async #getGitDiff(
    request: Extract<BuiltInToolRequest, { toolName: "git.diff" }>,
  ): Promise<GitDiffToolResult> {
    const gitArgs = ["diff", "--no-color", "--no-ext-diff"];

    if (request.staged === true) {
      gitArgs.push("--cached");
    }

    const result = await this.#runGitCommand(request.toolName, gitArgs);

    return {
      byteLength: Buffer.byteLength(result.stdout, "utf8"),
      diff: result.stdout,
      isEmpty: result.stdout.length === 0,
      staged: request.staged === true,
      toolName: request.toolName,
    };
  }

  async #runGitCommand(
    toolName: "git.diff" | "git.status",
    args: string[],
  ): Promise<{ stderr: string; stdout: string }> {
    try {
      const result = await this.#runProcess({
        args,
        cwd: this.#loadedConfig.projectRoot,
        file: "git",
      });

      if (result.exitCode !== 0) {
        throw new BuiltInToolGitError(
          toolName,
          `Git command \`git ${args.join(" ")}\` failed with exit code ${result.exitCode}: ${selectErrorMessage(result.stderr, result.stdout)}`,
        );
      }

      return {
        stderr: result.stderr,
        stdout: result.stdout,
      };
    } catch (error) {
      if (error instanceof BuiltInToolGitError) {
        throw error;
      }

      if (error instanceof ProcessSpawnError) {
        throw new BuiltInToolGitError(
          toolName,
          `Could not start git while executing \`git ${args.join(" ")}\`: ${error.message}`,
          { cause: error },
        );
      }

      throw new BuiltInToolGitError(
        toolName,
        `Unexpected git failure while executing \`git ${args.join(" ")}\`: ${describeUnknownError(error)}`,
        { cause: error },
      );
    }
  }

  async #appendToolCall(record: ToolCallRecord): Promise<void> {
    if (this.#dossierPaths === undefined) {
      return;
    }

    await appendToolCall(this.#dossierPaths, record);
  }

  async #readExistingFile(
    toolName: BuiltInToolName,
    absolutePath: string,
    relativePath: string,
  ): Promise<Buffer> {
    const fileStats = await this.#statExistingPath(
      toolName,
      absolutePath,
      relativePath,
    );

    if (!fileStats.isFile()) {
      throw new BuiltInToolPathError(
        toolName,
        `Path \`${relativePath}\` is not a file.`,
      );
    }

    try {
      return await readFile(absolutePath);
    } catch (error) {
      throw new BuiltInToolPathError(
        toolName,
        `Could not read \`${relativePath}\`: ${describeUnknownError(error)}`,
        { cause: error },
      );
    }
  }

  async #statExistingPath(
    toolName: BuiltInToolName,
    absolutePath: string,
    relativePath: string,
  ) {
    try {
      return await stat(absolutePath);
    } catch (error) {
      const maybeNodeError = error as NodeJS.ErrnoException;

      if (maybeNodeError.code === "ENOENT") {
        throw new BuiltInToolPathError(
          toolName,
          `Path \`${relativePath}\` does not exist.`,
        );
      }

      throw new BuiltInToolPathError(
        toolName,
        `Could not access \`${relativePath}\`: ${describeUnknownError(error)}`,
        { cause: error },
      );
    }
  }
}

export function createBuiltInToolExecutor(
  options: CreateBuiltInToolExecutorOptions,
): BuiltInToolExecutor {
  return new BuiltInToolExecutor(options);
}

function summarizeToolRequest(
  request: BuiltInToolRequest,
): Record<string, JsonValue | undefined> {
  switch (request.toolName) {
    case "file.read":
      return {
        path: request.path,
      };
    case "file.write":
      return {
        byteLength: Buffer.byteLength(request.content, "utf8"),
        path: request.path,
      };
    case "file.list":
      return {
        path: request.path ?? ".",
      };
    case "command.execute":
      return {
        accessMode: request.accessMode,
        command: request.command,
        environment:
          request.environment === undefined
            ? undefined
            : sanitizeCommandEnvironment(request.environment),
        timeoutMs: request.timeoutMs,
        workingDirectory: request.workingDirectory,
      };
    case "git.status":
      return {};
    case "git.diff":
      return {
        staged: request.staged === true,
      };
    default:
      return assertNever(request);
  }
}

function summarizeToolResult(
  result: BuiltInToolResult,
): Record<string, JsonValue | undefined> {
  switch (result.toolName) {
    case "file.read":
      return {
        byteLength: result.byteLength,
        path: result.path,
      };
    case "file.write":
      return {
        byteLength: result.byteLength,
        created: result.created,
        path: result.path,
      };
    case "file.list":
      return {
        entries: result.entries.map((entry) => ({
          kind: entry.kind,
          name: entry.name,
          path: entry.path,
        })),
        entryCount: result.entries.length,
        path: result.path,
      };
    case "command.execute":
      return {
        accessMode: result.accessMode,
        containerName: result.containerName,
        durationMs: result.durationMs,
        executionTarget: result.executionTarget,
        exitCode: result.exitCode,
        workingDirectory: result.workingDirectory,
      };
    case "git.status":
      return {
        ahead: result.branch.ahead,
        behind: result.branch.behind,
        detached: result.branch.detached,
        entryCount: result.entries.length,
        head: result.branch.head,
        isClean: result.isClean,
        upstream: result.branch.upstream,
      };
    case "git.diff":
      return {
        byteLength: result.byteLength,
        isEmpty: result.isEmpty,
        staged: result.staged,
      };
    default:
      return assertNever(result);
  }
}

function sanitizeCommandEnvironment(
  environment: CommandExecutionToolRequest["environment"],
): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(environment ?? {}).map(([key, value]) => [
      key,
      value === undefined ? null : String(value),
    ]),
  );
}

function normalizeToolError(
  toolName: BuiltInToolName,
  error: unknown,
): BuiltInToolError {
  if (error instanceof BuiltInToolError) {
    return error;
  }

  return new BuiltInToolStateError(
    toolName,
    `Unexpected failure while executing ${toolName}: ${describeUnknownError(error)}`,
    { cause: error instanceof Error ? error : undefined },
  );
}

function getDurationMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function selectErrorMessage(stderr: string, stdout: string): string {
  const trimmedStderr = stderr.trim();

  if (trimmedStderr.length > 0) {
    return trimmedStderr;
  }

  const trimmedStdout = stdout.trim();

  return trimmedStdout.length > 0 ? trimmedStdout : "Unknown git failure.";
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;

    if (maybeNodeError.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function toPortableRelativePath(fromPath: string, targetPath: string): string {
  const relativePath = path.relative(fromPath, targetPath);
  const normalizedRelativePath = relativePath.split(path.sep).join("/");

  return normalizedRelativePath.length === 0 ? "." : normalizedRelativePath;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported value: ${JSON.stringify(value)}`);
}
