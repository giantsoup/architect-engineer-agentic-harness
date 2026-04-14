import { spawn } from "node:child_process";

export interface ProcessCommandResult {
  durationMs: number;
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

export interface RunProcessCommandOptions {
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  file: string;
  killGraceMs?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type RunProcess = (
  options: RunProcessCommandOptions,
) => Promise<ProcessCommandResult>;

const DEFAULT_KILL_GRACE_MS = 500;

export class ProcessCommandError extends Error {
  readonly args: readonly string[];
  readonly file: string;
  readonly result: ProcessCommandResult;

  constructor(
    message: string,
    options: {
      args: readonly string[];
      file: string;
      result: ProcessCommandResult;
    },
  ) {
    super(message);

    this.name = "ProcessCommandError";
    this.args = options.args;
    this.file = options.file;
    this.result = options.result;
  }
}

export class ProcessSpawnError extends ProcessCommandError {
  constructor(
    message: string,
    options: {
      args: readonly string[];
      file: string;
      result: ProcessCommandResult;
    },
  ) {
    super(message, options);

    this.name = "ProcessSpawnError";
  }
}

export class ProcessTimeoutError extends ProcessCommandError {
  readonly timeoutMs: number;

  constructor(
    message: string,
    options: {
      args: readonly string[];
      file: string;
      result: ProcessCommandResult;
      timeoutMs: number;
    },
  ) {
    super(message, options);

    this.name = "ProcessTimeoutError";
    this.timeoutMs = options.timeoutMs;
  }
}

export class ProcessCancelledError extends ProcessCommandError {
  constructor(
    message: string,
    options: {
      args: readonly string[];
      file: string;
      result: ProcessCommandResult;
    },
  ) {
    super(message, options);

    this.name = "ProcessCancelledError";
  }
}

export async function runProcessCommand(
  options: RunProcessCommandOptions,
): Promise<ProcessCommandResult> {
  if (options.signal?.aborted === true) {
    throw new ProcessCancelledError(
      `Command was cancelled before start: ${formatProcessInvocation(options.file, options.args)}`,
      {
        args: options.args,
        file: options.file,
        result: emptyProcessCommandResult(),
      },
    );
  }

  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    let abortKind: "cancelled" | "timed-out" | undefined;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const child = spawn(options.file, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const createResult = (exitCode: number | null): ProcessCommandResult => ({
      durationMs: getDurationMs(startedAt),
      exitCode,
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    });

    const cleanup = () => {
      options.signal?.removeEventListener("abort", handleAbort);

      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }

      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
      }
    };

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback();
    };

    const terminateChild = () => {
      if (child.exitCode !== null) {
        return;
      }

      child.kill("SIGTERM");
      graceTimer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, killGraceMs);
    };

    const handleAbort = () => {
      if (abortKind !== undefined) {
        return;
      }

      abortKind = "cancelled";
      terminateChild();
    };

    if (options.signal !== undefined) {
      options.signal.addEventListener("abort", handleAbort, { once: true });
    }

    if (options.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        if (abortKind !== undefined) {
          return;
        }

        abortKind = "timed-out";
        terminateChild();
      }, options.timeoutMs);
    }

    child.stdout?.on("data", (chunk: string | Buffer) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.once("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);

      settle(() => {
        reject(
          new ProcessSpawnError(
            `Could not start command ${formatProcessInvocation(options.file, options.args)}: ${message}`,
            {
              args: options.args,
              file: options.file,
              result: createResult(null),
            },
          ),
        );
      });
    });

    child.once("close", (exitCode) => {
      const result =
        abortKind === undefined ? createResult(exitCode) : createResult(null);

      settle(() => {
        if (abortKind === "timed-out") {
          reject(
            new ProcessTimeoutError(
              `Command timed out after ${options.timeoutMs}ms: ${formatProcessInvocation(options.file, options.args)}`,
              {
                args: options.args,
                file: options.file,
                result,
                timeoutMs: options.timeoutMs ?? 0,
              },
            ),
          );
          return;
        }

        if (abortKind === "cancelled") {
          reject(
            new ProcessCancelledError(
              `Command was cancelled: ${formatProcessInvocation(options.file, options.args)}`,
              {
                args: options.args,
                file: options.file,
                result,
              },
            ),
          );
          return;
        }

        resolve(result);
      });
    });
  });
}

function emptyProcessCommandResult(): ProcessCommandResult {
  return {
    durationMs: 0,
    exitCode: null,
    stderr: "",
    stdout: "",
  };
}

function formatProcessInvocation(
  file: string,
  args: readonly string[],
): string {
  return [file, ...args].join(" ");
}

function getDurationMs(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / BigInt(1_000_000));
}
