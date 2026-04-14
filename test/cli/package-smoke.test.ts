import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDirectory, "..", "..");
const builtCliEntrypoint = path.join(repoRoot, "dist", "cli.js");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

describe.sequential("packaged CLI smoke", () => {
  beforeAll(() => {
    const buildResult = spawnSync(npmCommand, ["run", "build"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(buildResult.status).toBe(0);
  });

  it("prints help from the built CLI when invoked outside the repo root", () => {
    const outsideRoot = createTempProject("aeah-built-help-");

    try {
      const result = runBuiltCli(["--help"], outsideRoot);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).toContain("init");
      expect(result.stdout).toContain("run");
      expect(result.stdout).toContain("status");
      expect(result.stdout).toContain("inspect");
    } finally {
      rmSync(outsideRoot, { force: true, recursive: true });
    }
  });

  it("supports built-CLI init and run flows from an external temp repo", () => {
    const projectRoot = createTempProject("aeah-built-run-");

    try {
      const initResult = runBuiltCli(["init"], projectRoot);

      expect(initResult.status).toBe(0);
      expect(initResult.stdout).toContain("created agent-harness.toml");

      const binDir = path.join(projectRoot, ".test-bin");
      const dockerLogPath = path.join(projectRoot, "fake-docker-log.jsonl");
      const fakeDockerPath = path.join(binDir, "docker");

      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        fakeDockerPath,
        `#!/usr/bin/env node
const fs = require("node:fs");

const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n", "utf8");

if (args[0] === "inspect") {
  process.stdout.write(JSON.stringify([{ State: { Running: true }, Config: { WorkingDir: "/workspace" } }]));
  process.exit(0);
}

if (args[0] === "exec") {
  process.stdout.write("built smoke stdout\\n");
  process.exit(0);
}

process.stderr.write("unexpected command\\n");
process.exit(1);
`,
        "utf8",
      );
      chmodSync(fakeDockerPath, 0o755);

      const runResult = runBuiltCli(
        [
          "run",
          "--role",
          "engineer",
          "--command",
          "npm test",
          "--cwd",
          "/workspace/app",
          "--env",
          "APP_ENV=testing",
        ],
        projectRoot,
        {
          ...process.env,
          FAKE_DOCKER_LOG: dockerLogPath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      );

      expect(runResult.status).toBe(0);
      expect(runResult.stdout).toContain("built smoke stdout");
      expect(runResult.stderr).toContain("Command completed with exit code 0.");
      expect(runResult.stderr).toContain(".agent-harness/runs/");

      const runIds = readdirSync(
        path.join(projectRoot, ".agent-harness", "runs"),
      );

      expect(runIds).toHaveLength(1);
      expect(readJsonLines(dockerLogPath)).toEqual([
        ["inspect", "app"],
        [
          "exec",
          "--workdir",
          "/workspace/app",
          "--env",
          "APP_ENV=testing",
          "app",
          "sh",
          "-lc",
          "npm test",
        ],
      ]);
    } finally {
      rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it("keeps the packed file list limited to runtime assets and examples", () => {
    const packResult = spawnSync(
      npmCommand,
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(packResult.status).toBe(0);

    const packedEntries = JSON.parse(packResult.stdout) as Array<{
      files: Array<{ path: string }>;
    }>;
    const packedPaths = packedEntries[0]!.files
      .map((file) => normalizePackPath(file.path))
      .sort();

    expect(packedPaths).toContain("dist/cli.js");
    expect(packedPaths).toContain("dist/index.js");
    expect(packedPaths).toContain("examples/typescript/agent-harness.toml");
    expect(packedPaths).toContain("examples/laravel/agent-harness.toml");
    expect(packedPaths).toContain("prompts/v1/architect/system.md");
    expect(packedPaths).toContain("schemas/v1/run-result.schema.json");
    expect(packedPaths).toContain("README.md");
    expect(packedPaths).toContain("LICENSE");
    expect(packedPaths).not.toContain("src/cli/index.ts");
    expect(packedPaths).not.toContain("test/cli/package-smoke.test.ts");
  });
});

function createTempProject(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runBuiltCli(args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [builtCliEntrypoint, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
}

function readJsonLines(filePath: string): unknown[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function normalizePackPath(packPath: string): string {
  return packPath.replace(/^package\//u, "");
}
