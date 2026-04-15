import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

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

async function runCliAsync(
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", tsxLoaderEntrypoint, cliEntrypoint, ...args],
      {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => {
      resolve({ status, stderr, stdout });
    });
  });
}

function createTempProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "aeah-run-cli-"));
}

type MockModelResponse = Record<string, unknown>;

async function startMockServer(
  responses: readonly MockModelResponse[],
): Promise<{ close: () => Promise<void>; url: string }> {
  const queuedResponses = [...responses];
  const server = createServer((_request, response) => {
    const nextResponse = queuedResponses.shift();

    if (nextResponse === undefined) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Unexpected extra model request.",
          },
        }),
      );
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify(nextResponse),
              role: "assistant",
            },
          },
        ],
        id: `chatcmpl-${Math.random().toString(16).slice(2)}`,
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Mock server did not expose a TCP address.");
  }

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
    url: `http://127.0.0.1:${address.port}`,
  };
}

function initializeGitRepository(projectRoot: string): void {
  const initResult = spawnSync("git", ["init", "-b", "main"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  if (initResult.status === 0) {
    return;
  }

  expect(
    spawnSync("git", ["init"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).status,
  ).toBe(0);
}

function commitAll(projectRoot: string, message: string): void {
  expect(
    spawnSync("git", ["add", "--all"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).status,
  ).toBe(0);
  expect(
    spawnSync(
      "git",
      [
        "-c",
        "user.name=Test User",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        message,
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
      },
    ).status,
  ).toBe(0);
}

function writeTaskRepo(options: {
  modelBaseUrl: string;
  packageName: string;
  projectRoot: string;
  version: string;
}): void {
  mkdirSync(path.join(options.projectRoot, "src"), { recursive: true });
  writeFileSync(
    path.join(options.projectRoot, "agent-harness.toml"),
    `version = 1

[models.architect]
provider = "openai-compatible"
model = "mock-architect"
baseUrl = "${options.modelBaseUrl}/v1"

[models.engineer]
provider = "openai-compatible"
model = "mock-engineer"
baseUrl = "${options.modelBaseUrl}/v1"

[project]
executionTarget = "host"

[commands]
test = "npm test"

[mcp]
allowlist = []

[network]
mode = "inherit"

[sandbox]
mode = "workspace-write"

[artifacts]
rootDir = ".agent-harness"
runsDir = ".agent-harness/runs"

[stopConditions]
maxIterations = 12
maxEngineerAttempts = 5
requirePassingChecks = true
`,
    "utf8",
  );
  writeFileSync(
    path.join(options.projectRoot, "package.json"),
    JSON.stringify(
      {
        name: options.packageName,
        scripts: {
          test: "node check.js",
        },
        version: options.version,
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    path.join(options.projectRoot, ".gitignore"),
    "/.agent-harness/\n",
    "utf8",
  );
  writeFileSync(
    path.join(options.projectRoot, "check.js"),
    [
      'const fs = require("node:fs");',
      'const source = fs.readFileSync("src/example.ts", "utf8");',
      'if (!source.includes("UPDATED_BY_TASK")) {',
      '  process.stderr.write("missing task update\\n");',
      "  process.exit(1);",
      "}",
      'process.stdout.write("verified task update\\n");',
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(options.projectRoot, "src", "example.ts"),
    'export const value = "ORIGINAL";\n',
    "utf8",
  );
}

function readJsonLines(filePath: string): unknown[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

describe("CLI run", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

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

  it("runs task mode against an explicit external project root", async () => {
    const launcherRoot = createTempProject();
    const projectRoot = createTempProject();
    const modelServer = await startMockServer([
      {
        acceptanceCriteria: ["`npm test` passes in the selected repo"],
        steps: ["Update src/example.ts", "Run npm test"],
        summary: "Edit the source file and verify it.",
        type: "plan",
      },
      {
        request: {
          content: 'export const value = "UPDATED_BY_TASK";\n',
          path: "src/example.ts",
          toolName: "file.write",
        },
        summary: "Update the source file.",
        type: "tool",
      },
      {
        request: {
          accessMode: "mutate",
          command: "npm test",
          toolName: "command.execute",
        },
        stopWhenSuccessful: true,
        summary: "Verification passed.",
        type: "tool",
      },
      {
        decision: "approve",
        summary: "The selected repo was updated and verified.",
        type: "review",
      },
    ]);

    servers.push(modelServer);

    try {
      writeTaskRepo({
        modelBaseUrl: modelServer.url,
        packageName: "architect-engineer-agentic-harness",
        projectRoot: launcherRoot,
        version: "0.1.0",
      });
      writeTaskRepo({
        modelBaseUrl: modelServer.url,
        packageName: "external-task-target",
        projectRoot,
        version: "1.0.0",
      });
      initializeGitRepository(launcherRoot);
      initializeGitRepository(projectRoot);
      commitAll(launcherRoot, "initial");
      commitAll(projectRoot, "initial");

      const result = await runCliAsync(
        [
          "run",
          "--task",
          "Update src/example.ts and keep npm test passing.",
          "--project-root",
          projectRoot,
        ],
        launcherRoot,
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain(".agent-harness/runs/");
      expect(
        readFileSync(path.join(projectRoot, "src", "example.ts"), "utf8"),
      ).toContain("UPDATED_BY_TASK");
      expect(
        readFileSync(path.join(launcherRoot, "src", "example.ts"), "utf8"),
      ).toContain("ORIGINAL");

      const externalRunIds = readdirSync(
        path.join(projectRoot, ".agent-harness", "runs"),
      );

      expect(externalRunIds).toHaveLength(1);
      expect(
        existsSync(path.join(launcherRoot, ".agent-harness", "runs")),
      ).toBe(false);

      const eventsPath = path.join(
        projectRoot,
        ".agent-harness",
        "runs",
        externalRunIds[0]!,
        "events.jsonl",
      );
      const events = readJsonLines(eventsPath) as Array<{
        request?: { command?: string };
        result?: { workingDirectory?: string };
        toolName?: string;
        type?: string;
      }>;
      const checks = JSON.parse(
        readFileSync(
          path.join(
            projectRoot,
            ".agent-harness",
            "runs",
            externalRunIds[0]!,
            "checks.json",
          ),
          "utf8",
        ),
      ) as {
        checks: Array<{ command?: string; status: string }>;
      };

      const checkCommandEvent = events.find(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === "command.execute" &&
          event.request?.command === "npm test",
      );

      expect(checks.checks).toContainEqual(
        expect.objectContaining({
          command: "npm test",
          status: "passed",
        }),
      );
      expect(checkCommandEvent?.result?.workingDirectory).toBe(projectRoot);
      expect(readFileSync(eventsPath, "utf8")).toContain(
        "package name `external-task-target`",
      );
      expect(readFileSync(eventsPath, "utf8")).not.toContain(
        "package name `architect-engineer-agentic-harness`",
      );
    } finally {
      rmSync(launcherRoot, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 20_000);

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
