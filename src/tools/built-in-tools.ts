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
  FileReadManyToolResult,
  FileReadToolResult,
  FileSearchToolResult,
  FileWriteToolResult,
  GitDiffToolResult,
  GitStatusToolResult,
} from "./types.js";

const LOW_VALUE_SEARCH_PATH_SEGMENTS = new Set([
  ".agent-harness",
  ".git",
  "dist",
  "node_modules",
]);
const MAX_FILE_READ_MANY_PATHS = 8;
const MAX_FILE_READ_MANY_TOTAL_CHARS = 6000;
const MAX_FILE_READ_MANY_CHARS_PER_FILE = 2000;
const MAX_FILE_SEARCH_DEFAULT_LIMIT = 8;
const MAX_FILE_SEARCH_LIMIT = 20;
const MAX_FILE_SEARCH_LINE_CHARS = 180;
const MAX_FILE_SEARCH_MATCHES_PER_FILE = 3;
const MAX_FILE_SEARCH_FILE_BYTES = 128 * 1024;

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
      case "file.search":
        return this.#searchFiles(request);
      case "file.read_many":
        return this.#readManyFiles(request);
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

  async #readManyFiles(
    request: Extract<BuiltInToolRequest, { toolName: "file.read_many" }>,
  ): Promise<FileReadManyToolResult> {
    if (!Array.isArray(request.paths) || request.paths.length === 0) {
      throw new BuiltInToolInputError(
        request.toolName,
        "Expected `paths` to be a non-empty array of relative file paths.",
      );
    }

    if (request.paths.length > MAX_FILE_READ_MANY_PATHS) {
      throw new BuiltInToolInputError(
        request.toolName,
        `Expected at most ${MAX_FILE_READ_MANY_PATHS} paths.`,
      );
    }

    const files: FileReadManyToolResult["files"] = [];
    let hiddenPathCount = 0;
    let remainingChars = MAX_FILE_READ_MANY_TOTAL_CHARS;

    for (const requestedPath of request.paths) {
      const guardedPath = await resolveReadableToolPath(
        request.toolName,
        requestedPath,
        this.#paths,
      );
      const fileContents = await this.#readExistingFile(
        request.toolName,
        guardedPath.absolutePath,
        guardedPath.path,
      );

      if (remainingChars <= 0) {
        hiddenPathCount += 1;
        continue;
      }

      const content = fileContents.toString("utf8");
      const visibleCharCount = Math.min(
        content.length,
        MAX_FILE_READ_MANY_CHARS_PER_FILE,
        remainingChars,
      );

      files.push({
        byteLength: fileContents.byteLength,
        content: content.slice(0, visibleCharCount),
        path: guardedPath.path,
        ...(visibleCharCount < content.length
          ? { truncatedCharCount: content.length - visibleCharCount }
          : {}),
      });
      remainingChars -= visibleCharCount;
    }

    return {
      files,
      ...(hiddenPathCount === 0 ? {} : { hiddenPathCount }),
      requestedPathCount: request.paths.length,
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
    let changed = true;
    const parentDirectory = path.dirname(guardedPath.absolutePath);

    if (!created) {
      try {
        const existingContents = await readFile(
          guardedPath.absolutePath,
          "utf8",
        );
        changed = existingContents !== request.content;
      } catch (error) {
        throw new BuiltInToolPathError(
          request.toolName,
          `Could not read \`${guardedPath.path}\` before writing: ${describeUnknownError(error)}`,
          { cause: error },
        );
      }
    }

    try {
      await mkdir(parentDirectory, { recursive: true });
      if (created || changed) {
        await writeFile(guardedPath.absolutePath, request.content, "utf8");
      }
    } catch (error) {
      throw new BuiltInToolPathError(
        request.toolName,
        `Could not write \`${guardedPath.path}\`: ${describeUnknownError(error)}`,
        { cause: error },
      );
    }

    return {
      byteLength: Buffer.byteLength(request.content, "utf8"),
      changed,
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

  async #searchFiles(
    request: Extract<BuiltInToolRequest, { toolName: "file.search" }>,
  ): Promise<FileSearchToolResult> {
    if (
      typeof request.query !== "string" ||
      request.query.trim().length === 0
    ) {
      throw new BuiltInToolInputError(
        request.toolName,
        "Expected `query` to be a non-empty string.",
      );
    }

    if (
      request.limit !== undefined &&
      (!Number.isInteger(request.limit) ||
        request.limit <= 0 ||
        request.limit > MAX_FILE_SEARCH_LIMIT)
    ) {
      throw new BuiltInToolInputError(
        request.toolName,
        `Expected \`limit\` to be an integer between 1 and ${MAX_FILE_SEARCH_LIMIT}.`,
      );
    }

    const guardedPath = await resolveReadableToolPath(
      request.toolName,
      request.path ?? ".",
      this.#paths,
    );
    const targetStats = await this.#statExistingPath(
      request.toolName,
      guardedPath.absolutePath,
      guardedPath.path,
    );
    const searchableFiles = targetStats.isDirectory()
      ? await this.#collectSearchableFiles(
          guardedPath.absolutePath,
          guardedPath.path,
        )
      : [{ absolutePath: guardedPath.absolutePath, path: guardedPath.path }];
    const matchingResults: FileSearchToolResult["results"] = [];
    let searchedFileCount = 0;
    let skippedFileCount = 0;

    for (const file of searchableFiles) {
      const fileStats = await this.#statExistingPath(
        request.toolName,
        file.absolutePath,
        file.path,
      );

      if (!fileStats.isFile()) {
        continue;
      }

      if (fileStats.size > MAX_FILE_SEARCH_FILE_BYTES) {
        skippedFileCount += 1;
        continue;
      }

      const fileContents = await this.#readExistingFile(
        request.toolName,
        file.absolutePath,
        file.path,
      );
      const searchEntry = findMatchesInFile(
        file.path,
        fileContents,
        request.query,
      );
      searchedFileCount += 1;

      if (searchEntry !== undefined) {
        matchingResults.push(searchEntry);
      }
    }

    const limit = request.limit ?? MAX_FILE_SEARCH_DEFAULT_LIMIT;
    const rankedResults = matchingResults.sort(compareFileSearchResults);
    const visibleResults = rankedResults.slice(0, limit);
    const hiddenResultCount = rankedResults.length - visibleResults.length;

    return {
      ...(hiddenResultCount === 0 ? {} : { hiddenResultCount }),
      path: guardedPath.path,
      query: request.query,
      results: visibleResults,
      searchedFileCount,
      ...(skippedFileCount === 0 ? {} : { skippedFileCount }),
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

  async #collectSearchableFiles(
    absolutePath: string,
    relativePath: string,
  ): Promise<Array<{ absolutePath: string; path: string }>> {
    const files: Array<{ absolutePath: string; path: string }> = [];
    const pending = [{ absolutePath, path: relativePath }];
    const allowLowValuePaths = isLowValueSearchPath(relativePath);

    while (pending.length > 0) {
      const current = pending.pop() as { absolutePath: string; path: string };
      const directoryEntries = await readdir(current.absolutePath, {
        withFileTypes: true,
      });

      directoryEntries.sort((left, right) =>
        left.name.localeCompare(right.name, "en", { sensitivity: "base" }),
      );

      for (const entry of directoryEntries) {
        const entryAbsolutePath = path.join(current.absolutePath, entry.name);
        const entryRelativePath = toPortableRelativePath(
          this.#paths.projectRoot,
          entryAbsolutePath,
        );

        if (entry.isSymbolicLink()) {
          continue;
        }

        if (entry.isDirectory()) {
          if (!allowLowValuePaths && isLowValueSearchPath(entryRelativePath)) {
            continue;
          }

          pending.push({
            absolutePath: entryAbsolutePath,
            path: entryRelativePath,
          });
          continue;
        }

        if (entry.isFile()) {
          files.push({
            absolutePath: entryAbsolutePath,
            path: entryRelativePath,
          });
        }
      }
    }

    return files;
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
    case "file.search":
      return {
        limit: request.limit,
        path: request.path ?? ".",
        query: request.query,
      };
    case "file.read_many":
      return {
        pathCount: request.paths.length,
        paths: request.paths,
      };
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
    case "file.search":
      return {
        hiddenResultCount: result.hiddenResultCount,
        path: result.path,
        query: result.query,
        results: result.results.map((entry) => ({
          matchCount: entry.matchCount,
          path: entry.path,
        })),
        searchedFileCount: result.searchedFileCount,
        skippedFileCount: result.skippedFileCount,
      };
    case "file.read_many":
      return {
        files: result.files.map((file) => ({
          byteLength: file.byteLength,
          path: file.path,
          truncatedCharCount: file.truncatedCharCount,
        })),
        hiddenPathCount: result.hiddenPathCount,
        requestedPathCount: result.requestedPathCount,
      };
    case "file.read":
      return {
        byteLength: result.byteLength,
        path: result.path,
      };
    case "file.write":
      return {
        byteLength: result.byteLength,
        changed: result.changed,
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

function findMatchesInFile(
  filePath: string,
  fileContents: Buffer,
  query: string,
): FileSearchToolResult["results"][number] | undefined {
  const text = fileContents.toString("utf8");
  const lines = text.split(/\r?\n/u);
  const hits: FileSearchToolResult["results"][number]["hits"] = [];
  let matchCount = 0;

  for (const [index, line] of lines.entries()) {
    const lineMatchCount = countOccurrences(line, query);

    if (lineMatchCount === 0) {
      continue;
    }

    matchCount += lineMatchCount;

    if (hits.length < MAX_FILE_SEARCH_MATCHES_PER_FILE) {
      hits.push({
        line: index + 1,
        preview: truncatePreview(line, MAX_FILE_SEARCH_LINE_CHARS),
      });
    }
  }

  if (matchCount === 0) {
    return undefined;
  }

  return {
    hits,
    matchCount,
    path: filePath,
  };
}

function compareFileSearchResults(
  left: FileSearchToolResult["results"][number],
  right: FileSearchToolResult["results"][number],
): number {
  const rankDifference =
    getExplorationPathRank(left.path) - getExplorationPathRank(right.path);

  if (rankDifference !== 0) {
    return rankDifference;
  }

  if (left.matchCount !== right.matchCount) {
    return right.matchCount - left.matchCount;
  }

  const leftFirstLine = left.hits[0]?.line ?? Number.MAX_SAFE_INTEGER;
  const rightFirstLine = right.hits[0]?.line ?? Number.MAX_SAFE_INTEGER;

  if (leftFirstLine !== rightFirstLine) {
    return leftFirstLine - rightFirstLine;
  }

  return left.path.localeCompare(right.path, "en", { sensitivity: "base" });
}

function countOccurrences(value: string, query: string): number {
  let count = 0;
  let startIndex = 0;

  while (true) {
    const matchIndex = value.indexOf(query, startIndex);

    if (matchIndex === -1) {
      return count;
    }

    count += 1;
    startIndex = matchIndex + Math.max(query.length, 1);
  }
}

function truncatePreview(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function isLowValueSearchPath(pathValue: string): boolean {
  return pathValue
    .split("/")
    .some((segment) => LOW_VALUE_SEARCH_PATH_SEGMENTS.has(segment));
}

function getExplorationPathRank(pathValue: string): number {
  if (pathValue === "README.md" || pathValue.endsWith("/README.md")) {
    return 0;
  }

  if (pathValue === "package.json" || pathValue.endsWith("/package.json")) {
    return 1;
  }

  if (pathValue === "docs" || pathValue.startsWith("docs/")) {
    return 2;
  }

  if (pathValue === "src" || pathValue.startsWith("src/")) {
    return 3;
  }

  if (pathValue === "test" || pathValue.startsWith("test/")) {
    return 4;
  }

  return 10;
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
