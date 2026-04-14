import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDockerContainerSession,
  createHostCommandSession,
  ContainerCommandCancelledError,
  ContainerCommandTimeoutError,
  ContainerNotFoundError,
  ContainerRuntimeError,
  ContainerSessionConfigError,
  ContainerSessionStateError,
  createProjectCommandRunner,
  initializeProject,
  initializeRunDossier,
  loadHarnessConfig,
  type LoadedHarnessConfig,
} from "../../src/index.js";
import type { RunProcessCommandOptions } from "../../src/sandbox/process-runner.js";
import {
  ProcessCancelledError,
  ProcessTimeoutError,
  type ProcessCommandResult,
  type RunProcess,
} from "../../src/sandbox/process-runner.js";

const FIXED_RUN_ID = "20260413T120000.000Z-abc123";
const FIXED_NOW = new Date("2026-04-13T12:00:00.000Z");

function createTempProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "aeah-command-runner-"));
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

describe("ProjectCommandRunner", () => {
  const createdProjectRoots: string[] = [];

  afterEach(() => {
    for (const projectRoot of createdProjectRoots.splice(0)) {
      rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it("executes an Engineer command in the configured container and writes a dossier command log", async () => {
    const loadedConfig = await createLoadedConfigForExecutionTarget("docker");
    createdProjectRoots.push(loadedConfig.projectRoot);
    const dossier = await initializeRunDossier(loadedConfig, {
      createdAt: FIXED_NOW,
      runId: FIXED_RUN_ID,
    });
    const { calls, runProcess } = createQueuedRunProcess([
      dockerInspectResult("/workspace"),
      {
        durationMs: 42,
        exitCode: 3,
        stderr: "warning output\n",
        stdout: "command output\n",
      },
    ]);
    const runner = createProjectCommandRunner({
      dossierPaths: dossier.paths,
      loadedConfig,
      now: () => FIXED_NOW,
      runProcess,
    });

    const result = await runner.executeEngineerCommand({
      accessMode: "mutate",
      command: "php artisan list",
      environment: {
        APP_ENV: "testing",
        FEATURE_FLAG: true,
        IGNORED: undefined,
      },
      workingDirectory: "/workspace/app",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      args: ["inspect", "app"],
      cwd: loadedConfig.projectRoot,
      file: "docker",
      timeoutMs: 10_000,
    });
    expect(calls[1]).toMatchObject({
      args: [
        "exec",
        "--workdir",
        "/workspace/app",
        "--env",
        "APP_ENV=testing",
        "--env",
        "FEATURE_FLAG=true",
        "app",
        "sh",
        "-lc",
        "php artisan list",
      ],
      cwd: loadedConfig.projectRoot,
      file: "docker",
    });
    expect(result).toEqual({
      accessMode: "mutate",
      command: "php artisan list",
      containerName: "app",
      durationMs: 42,
      environment: {
        APP_ENV: "testing",
        FEATURE_FLAG: "true",
      },
      executionTarget: "docker",
      exitCode: 3,
      role: "engineer",
      stderr: "warning output\n",
      stdout: "command output\n",
      timestamp: FIXED_NOW.toISOString(),
      workingDirectory: "/workspace/app",
    });

    const commandLog = readJsonLines(
      dossier.paths.files.commandLog.absolutePath,
    );

    expect(commandLog).toEqual([
      {
        accessMode: "mutate",
        command: "php artisan list",
        containerName: "app",
        durationMs: 42,
        environment: {
          APP_ENV: "testing",
          FEATURE_FLAG: "true",
        },
        executionTarget: "docker",
        exitCode: 3,
        role: "engineer",
        status: "completed",
        stderr: "warning output\n",
        stdout: "command output\n",
        timestamp: FIXED_NOW.toISOString(),
        workingDirectory: "/workspace/app",
      },
    ]);
  });

  it("executes Architect inspection commands with inspect access mode and container default working directory", async () => {
    const loadedConfig = await createLoadedConfigForExecutionTarget("docker");
    createdProjectRoots.push(loadedConfig.projectRoot);
    const dossier = await initializeRunDossier(loadedConfig, {
      createdAt: FIXED_NOW,
      runId: FIXED_RUN_ID,
    });
    const { calls, runProcess } = createQueuedRunProcess([
      dockerInspectResult("/workspace/default"),
      {
        durationMs: 7,
        exitCode: 0,
        stderr: "",
        stdout: "src\npackage.json\n",
      },
    ]);
    const runner = createProjectCommandRunner({
      dossierPaths: dossier.paths,
      loadedConfig,
      now: () => FIXED_NOW,
      runProcess,
    });

    const result = await runner.executeArchitectCommand({
      command: "ls",
    });

    expect(calls[1]?.args).toEqual([
      "exec",
      "--workdir",
      "/workspace/default",
      "app",
      "sh",
      "-lc",
      "ls",
    ]);
    expect(result.role).toBe("architect");
    expect(result.accessMode).toBe("inspect");

    const commandLog = readJsonLines(
      dossier.paths.files.commandLog.absolutePath,
    );

    expect(commandLog[0]).toMatchObject({
      accessMode: "inspect",
      role: "architect",
      status: "completed",
      workingDirectory: "/workspace/default",
    });
  });

  it("fails clearly on timeout and records the timeout in the dossier", async () => {
    const loadedConfig = await createLoadedConfigForExecutionTarget("docker");
    createdProjectRoots.push(loadedConfig.projectRoot);
    const dossier = await initializeRunDossier(loadedConfig, {
      createdAt: FIXED_NOW,
      runId: FIXED_RUN_ID,
    });
    const { runProcess } = createQueuedRunProcess([
      dockerInspectResult("/workspace"),
      new ProcessTimeoutError("timeout", {
        args: ["exec"],
        file: "docker",
        result: {
          durationMs: 125,
          exitCode: null,
          stderr: "timed out\n",
          stdout: "partial output\n",
        },
        timeoutMs: 50,
      }),
    ]);
    const runner = createProjectCommandRunner({
      dossierPaths: dossier.paths,
      loadedConfig,
      now: () => FIXED_NOW,
      runProcess,
    });

    await expect(
      runner.executeEngineerCommand({
        command: "npm test",
        timeoutMs: 50,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ContainerCommandTimeoutError);
      expect((error as Error).message).toContain("app");
      expect((error as Error).message).toContain("50ms");

      return true;
    });

    const commandLog = readJsonLines(
      dossier.paths.files.commandLog.absolutePath,
    );

    expect(commandLog[0]).toMatchObject({
      command: "npm test",
      durationMs: 125,
      exitCode: null,
      role: "engineer",
      status: "timed-out",
      stderr: "timed out\n",
      stdout: "partial output\n",
    });
  });

  it("fails clearly on cancellation and records the cancellation in the dossier", async () => {
    const loadedConfig = await createLoadedConfigForExecutionTarget("docker");
    createdProjectRoots.push(loadedConfig.projectRoot);
    const dossier = await initializeRunDossier(loadedConfig, {
      createdAt: FIXED_NOW,
      runId: FIXED_RUN_ID,
    });
    const { runProcess } = createQueuedRunProcess([
      dockerInspectResult("/workspace"),
      new ProcessCancelledError("cancelled", {
        args: ["exec"],
        file: "docker",
        result: {
          durationMs: 20,
          exitCode: null,
          stderr: "cancelled\n",
          stdout: "partial output\n",
        },
      }),
    ]);
    const runner = createProjectCommandRunner({
      dossierPaths: dossier.paths,
      loadedConfig,
      now: () => FIXED_NOW,
      runProcess,
    });

    await expect(
      runner.executeArchitectCommand({
        command: "cat package.json",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ContainerCommandCancelledError);

    const commandLog = readJsonLines(
      dossier.paths.files.commandLog.absolutePath,
    );

    expect(commandLog[0]).toMatchObject({
      accessMode: "inspect",
      command: "cat package.json",
      exitCode: null,
      role: "architect",
      status: "cancelled",
    });
  });

  it("surfaces missing containers with an actionable error", async () => {
    const loadedConfig = await createLoadedConfigForExecutionTarget("docker");
    createdProjectRoots.push(loadedConfig.projectRoot);
    const dossier = await initializeRunDossier(loadedConfig, {
      createdAt: FIXED_NOW,
      runId: FIXED_RUN_ID,
    });
    const { runProcess } = createQueuedRunProcess([
      {
        durationMs: 3,
        exitCode: 1,
        stderr: "Error: No such object: app\n",
        stdout: "",
      },
    ]);
    const runner = createProjectCommandRunner({
      dossierPaths: dossier.paths,
      loadedConfig,
      now: () => FIXED_NOW,
      runProcess,
    });

    await expect(
      runner.executeEngineerCommand({ command: "npm test" }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ContainerNotFoundError);
      expect((error as Error).message).toContain("project.containerName");

      return true;
    });

    const commandLog = readJsonLines(
      dossier.paths.files.commandLog.absolutePath,
    );

    expect(commandLog[0]).toMatchObject({
      command: "npm test",
      containerName: "app",
      exitCode: null,
      role: "engineer",
      status: "failed-to-start",
    });
  });

  it("surfaces docker exec failures distinctly from command exit codes", async () => {
    const loadedConfig = await createLoadedConfigForExecutionTarget("docker");
    createdProjectRoots.push(loadedConfig.projectRoot);
    const dossier = await initializeRunDossier(loadedConfig, {
      createdAt: FIXED_NOW,
      runId: FIXED_RUN_ID,
    });
    const { runProcess } = createQueuedRunProcess([
      dockerInspectResult("/workspace"),
      {
        durationMs: 8,
        exitCode: 125,
        stderr: "Error response from daemon: container app is not running\n",
        stdout: "",
      },
    ]);
    const runner = createProjectCommandRunner({
      dossierPaths: dossier.paths,
      loadedConfig,
      now: () => FIXED_NOW,
      runProcess,
    });

    await expect(
      runner.executeEngineerCommand({ command: "npm test" }),
    ).rejects.toBeInstanceOf(ContainerRuntimeError);

    const commandLog = readJsonLines(
      dossier.paths.files.commandLog.absolutePath,
    );

    expect(commandLog[0]).toMatchObject({
      command: "npm test",
      exitCode: 125,
      status: "failed-to-start",
    });
  });

  it("rejects invalid environment variables and invalid execution state cleanly", async () => {
    const loadedConfig = await createLoadedConfigForExecutionTarget("docker");
    createdProjectRoots.push(loadedConfig.projectRoot);
    const runner = createProjectCommandRunner({
      loadedConfig,
      now: () => FIXED_NOW,
      runProcess: async () => dockerInspectResult("/workspace"),
    });

    await expect(
      runner.executeEngineerCommand({
        command: "npm test",
        environment: {
          "bad-name": "value",
        },
      }),
    ).rejects.toBeInstanceOf(ContainerSessionConfigError);

    runner.close();

    await expect(
      runner.executeArchitectCommand({ command: "pwd" }),
    ).rejects.toBeInstanceOf(ContainerSessionStateError);
  });

  it("fails immediately for an already-cancelled command before docker inspection starts", async () => {
    const loadedConfig = await createLoadedConfigForExecutionTarget("docker");
    createdProjectRoots.push(loadedConfig.projectRoot);
    const dossier = await initializeRunDossier(loadedConfig, {
      createdAt: FIXED_NOW,
      runId: FIXED_RUN_ID,
    });
    const { calls, runProcess } = createQueuedRunProcess([
      dockerInspectResult("/workspace"),
    ]);
    const runner = createProjectCommandRunner({
      dossierPaths: dossier.paths,
      loadedConfig,
      now: () => FIXED_NOW,
      runProcess,
    });
    const controller = new AbortController();

    controller.abort("cancelled before execution");

    await expect(
      runner.executeEngineerCommand({
        command: "npm test",
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ContainerCommandCancelledError);

    expect(calls).toHaveLength(0);

    const commandLog = readJsonLines(
      dossier.paths.files.commandLog.absolutePath,
    );

    expect(commandLog[0]).toMatchObject({
      command: "npm test",
      exitCode: null,
      role: "engineer",
      status: "cancelled",
    });
  });

  it("executes a host command in the project working tree and records host metadata", async () => {
    const loadedConfig = await createLoadedConfigForExecutionTarget("host");
    createdProjectRoots.push(loadedConfig.projectRoot);
    const hostWorkingDirectory = path.join(loadedConfig.projectRoot, "scripts");
    const dossier = await initializeRunDossier(loadedConfig, {
      createdAt: FIXED_NOW,
      runId: FIXED_RUN_ID,
    });
    const { calls, runProcess } = createQueuedRunProcess([
      {
        durationMs: 11,
        exitCode: 0,
        stderr: "",
        stdout: "host output\n",
      },
    ]);
    const runner = createProjectCommandRunner({
      dossierPaths: dossier.paths,
      loadedConfig,
      now: () => FIXED_NOW,
      runProcess,
    });

    rmSync(hostWorkingDirectory, { force: true, recursive: true });
    mkdirSync(hostWorkingDirectory, { recursive: true });

    const result = await runner.executeEngineerCommand({
      accessMode: "mutate",
      command: "npm test",
      environment: {
        APP_ENV: "testing",
      },
      workingDirectory: "scripts",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      args:
        process.platform === "win32"
          ? ["/d", "/s", "/c", "npm test"]
          : ["-lc", "npm test"],
      cwd: hostWorkingDirectory,
      env: expect.objectContaining({
        APP_ENV: "testing",
      }),
      file:
        process.platform === "win32"
          ? expect.stringMatching(/cmd(?:\.exe)?$/iu)
          : "sh",
    });
    expect(result).toEqual({
      accessMode: "mutate",
      command: "npm test",
      durationMs: 11,
      environment: {
        APP_ENV: "testing",
      },
      executionTarget: "host",
      exitCode: 0,
      role: "engineer",
      stderr: "",
      stdout: "host output\n",
      timestamp: FIXED_NOW.toISOString(),
      workingDirectory: hostWorkingDirectory,
    });

    const commandLog = readJsonLines(
      dossier.paths.files.commandLog.absolutePath,
    );

    expect(commandLog[0]).toMatchObject({
      accessMode: "mutate",
      command: "npm test",
      durationMs: 11,
      environment: {
        APP_ENV: "testing",
      },
      executionTarget: "host",
      exitCode: 0,
      role: "engineer",
      status: "completed",
      workingDirectory: hostWorkingDirectory,
    });
  });

  it("still rejects mismatched direct session constructors", async () => {
    const hostConfig = await createLoadedConfigForExecutionTarget("host");
    const dockerConfig = await createLoadedConfigForExecutionTarget("docker");
    createdProjectRoots.push(hostConfig.projectRoot, dockerConfig.projectRoot);

    expect(() =>
      createDockerContainerSession({
        loadedConfig: hostConfig,
      }),
    ).toThrowError(ContainerSessionConfigError);

    expect(() =>
      createHostCommandSession({
        loadedConfig: dockerConfig,
      }),
    ).toThrowError(ContainerSessionConfigError);
  });

  it("exports the new command runner APIs from the package root", async () => {
    const packageExports = await import("../../src/index.js");

    expect(typeof packageExports.createDockerContainerSession).toBe("function");
    expect(typeof packageExports.createHostCommandSession).toBe("function");
    expect(typeof packageExports.createProjectCommandRunner).toBe("function");
    expect(typeof packageExports.ProjectCommandRunner).toBe("function");
    expect(typeof packageExports.buildDockerExecArgs).toBe("function");
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

function readJsonLines(filePath: string): unknown[] {
  const rawContents = readFileSync(filePath, "utf8");

  return rawContents
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}
