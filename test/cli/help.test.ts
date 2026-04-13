import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDirectory, "..", "..");
const cliEntrypoint = path.resolve(repoRoot, "src/cli/index.ts");

function runCli(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", cliEntrypoint, ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
}

describe("CLI help", () => {
  it("prints top-level help when no arguments are provided", () => {
    const result = runCli([]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("Commands:");
  });

  it("prints top-level help", () => {
    const result = runCli(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("init");
    expect(result.stdout).toContain("run");
    expect(result.stdout).toContain("status");
    expect(result.stdout).toContain("inspect");
  });

  it("returns a non-zero exit code for placeholder commands", () => {
    const result = runCli(["init"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("not implemented yet");
    expect(result.stderr).toContain("Milestone 1");
  });
});
