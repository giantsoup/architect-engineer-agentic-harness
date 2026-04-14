import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDirectory, "..", "..");
const cliEntrypoint = path.resolve(repoRoot, "src/cli/index.ts");
const tsxLoaderEntrypoint = path.resolve(
  repoRoot,
  "node_modules/tsx/dist/loader.mjs",
);

function runCli(args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    ["--import", tsxLoaderEntrypoint, cliEntrypoint, ...args],
    {
      cwd,
      encoding: "utf8",
      env,
    },
  );
}

function createTempProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "aeah-run-cli-"));
}

describe("CLI run", () => {
  it("executes a configured command on the host and writes a dossier entry", () => {
    const projectRoot = createTempProject();

    try {
      expect(runCli(["init"], projectRoot).status).toBe(0);
      mkdirSync(path.join(projectRoot, "workspace", "app"), {
        recursive: true,
      });
      writeFileSync(
        path.join(projectRoot, "print-host-context.js"),
        [
          "process.stdout.write(`${process.cwd()}\\n`);",
          'process.stdout.write(`${process.env.APP_ENV ?? ""}\\n`);',
        ].join("\n"),
        "utf8",
      );

      const result = runCli(
        [
          "run",
          "--role",
          "engineer",
          "--command",
          "node ../../print-host-context.js",
          "--cwd",
          "workspace/app",
          "--env",
          "APP_ENV=testing",
        ],
        projectRoot,
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("workspace/app");
      expect(result.stdout).toContain("testing");
      expect(result.stderr).toContain("Command completed with exit code 0.");
      expect(result.stderr).toContain(".agent-harness/runs/");

      const runsDirectory = path.join(projectRoot, ".agent-harness", "runs");
      const runIds = readdirSync(runsDirectory);

      expect(runIds).toHaveLength(1);

      const commandLog = readJsonLines(
        path.join(runsDirectory, runIds[0]!, "command-log.jsonl"),
      );

      expect(commandLog[0]).toMatchObject({
        accessMode: "mutate",
        command: "node ../../print-host-context.js",
        environment: {
          APP_ENV: "testing",
        },
        executionTarget: "host",
        role: "engineer",
        status: "completed",
      });
      expect(
        (commandLog[0] as { workingDirectory: string }).workingDirectory,
      ).toContain("workspace/app");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("still executes through Docker when the config targets docker", () => {
    const projectRoot = createTempProject();

    try {
      expect(runCli(["init"], projectRoot).status).toBe(0);

      const binDir = path.join(projectRoot, ".test-bin");
      const dockerLogPath = path.join(projectRoot, "fake-docker-log.jsonl");
      const fakeDockerPath = path.join(binDir, "docker");
      const configPath = path.join(projectRoot, "agent-harness.toml");
      const configContents = readFileSync(configPath, "utf8").replace(
        'executionTarget = "host"',
        'executionTarget = "docker"\ncontainerName = "app"',
      );
      const dockerConfig = configContents.replace(
        'mode = "workspace-write"',
        'mode = "container"',
      );

      writeFileSync(configPath, dockerConfig, "utf8");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        fakeDockerPath,
        `#!/usr/bin/env node
const fs = require("node:fs");

const args = process.argv.slice(2);
const logPath = process.env.FAKE_DOCKER_LOG;
fs.appendFileSync(logPath, JSON.stringify(args) + "\\n", "utf8");

if (args[0] === "inspect") {
  process.stdout.write(JSON.stringify([{ State: { Running: true }, Config: { WorkingDir: "/workspace" } }]));
  process.exit(0);
}

if (args[0] === "exec") {
  process.stdout.write("cli stdout\\n");
  process.stderr.write("cli stderr\\n");
  process.exit(0);
}

process.stderr.write("unexpected command\\n");
process.exit(1);
`,
        "utf8",
      );
      chmodSync(fakeDockerPath, 0o755);

      const result = runCli(
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

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("cli stdout");
      expect(result.stderr).toContain("cli stderr");
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
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

function readJsonLines(filePath: string): unknown[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}
