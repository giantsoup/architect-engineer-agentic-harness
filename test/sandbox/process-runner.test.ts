import { afterEach, describe, expect, it } from "vitest";

import {
  ProcessCancelledError,
  ProcessTimeoutError,
  runProcessCommand,
} from "../../src/sandbox/process-runner.js";

describe("runProcessCommand", () => {
  const abortControllers: AbortController[] = [];

  afterEach(() => {
    for (const controller of abortControllers.splice(0)) {
      controller.abort();
    }
  });

  it("captures stdout, stderr, exit code, and duration for local commands", async () => {
    const result = await runProcessCommand({
      args: [
        "--input-type=module",
        "-e",
        'console.log("stdout"); console.error("stderr"); process.exit(4);',
      ],
      file: process.execPath,
    });

    expect(result.exitCode).toBe(4);
    expect(result.stdout).toContain("stdout");
    expect(result.stderr).toContain("stderr");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("times out long-running commands clearly", async () => {
    await expect(
      runProcessCommand({
        args: [
          "--input-type=module",
          "-e",
          'setTimeout(() => { console.log("late"); }, 5_000);',
        ],
        file: process.execPath,
        timeoutMs: 25,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ProcessTimeoutError);
      expect((error as ProcessTimeoutError).timeoutMs).toBe(25);
      expect((error as ProcessTimeoutError).result.exitCode).toBeNull();

      return true;
    });
  });

  it("cancels long-running commands clearly", async () => {
    const controller = new AbortController();
    abortControllers.push(controller);
    const pendingCommand = runProcessCommand({
      args: [
        "--input-type=module",
        "-e",
        'setTimeout(() => { console.log("late"); }, 5_000);',
      ],
      file: process.execPath,
      signal: controller.signal,
    });

    controller.abort("cancelled for test");

    await expect(pendingCommand).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ProcessCancelledError);
      expect((error as ProcessCancelledError).result.exitCode).toBeNull();

      return true;
    });
  });
});
