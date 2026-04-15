import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDirectory, "..", "..");
const builtCliEntrypoint = path.join(repoRoot, "dist", "cli.js");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

describe.sequential("packaged CLI smoke", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  beforeAll(() => {
    const buildResult = spawnSync(npmCommand, ["run", "build"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(buildResult.status).toBe(0);
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
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
      expect(initResult.stdout).toContain("Setup Complete");
      expect(initResult.stdout).toContain("created agent-harness.toml");
      expect(initResult.stdout).toContain("Next steps");
      expect(
        readFileSync(path.join(projectRoot, "agent-harness.toml"), "utf8"),
      ).toContain('executionTarget = "host"');
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

      const runResult = runBuiltCli(
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

      expect(runResult.status).toBe(0);
      expect(runResult.stdout).toContain("workspace/app");
      expect(runResult.stdout).toContain("testing");
      expect(runResult.stderr).toContain("Command completed with exit code 0.");
      expect(runResult.stderr).toContain(".agent-harness/runs/");

      const runIds = readdirSync(
        path.join(projectRoot, ".agent-harness", "runs"),
      );

      expect(runIds).toHaveLength(1);
    } finally {
      rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it("runs built task mode against an explicit external project root", async () => {
    const launcherRoot = createTempProject("aeah-built-launcher-");
    const projectRoot = createTempProject("aeah-built-task-");
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

      const runResult = await runBuiltCliAsync(
        [
          "run",
          "--task",
          "Update src/example.ts and keep npm test passing.",
          "--project-root",
          projectRoot,
        ],
        launcherRoot,
      );

      expect(runResult.status).toBe(0);
      expect(
        readFileSync(path.join(projectRoot, "src", "example.ts"), "utf8"),
      ).toContain("UPDATED_BY_TASK");
      expect(
        readFileSync(path.join(launcherRoot, "src", "example.ts"), "utf8"),
      ).toContain("ORIGINAL");

      const runIds = readdirSync(path.join(projectRoot, ".agent-harness", "runs"));

      expect(runIds).toHaveLength(1);
      expect(existsSync(path.join(launcherRoot, ".agent-harness", "runs"))).toBe(
        false,
      );

      const eventsPath = path.join(
        projectRoot,
        ".agent-harness",
        "runs",
        runIds[0]!,
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
            runIds[0]!,
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
      rmSync(launcherRoot, { force: true, recursive: true });
      rmSync(projectRoot, { force: true, recursive: true });
    }
  }, 20_000);

  it("supports tarball install, npx execution, init, and run outside the repo", () => {
    const packDirectory = createTempProject("aeah-pack-");
    const installRoot = createTempProject("aeah-install-");
    const projectRoot = path.join(installRoot, "project");

    try {
      mkdirSync(projectRoot, { recursive: true });

      const packResult = spawnSync(
        npmCommand,
        ["pack", "--pack-destination", packDirectory],
        {
          cwd: repoRoot,
          encoding: "utf8",
        },
      );

      expect(packResult.status).toBe(0);

      const tarballFileName = packResult.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .at(-1);

      expect(tarballFileName).toBe(
        "architect-engineer-agentic-harness-0.1.0.tgz",
      );

      const tarballPath = path.join(packDirectory, tarballFileName!);

      const npmInitResult = spawnSync(npmCommand, ["init", "-y"], {
        cwd: projectRoot,
        encoding: "utf8",
      });
      expect(npmInitResult.status).toBe(0);

      const installResult = spawnSync(
        npmCommand,
        ["install", "--silent", tarballPath],
        {
          cwd: projectRoot,
          encoding: "utf8",
        },
      );
      expect(installResult.status).toBe(0);
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
      const env = { ...process.env };

      const helpResult = spawnSync(
        npxCommand(),
        ["architect-engineer-agentic-harness", "--help"],
        {
          cwd: projectRoot,
          encoding: "utf8",
          env,
        },
      );
      expect(helpResult.status).toBe(0);
      expect(helpResult.stdout).toContain("Usage:");
      expect(helpResult.stdout).toContain(
        "Usage: architect-engineer-agentic-harness",
      );

      const aliasHelpResult = spawnSync(npxCommand(), ["blueprint", "--help"], {
        cwd: projectRoot,
        encoding: "utf8",
        env,
      });
      expect(aliasHelpResult.status).toBe(0);
      expect(aliasHelpResult.stdout).toContain("Usage: blueprint");

      const initResult = spawnSync(npxCommand(), ["blueprint", "init"], {
        cwd: projectRoot,
        encoding: "utf8",
        env,
      });
      expect(initResult.status).toBe(0);
      expect(initResult.stdout).toContain("Setup Complete");
      expect(initResult.stdout).toContain("created agent-harness.toml");
      expect(initResult.stdout).toContain("Files");
      expect(
        readFileSync(path.join(projectRoot, "agent-harness.toml"), "utf8"),
      ).toContain('executionTarget = "host"');

      const runResult = spawnSync(
        npxCommand(),
        [
          "blueprint",
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
        {
          cwd: projectRoot,
          encoding: "utf8",
          env,
        },
      );

      expect(runResult.status).toBe(0);
      expect(runResult.stdout).toContain("workspace/app");
      expect(runResult.stdout).toContain("testing");
      expect(runResult.stderr).toContain("Command completed with exit code 0.");
    } finally {
      rmSync(packDirectory, { force: true, recursive: true });
      rmSync(installRoot, { force: true, recursive: true });
    }
  }, 20_000);

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

type MockModelResponse = Record<string, unknown>;

function runBuiltCli(args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [builtCliEntrypoint, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
}

async function runBuiltCliAsync(
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [builtCliEntrypoint, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

function npxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function normalizePackPath(packPath: string): string {
  return packPath.replace(/^package\//u, "");
}

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
