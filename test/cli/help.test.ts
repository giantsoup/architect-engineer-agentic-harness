import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDirectory, "..", "..");
const cliEntrypoint = path.resolve(repoRoot, "src/cli/index.ts");
const tsxLoaderEntrypoint = path.resolve(
  repoRoot,
  "node_modules/tsx/dist/loader.mjs",
);

function runCli(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", tsxLoaderEntrypoint, cliEntrypoint, ...args],
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
    expect(result.stdout).toContain("chat");
    expect(result.stdout).toContain("run");
    expect(result.stdout).toContain("status");
    expect(result.stdout).toContain("inspect");
    expect(result.stdout).toContain("tui-demo");
  });

  it("prints the package version", () => {
    const result = runCli(["--version"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("0.1.0");
  });

  it("registers the friendly blueprint bin alias", async () => {
    const packageJsonModule = await import("../../package.json", {
      with: { type: "json" },
    });

    expect(packageJsonModule.default.bin).toMatchObject({
      "architect-engineer-agentic-harness": "./dist/cli.js",
      blueprint: "./dist/cli.js",
    });
  });

  it("uses the invoked bin name in help output when available", async () => {
    const { createProgram } = await import("../../src/cli/program.js");
    const help = createProgram({
      argv: ["node", "/tmp/node_modules/.bin/blueprint"],
    }).helpInformation();

    expect(help).toContain("Usage: blueprint");
  });

  it("shows the run command help and validates the selected mode", () => {
    const helpResult = runCli(["run", "--help"]);

    expect(helpResult.status).toBe(0);
    expect(helpResult.stdout).toContain("--command <command>");
    expect(helpResult.stdout).toContain("--task <markdown>");
    expect(helpResult.stdout).toContain("--task-file <path>");
    expect(helpResult.stdout).toContain("--project-root <directory>");
    expect(helpResult.stdout).toContain("--role <role>");
    expect(helpResult.stdout).toContain("--ui <mode>");
    expect(helpResult.stdout).toContain(
      "Task-run UI mode: live (default), plain, or tui",
    );

    const result = runCli(["run"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Provide `--command` for single-command mode or `--task`/`--task-file` for Architect-Engineer task mode.",
    );
  });

  it("rejects task-mode project-root targeting in single-command mode", () => {
    const result = runCli([
      "run",
      "--command",
      "npm test",
      "--project-root",
      "/tmp/project",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "`--project-root` is only supported with `--task` or `--task-file`.",
    );
  });

  it("shows the standalone TUI demo command help", () => {
    const result = runCli(["tui-demo", "--help"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Open the standalone TUI demo feed");
    expect(result.stdout).toContain("--run-label <label>");
    expect(result.stdout).toContain("--task <markdown>");
  });

  it("shows the interactive chat command help and rejects non-tty startup", () => {
    const helpResult = runCli(["chat", "--help"]);

    expect(helpResult.status).toBe(0);
    expect(helpResult.stdout).toContain(
      "Open the single-model interactive chat TUI",
    );
    expect(helpResult.stdout).toContain("--project-root <directory>");

    const result = runCli(["chat"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "The `blueprint chat` TUI requires an interactive TTY on stdin and stdout.",
    );
    expect(result.stderr).toContain("blueprint run --task");
  });
});
