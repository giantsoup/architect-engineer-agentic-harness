import { describe, expect, it } from "vitest";

import { runProcessCommand } from "../../src/sandbox/process-runner.js";

describe("runProcessCommand streaming observers", () => {
  it("streams stdout and stderr chunks without changing the final aggregate output", async () => {
    const observedChunks: string[] = [];

    const result = await runProcessCommand({
      args: [
        "--input-type=module",
        "-e",
        [
          'process.stdout.write("first\\n");',
          'setTimeout(() => process.stderr.write("warn\\n"), 5);',
          'setTimeout(() => process.stdout.write("second\\n"), 10);',
          "setTimeout(() => process.exit(0), 15);",
        ].join(" "),
      ],
      file: process.execPath,
      onStderrChunk(chunk) {
        observedChunks.push(`stderr:${chunk.toString("utf8")}`);
      },
      onStdoutChunk(chunk) {
        observedChunks.push(`stdout:${chunk.toString("utf8")}`);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("first\nsecond\n");
    expect(result.stderr).toBe("warn\n");
    expect(observedChunks).toEqual([
      "stdout:first\n",
      "stderr:warn\n",
      "stdout:second\n",
    ]);
  });
});
