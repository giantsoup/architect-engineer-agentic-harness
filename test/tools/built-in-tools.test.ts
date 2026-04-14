import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BuiltInToolPathError,
  BuiltInToolPermissionError,
  BuiltInToolStateError,
  createBuiltInToolExecutor,
  initializeProject,
  initializeRunDossier,
  loadHarnessConfig,
  type LoadedHarnessConfig,
} from "../../src/index.js";
import type { RunProcessCommandOptions } from "../../src/sandbox/process-runner.js";
import type {
  ProcessCommandResult,
  RunProcess,
} from "../../src/sandbox/process-runner.js";

const FIXED_NOW = new Date("2026-04-13T12:00:00.000Z");
const FIXED_RUN_ID = "20260413T120000.000Z-abc123";

function createTempProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "aeah-built-in-tools-"));
}

async function createInitializedProject(): Promise<LoadedHarnessConfig> {
  const projectRoot = createTempProject();
  await initializeProject(projectRoot);
  return loadHarnessConfig({ projectRoot });
}

async function createLoadedConfigForExecutionTarget(
  executionTarget: "docker" | "host",
): Promise<LoadedHarnessConfig> {
  const loadedConfig = await createInitializedProject();

  if (executionTarget === loadedConfig.config.project.executionTarget) {
    return loadedConfig;
  }

  return {
    ...loadedConfig,
    config: {
      ...loadedConfig.config,
      project:
        executionTarget === "docker"
          ? {
              executionTarget,
              containerName: "app",
            }
          : {
              executionTarget,
            },
      sandbox: {
        mode: executionTarget === "docker" ? "container" : "workspace-write",
      },
    },
  };
}

function createQueuedRunProcess(
  outcomes: Array<ProcessCommandResult | Error>,
): {
  calls: RunProcessCommandOptions[];
  runProcess: RunProcess;
} {
  const calls: RunProcessCommandOptions[] = [];

  return {
    calls,
    runProcess: async (options) => {
      calls.push({
        ...options,
        args: [...options.args],
      });

      const outcome = outcomes.shift();

      if (outcome === undefined) {
        throw new Error("Unexpected process invocation.");
      }

      if (outcome instanceof Error) {
        throw outcome;
      }

      return outcome;
    },
  };
}

describe("BuiltInToolExecutor", () => {
  const createdPaths: string[] = [];

  afterEach(() => {
    for (const targetPath of createdPaths.splice(0)) {
      rmSync(targetPath, { force: true, recursive: true });
    }
  });

  it("lets the Engineer modify a source file through the tool layer", async () => {
    const loadedConfig = await createInitializedProject();
    createdPaths.push(loadedConfig.projectRoot);
    const sourcePath = path.join(loadedConfig.projectRoot, "src", "example.ts");

    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, "export const value = 1;\n", "utf8");

    const executor = createBuiltInToolExecutor({ loadedConfig });

    try {
      const result = await executor.execute(
        { role: "engineer" },
        {
          content: "export const value = 2;\n",
          path: "src/example.ts",
          toolName: "file.write",
        },
      );

      expect(result).toEqual({
        byteLength: Buffer.byteLength("export const value = 2;\n", "utf8"),
        created: false,
        path: "src/example.ts",
        toolName: "file.write",
      });
      expect(readFileSync(sourcePath, "utf8")).toBe(
        "export const value = 2;\n",
      );
    } finally {
      executor.close();
    }
  });

  it("lets the Architect write markdown run artifacts but not project source files", async () => {
    const loadedConfig = await createInitializedProject();
    createdPaths.push(loadedConfig.projectRoot);
    const sourcePath = path.join(loadedConfig.projectRoot, "src", "locked.ts");

    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, "export const locked = true;\n", "utf8");

    const dossier = await initializeRunDossier(loadedConfig, {
      createdAt: FIXED_NOW,
      runId: FIXED_RUN_ID,
    });
    const executor = createBuiltInToolExecutor({
      dossierPaths: dossier.paths,
      loadedConfig,
    });

    try {
      const artifactResult = await executor.execute(
        { role: "architect" },
        {
          content: "# Plan\n",
          path: dossier.paths.files.architectPlan.relativePath,
          toolName: "file.write",
        },
      );

      expect(artifactResult).toMatchObject({
        path: dossier.paths.files.architectPlan.relativePath,
        toolName: "file.write",
      });
      expect(
        readFileSync(dossier.paths.files.architectPlan.absolutePath, "utf8"),
      ).toBe("# Plan\n");

      await expect(
        executor.execute(
          { role: "architect" },
          {
            content: "export const changed = true;\n",
            path: "src/locked.ts",
            toolName: "file.write",
          },
        ),
      ).rejects.toBeInstanceOf(BuiltInToolPermissionError);

      const events = readJsonLines(dossier.paths.files.events.absolutePath);
      const toolEvents = events.filter((event) => event.type === "tool-call");

      expect(toolEvents).toHaveLength(2);
      expect(toolEvents[0]).toMatchObject({
        request: {
          byteLength: Buffer.byteLength("# Plan\n", "utf8"),
          path: dossier.paths.files.architectPlan.relativePath,
        },
        result: {
          created: false,
          path: dossier.paths.files.architectPlan.relativePath,
        },
        role: "architect",
        status: "completed",
        toolName: "file.write",
        type: "tool-call",
      });
      expect(toolEvents[1]).toMatchObject({
        error: {
          code: "permission-denied",
          name: "BuiltInToolPermissionError",
        },
        request: {
          byteLength: Buffer.byteLength(
            "export const changed = true;\n",
            "utf8",
          ),
          path: "src/locked.ts",
        },
        role: "architect",
        status: "failed",
        toolName: "file.write",
        type: "tool-call",
      });
    } finally {
      executor.close();
    }
  });

  it("rejects writes outside allowed boundaries, including symlink escapes", async () => {
    const loadedConfig = await createInitializedProject();
    createdPaths.push(loadedConfig.projectRoot);
    const outsideRoot = mkdtempSync(path.join(os.tmpdir(), "aeah-outside-"));

    createdPaths.push(outsideRoot);
    symlinkSync(outsideRoot, path.join(loadedConfig.projectRoot, "linked-out"));

    const executor = createBuiltInToolExecutor({ loadedConfig });

    try {
      await expect(
        executor.execute(
          { role: "engineer" },
          {
            content: "escape\n",
            path: "../escape.txt",
            toolName: "file.write",
          },
        ),
      ).rejects.toBeInstanceOf(BuiltInToolPathError);

      await expect(
        executor.execute(
          { role: "engineer" },
          {
            content: "escape\n",
            path: "linked-out/escape.txt",
            toolName: "file.write",
          },
        ),
      ).rejects.toBeInstanceOf(BuiltInToolPathError);
    } finally {
      executor.close();
    }
  });

  it("returns structured file read and listing results", async () => {
    const loadedConfig = await createInitializedProject();
    createdPaths.push(loadedConfig.projectRoot);
    const docsDirectory = path.join(loadedConfig.projectRoot, "docs");

    mkdirSync(path.join(docsDirectory, "notes"), { recursive: true });
    writeFileSync(
      path.join(docsDirectory, "readme.md"),
      "alpha\nbeta\n",
      "utf8",
    );
    writeFileSync(
      path.join(docsDirectory, "notes", "todo.md"),
      "- item\n",
      "utf8",
    );

    const executor = createBuiltInToolExecutor({ loadedConfig });

    try {
      const readResult = await executor.execute(
        { role: "architect" },
        {
          path: "docs/readme.md",
          toolName: "file.read",
        },
      );
      const listResult = await executor.execute(
        { role: "architect" },
        {
          path: "docs",
          toolName: "file.list",
        },
      );

      expect(readResult).toEqual({
        byteLength: Buffer.byteLength("alpha\nbeta\n", "utf8"),
        content: "alpha\nbeta\n",
        path: "docs/readme.md",
        toolName: "file.read",
      });
      expect(listResult).toEqual({
        entries: [
          {
            kind: "directory",
            name: "notes",
            path: "docs/notes",
          },
          {
            kind: "file",
            name: "readme.md",
            path: "docs/readme.md",
          },
        ],
        path: "docs",
        toolName: "file.list",
      });
    } finally {
      executor.close();
    }
  });

  it("delegates command execution to the Milestone 4 project command runner and logs the tool call", async () => {
    const loadedConfig = await createLoadedConfigForExecutionTarget("docker");
    createdPaths.push(loadedConfig.projectRoot);
    const dossier = await initializeRunDossier(loadedConfig, {
      createdAt: FIXED_NOW,
      runId: FIXED_RUN_ID,
    });
    const { calls, runProcess } = createQueuedRunProcess([
      dockerInspectResult("/workspace"),
      {
        durationMs: 42,
        exitCode: 0,
        stderr: "warning output\n",
        stdout: "command output\n",
      },
    ]);
    const executor = createBuiltInToolExecutor({
      dossierPaths: dossier.paths,
      loadedConfig,
      now: () => FIXED_NOW,
      runProcess,
    });

    try {
      const result = await executor.execute(
        { role: "engineer" },
        {
          accessMode: "mutate",
          command: "npm test",
          environment: {
            APP_ENV: "test",
          },
          toolName: "command.execute",
          workingDirectory: "/workspace/app",
        },
      );

      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        args: ["inspect", "app"],
        cwd: loadedConfig.projectRoot,
        file: "docker",
      });
      expect(calls[1]).toMatchObject({
        args: [
          "exec",
          "--workdir",
          "/workspace/app",
          "--env",
          "APP_ENV=test",
          "app",
          "sh",
          "-lc",
          "npm test",
        ],
        cwd: loadedConfig.projectRoot,
        file: "docker",
      });
      expect(result).toEqual({
        accessMode: "mutate",
        command: "npm test",
        containerName: "app",
        durationMs: 42,
        environment: {
          APP_ENV: "test",
        },
        executionTarget: "docker",
        exitCode: 0,
        role: "engineer",
        stderr: "warning output\n",
        stdout: "command output\n",
        timestamp: FIXED_NOW.toISOString(),
        toolName: "command.execute",
        workingDirectory: "/workspace/app",
      });

      const commandLog = readJsonLines(
        dossier.paths.files.commandLog.absolutePath,
      );
      const events = readJsonLines(dossier.paths.files.events.absolutePath);
      const toolEvent = events.find(
        (event) =>
          event.type === "tool-call" && event.toolName === "command.execute",
      );

      expect(commandLog[0]).toMatchObject({
        accessMode: "mutate",
        command: "npm test",
        role: "engineer",
        status: "completed",
      });
      expect(toolEvent).toMatchObject({
        request: {
          accessMode: "mutate",
          command: "npm test",
          environment: {
            APP_ENV: "test",
          },
          workingDirectory: "/workspace/app",
        },
        result: {
          accessMode: "mutate",
          containerName: "app",
          durationMs: 42,
          executionTarget: "docker",
          exitCode: 0,
          workingDirectory: "/workspace/app",
        },
        role: "engineer",
        status: "completed",
        toolName: "command.execute",
        type: "tool-call",
      });
    } finally {
      executor.close();
    }
  });

  it("returns structured git status and git diff results", async () => {
    const loadedConfig = await createInitializedProject();
    createdPaths.push(loadedConfig.projectRoot);
    const { runProcess } = createQueuedRunProcess([
      {
        durationMs: 3,
        exitCode: 0,
        stderr: "",
        stdout: [
          "## main...origin/main [ahead 2, behind 1]",
          " M src/example.ts",
          "R  old.ts -> new.ts",
          "?? docs/new.md",
          "",
        ].join("\n"),
      },
      {
        durationMs: 5,
        exitCode: 0,
        stderr: "",
        stdout: "diff --git a/src/example.ts b/src/example.ts\n+change\n",
      },
    ]);
    const executor = createBuiltInToolExecutor({
      loadedConfig,
      runProcess,
    });

    try {
      const statusResult = await executor.execute(
        { role: "architect" },
        {
          toolName: "git.status",
        },
      );
      const diffResult = await executor.execute(
        { role: "architect" },
        {
          staged: true,
          toolName: "git.diff",
        },
      );

      expect(statusResult).toEqual({
        branch: {
          ahead: 2,
          behind: 1,
          detached: false,
          head: "main",
          upstream: "origin/main",
        },
        entries: [
          {
            indexStatus: " ",
            path: "src/example.ts",
            workingTreeStatus: "M",
          },
          {
            indexStatus: "R",
            originalPath: "old.ts",
            path: "new.ts",
            workingTreeStatus: " ",
          },
          {
            indexStatus: "?",
            path: "docs/new.md",
            workingTreeStatus: "?",
          },
        ],
        isClean: false,
        toolName: "git.status",
      });
      expect(diffResult).toEqual({
        byteLength: Buffer.byteLength(
          "diff --git a/src/example.ts b/src/example.ts\n+change\n",
          "utf8",
        ),
        diff: "diff --git a/src/example.ts b/src/example.ts\n+change\n",
        isEmpty: false,
        staged: true,
        toolName: "git.diff",
      });
    } finally {
      executor.close();
    }
  });

  it("surfaces invalid execution state cleanly for command execution", async () => {
    const loadedConfig = await createLoadedConfigForExecutionTarget("host");
    createdPaths.push(loadedConfig.projectRoot);
    const executor = createBuiltInToolExecutor({
      loadedConfig,
    });

    try {
      await expect(
        executor.execute(
          { role: "engineer" },
          {
            command: "npm test",
            toolName: "command.execute",
            workingDirectory: "/definitely/missing/aeah-working-directory",
          },
        ),
      ).rejects.toBeInstanceOf(BuiltInToolStateError);
    } finally {
      executor.close();
    }
  });

  it("rejects any tool execution after the executor is closed", async () => {
    const loadedConfig = await createInitializedProject();
    createdPaths.push(loadedConfig.projectRoot);
    const executor = createBuiltInToolExecutor({ loadedConfig });

    executor.close("qa close");

    await expect(
      executor.execute(
        { role: "architect" },
        {
          path: "package.json",
          toolName: "file.read",
        },
      ),
    ).rejects.toBeInstanceOf(BuiltInToolStateError);
  });

  it("exports the built-in tool APIs from the package root", async () => {
    const packageExports = await import("../../src/index.js");

    expect(typeof packageExports.createBuiltInToolExecutor).toBe("function");
    expect(typeof packageExports.BuiltInToolExecutor).toBe("function");
    expect(typeof packageExports.appendToolCall).toBe("function");
    expect(typeof packageExports.BuiltInToolError).toBe("function");
  });
});

function dockerInspectResult(workingDirectory: string): ProcessCommandResult {
  return {
    durationMs: 5,
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify([
      {
        Config: {
          WorkingDir: workingDirectory,
        },
        State: {
          Running: true,
        },
      },
    ]),
  };
}

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
