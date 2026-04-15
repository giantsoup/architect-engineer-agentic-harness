import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  executeArchitectEngineerRun,
  initializeProject,
  loadHarnessConfig,
  type ContainerCommandResult,
  type CreateMcpServerClient,
  type LoadedHarnessConfig,
  type McpAvailableTool,
  type McpToolCallRequest,
  type McpToolCallResult,
  type ModelChatRequest,
  type ModelChatResponse,
} from "../../src/index.js";

function createTempProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "aeah-architect-engineer-"));
}

async function createLoadedConfig(
  projectRoot: string,
  options: {
    mcpBlock?: string;
  } = {},
): Promise<LoadedHarnessConfig> {
  await initializeProject(projectRoot);
  const configPath = path.join(projectRoot, "agent-harness.toml");

  if (options.mcpBlock !== undefined) {
    const updatedConfig = readFileSync(configPath, "utf8").replace(
      "allowlist = []",
      options.mcpBlock,
    );

    writeFileSync(configPath, updatedConfig, "utf8");
  }

  expect(
    spawnSync(
      "git",
      [
        "-c",
        "user.name=Test User",
        "-c",
        "user.email=test@example.com",
        "add",
        "--all",
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
      },
    ).status,
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
        "harness init",
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
      },
    ).status,
  ).toBe(0);
  return loadHarnessConfig({ projectRoot });
}

function initializeGitRepository(projectRoot: string): void {
  const initResult = spawnSync("git", ["init", "-b", "main"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  if (initResult.status !== 0) {
    const fallback = spawnSync("git", ["init"], {
      cwd: projectRoot,
      encoding: "utf8",
    });

    if (fallback.status !== 0) {
      throw new Error(
        fallback.stderr || initResult.stderr || "git init failed",
      );
    }
  }
}

function commitFile(
  projectRoot: string,
  relativePath: string,
  contents: string,
): void {
  const absolutePath = path.join(projectRoot, relativePath);

  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, "utf8");
  expect(
    spawnSync("git", ["add", relativePath], {
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
        "initial",
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
      },
    ).status,
  ).toBe(0);
}

function runGit(projectRoot: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function readCurrentBranch(projectRoot: string): string {
  return runGit(projectRoot, ["branch", "--show-current"]);
}

function readHeadCommit(projectRoot: string): string {
  return runGit(projectRoot, ["rev-parse", "HEAD"]);
}

function readCommitSubjects(projectRoot: string): string[] {
  const output = runGit(projectRoot, ["log", "--format=%s"]);

  return output.length === 0 ? [] : output.split(/\r?\n/u);
}

function parseJsonLines(filePath: string): Record<string, unknown>[] {
  const contents = readFileSync(filePath, "utf8").trim();

  if (contents.length === 0) {
    return [];
  }

  return contents
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createQueuedModelClient<TStructured>(
  outputs: readonly TStructured[],
): {
  requests: Array<ModelChatRequest<unknown>>;
  client: {
    chat<TRequestStructured>(
      request: ModelChatRequest<TRequestStructured>,
    ): Promise<ModelChatResponse<TRequestStructured>>;
  };
} {
  const queue = [...outputs];
  const requests: Array<ModelChatRequest<unknown>> = [];

  return {
    requests,
    client: {
      async chat<TRequestStructured>(
        request: ModelChatRequest<TRequestStructured>,
      ): Promise<ModelChatResponse<TRequestStructured>> {
        requests.push(request as ModelChatRequest<unknown>);
        const nextOutput = queue.shift();

        if (nextOutput === undefined) {
          throw new Error("Unexpected extra model request.");
        }

        return {
          id: `mock-${requests.length}`,
          rawContent: JSON.stringify(nextOutput),
          role: "assistant",
          structuredOutput: nextOutput as TRequestStructured,
        };
      },
    },
  };
}

function createFakeMcpClientFactory(
  behaviors: Record<
    string,
    {
      callResult?: McpToolCallResult | Error | undefined;
      listTools?: McpAvailableTool[] | Error | undefined;
    }
  >,
): {
  calls: McpToolCallRequest[];
  factory: CreateMcpServerClient;
} {
  const calls: McpToolCallRequest[] = [];

  return {
    calls,
    factory: (server) => {
      const behavior = behaviors[server.id];

      return {
        async close() {},
        async connect() {},
        getStderrSummary() {
          return undefined;
        },
        async listTools() {
          const outcome = behavior?.listTools ?? [];

          if (outcome instanceof Error) {
            throw outcome;
          }

          return outcome.map((tool) => ({
            ...tool,
            server: server.id,
          }));
        },
        async runTool(request) {
          calls.push(request);
          const outcome = behavior?.callResult;

          if (outcome instanceof Error) {
            throw outcome;
          }

          return (
            outcome ?? {
              content: [{ text: "ok", type: "text" }],
              isError: false,
              name: request.name,
              server: server.id,
              toolName: "mcp.call",
            }
          );
        },
      };
    },
  };
}

describe("executeArchitectEngineerRun", () => {
  const projectRoots: string[] = [];

  afterEach(() => {
    for (const projectRoot of projectRoots.splice(0)) {
      rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it("completes the happy path, writes a complete dossier, and keeps Architect tool calls inspect-only", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);
    commitFile(projectRoot, "src/example.ts", "export const value = 1;\n");

    const loadedConfig = await createLoadedConfig(projectRoot);
    const architect = createQueuedModelClient([
      {
        acceptanceCriteria: ["`npm run test` passes"],
        steps: ["Update the source file", "Run the required test command"],
        summary: "Change the export and verify it.",
        type: "plan",
      },
      {
        decision: "approve",
        summary: "The change is complete and verified.",
        type: "review",
      },
    ]);
    const engineer = createQueuedModelClient([
      {
        request: {
          content: "export const value = 2;\n",
          path: "src/example.ts",
          toolName: "file.write",
        },
        summary: "Update the source file.",
        type: "tool",
      },
      {
        request: {
          accessMode: "mutate",
          command: "npm run test",
          toolName: "command.execute",
        },
        stopWhenSuccessful: true,
        summary: "Verification passed after running the required test command.",
        type: "tool",
      },
    ]);
    const commandRunnerCalls: Array<{
      command: string;
      role: "architect" | "engineer";
    }> = [];
    const fakeCommandRunner = {
      close() {},
      async executeArchitectCommand(): Promise<ContainerCommandResult> {
        commandRunnerCalls.push({
          command: "architect-command",
          role: "architect",
        });
        throw new Error("Architect command execution should not be used.");
      },
      async executeEngineerCommand(request: {
        accessMode?: "inspect" | "mutate";
        command: string;
      }): Promise<ContainerCommandResult> {
        commandRunnerCalls.push({ command: request.command, role: "engineer" });

        return {
          accessMode: request.accessMode ?? "mutate",
          command: request.command,
          containerName: "app",
          durationMs: 20,
          environment: {},
          executionTarget: "docker",
          exitCode: 0,
          role: "engineer",
          stderr: "",
          stdout: "tests passed\n",
          timestamp: "2026-04-14T12:00:30.000Z",
          workingDirectory: "/workspace",
        };
      },
    };

    const execution = await executeArchitectEngineerRun({
      architectModelClient: architect.client,
      createdAt: new Date("2026-04-14T12:00:00.000Z"),
      engineerModelClient: engineer.client,
      loadedConfig,
      now: () => new Date("2026-04-14T12:00:30.000Z"),
      projectCommandRunner: fakeCommandRunner,
      runId: "20260414T120000.000Z-abc128",
      task: "Update `src/example.ts` so it exports `2` instead of `1`.",
    });
    const currentBranch = readCurrentBranch(projectRoot);
    const headCommit = readHeadCommit(projectRoot);
    const commitSubjects = readCommitSubjects(projectRoot);

    expect(execution.result.status).toBe("success");
    expect(execution.result.convergence).toMatchObject({
      stepsToFirstCheck: 2,
      stepsToFirstEdit: 1,
    });
    expect(execution.stopReason).toBe("architect-approved");
    expect(readFileSync(path.join(projectRoot, "src/example.ts"), "utf8")).toBe(
      "export const value = 2;\n",
    );
    expect(commandRunnerCalls).toEqual([
      { command: "npm run test", role: "engineer" },
    ]);
    expect(currentBranch).toBe(
      "ae/run-20260414t120000-000z-abc128-update-src-example-ts-so-it-exports-2-instead-of",
    );
    expect(commitSubjects[0]).toBe(
      "ae(20260414T120000.000Z-abc128): engineer milestone 1",
    );
    expect(execution.result.git).toMatchObject({
      createdCommits: [
        {
          commitHash: headCommit,
          phase: "engineer-milestone",
        },
      ],
      dirtyWorkingTreeOutcome: "clean",
      dirtyWorkingTreePolicy: "stop",
      finalCommit: headCommit,
      runBranch: currentBranch,
      startingBranch: "main",
    });

    const runDir = execution.dossier.paths.runDirAbsolutePath;
    const finalReport = readFileSync(
      execution.dossier.paths.files.finalReport.absolutePath,
      "utf8",
    );
    const result = JSON.parse(
      readFileSync(execution.dossier.paths.files.result.absolutePath, "utf8"),
    ) as {
      artifacts: string[];
      convergence?: {
        stepsToFirstCheck: number | null;
        stepsToFirstEdit: number | null;
      };
      git?: { finalCommit?: string };
      status: string;
    };
    const events = parseJsonLines(
      execution.dossier.paths.files.events.absolutePath,
    );
    const architectToolCalls = events.filter(
      (event) => event.type === "tool-call" && event.role === "architect",
    );

    expect(
      readFileSync(path.join(runDir, "architect-plan.md"), "utf8"),
    ).toContain("## Steps");
    expect(
      readFileSync(path.join(runDir, "architect-review.md"), "utf8"),
    ).toContain("Decision: approve");
    expect(
      readFileSync(path.join(runDir, "engineer-task.md"), "utf8"),
    ).toContain("## Architect Plan");
    expect(finalReport).toContain("## Final Architect Review");
    expect(finalReport).toContain("## Git");
    expect(finalReport).toContain("Starting branch: main");
    expect(finalReport).toContain(`Run branch: ${currentBranch}`);
    expect(finalReport).toContain(headCommit);
    expect(finalReport).toContain("Stop reason: architect-approved");
    expect(result.status).toBe("success");
    expect(result.convergence).toMatchObject({
      stepsToFirstCheck: 2,
      stepsToFirstEdit: 1,
    });
    expect(result.git?.finalCommit).toBe(headCommit);
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        execution.dossier.paths.files.architectPlan.relativePath,
        execution.dossier.paths.files.architectReview.relativePath,
        execution.dossier.paths.files.engineerTask.relativePath,
        execution.dossier.paths.files.finalReport.relativePath,
      ]),
    );
    expect(
      readFileSync(execution.dossier.paths.files.diff.absolutePath, "utf8"),
    ).toContain("+export const value = 2;");
    expect(
      architectToolCalls.every(
        (event) =>
          event.toolName === "git.status" || event.toolName === "file.read",
      ),
    ).toBe(true);
  });

  it("lets the Architect use allowlisted MCP tools during planning and review", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);
    commitFile(projectRoot, "src/example.ts", "export const value = 1;\n");

    const loadedConfig = await createLoadedConfig(projectRoot, {
      mcpBlock: `allowlist = ["repo"]

[mcp.servers.repo]
transport = "stdio"
command = "node"
args = ["repo-mcp.js"]`,
    });
    const architect = createQueuedModelClient([
      {
        request: {
          name: "laravel-best-practices",
          server: "repo",
          toolName: "mcp.call",
        },
        summary: "Consult MCP best-practices guidance before planning.",
        type: "tool",
      },
      {
        acceptanceCriteria: ["`npm run test` passes"],
        steps: ["Update the source file", "Run the required test command"],
        summary: "Use the best-practices context and then verify.",
        type: "plan",
      },
      {
        request: {
          name: "laravel-best-practices",
          server: "repo",
          toolName: "mcp.call",
        },
        summary: "Re-check the final state against MCP guidance.",
        type: "tool",
      },
      {
        decision: "approve",
        summary:
          "The implementation aligns with the MCP guidance and passes verification.",
        type: "review",
      },
    ]);
    const engineer = createQueuedModelClient([
      {
        request: {
          content: "export const value = 2;\n",
          path: "src/example.ts",
          toolName: "file.write",
        },
        summary: "Apply the requested change.",
        type: "tool",
      },
      {
        request: {
          accessMode: "mutate",
          command: "npm run test",
          toolName: "command.execute",
        },
        stopWhenSuccessful: true,
        summary: "Verification passed after the update.",
        type: "tool",
      },
    ]);
    const fakeMcp = createFakeMcpClientFactory({
      repo: {
        callResult: {
          content: [{ text: "Prefer framework conventions.", type: "text" }],
          isError: false,
          name: "laravel-best-practices",
          server: "repo",
          toolName: "mcp.call",
        },
        listTools: [{ name: "laravel-best-practices", server: "repo" }],
      },
    });
    const fakeCommandRunner = {
      close() {},
      async executeArchitectCommand(): Promise<ContainerCommandResult> {
        throw new Error("Architect command execution should not be used.");
      },
      async executeEngineerCommand(request: {
        accessMode?: "inspect" | "mutate";
        command: string;
      }): Promise<ContainerCommandResult> {
        return {
          accessMode: request.accessMode ?? "mutate",
          command: request.command,
          containerName: "app",
          durationMs: 20,
          environment: {},
          executionTarget: "docker",
          exitCode: 0,
          role: "engineer",
          stderr: "",
          stdout: "tests passed\n",
          timestamp: "2026-04-14T12:00:30.000Z",
          workingDirectory: "/workspace",
        };
      },
    };

    const execution = await executeArchitectEngineerRun({
      architectModelClient: architect.client,
      createdAt: new Date("2026-04-14T12:00:00.000Z"),
      engineerModelClient: engineer.client,
      loadedConfig,
      mcpClientFactory: fakeMcp.factory,
      now: () => new Date("2026-04-14T12:00:30.000Z"),
      projectCommandRunner: fakeCommandRunner,
      runId: "20260414T120000.000Z-abc136",
      task: "Update `src/example.ts` using Architect MCP guidance before review.",
    });
    const events = parseJsonLines(
      execution.dossier.paths.files.events.absolutePath,
    );
    const architectMcpCalls = events.filter(
      (event) =>
        event.type === "tool-call" &&
        event.role === "architect" &&
        event.toolName === "mcp.call",
    );

    expect(execution.result.status).toBe("success");
    expect(fakeMcp.calls).toHaveLength(2);
    expect(architectMcpCalls).toHaveLength(2);
    expect(
      architect.requests.some((request) =>
        request.messages.some(
          (message) =>
            message.role === "tool" &&
            message.content.includes("Prefer framework conventions."),
        ),
      ),
    ).toBe(true);
  });

  it("accepts legacy Architect final outputs without type and records normalized action types", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);
    commitFile(projectRoot, "src/example.ts", "export const value = 1;\n");

    const loadedConfig = await createLoadedConfig(projectRoot);
    const architect = createQueuedModelClient([
      {
        acceptanceCriteria: ["`npm run test` passes"],
        steps: ["Update the source file", "Run the required test command"],
        summary: "Change the export and verify it.",
      },
      {
        decision: "approve",
        summary: "The change is complete and verified.",
      },
    ]);
    const engineer = createQueuedModelClient([
      {
        request: {
          content: "export const value = 2;\n",
          path: "src/example.ts",
          toolName: "file.write",
        },
        summary: "Update the source file.",
        type: "tool",
      },
      {
        request: {
          accessMode: "mutate",
          command: "npm run test",
          toolName: "command.execute",
        },
        stopWhenSuccessful: true,
        summary: "Verification passed after running the required test command.",
        type: "tool",
      },
    ]);
    const fakeCommandRunner = {
      close() {},
      async executeArchitectCommand(): Promise<ContainerCommandResult> {
        throw new Error("Architect command execution should not be used.");
      },
      async executeEngineerCommand(request: {
        accessMode?: "inspect" | "mutate";
        command: string;
      }): Promise<ContainerCommandResult> {
        return {
          accessMode: request.accessMode ?? "mutate",
          command: request.command,
          containerName: "app",
          durationMs: 20,
          environment: {},
          executionTarget: "docker",
          exitCode: 0,
          role: "engineer",
          stderr: "",
          stdout: "tests passed\n",
          timestamp: "2026-04-14T12:00:30.000Z",
          workingDirectory: "/workspace",
        };
      },
    };

    const execution = await executeArchitectEngineerRun({
      architectModelClient: architect.client,
      createdAt: new Date("2026-04-14T12:00:00.000Z"),
      engineerModelClient: engineer.client,
      loadedConfig,
      now: () => new Date("2026-04-14T12:00:30.000Z"),
      projectCommandRunner: fakeCommandRunner,
      runId: "20260414T120000.000Z-abc137",
      task: "Update `src/example.ts` so it exports `2` instead of `1`.",
    });
    const events = parseJsonLines(
      execution.dossier.paths.files.events.absolutePath,
    );
    const actionSelections = events.filter(
      (event) => event.type === "architect-action-selected",
    );

    expect(execution.result.status).toBe("success");
    expect(actionSelections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionType: "plan",
          phase: "architect-plan",
        }),
        expect.objectContaining({
          actionType: "review",
          phase: "architect-review",
        }),
      ]),
    );
  });

  it("stops safely before branching when the repository starts dirty", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);
    commitFile(projectRoot, "src/example.ts", "export const value = 1;\n");
    const loadedConfig = await createLoadedConfig(projectRoot);
    writeFileSync(
      path.join(projectRoot, "src/example.ts"),
      "export const value = 99;\n",
      "utf8",
    );
    const architect = createQueuedModelClient([
      {
        steps: ["This should not run"],
        summary: "Dirty-tree policy should stop earlier.",
        type: "plan",
      },
    ]);

    const execution = await executeArchitectEngineerRun({
      architectModelClient: architect.client,
      createdAt: new Date("2026-04-14T12:00:00.000Z"),
      loadedConfig,
      now: () => new Date("2026-04-14T12:00:05.000Z"),
      runId: "20260414T120000.000Z-abc133",
      task: "Attempt a run from a dirty repository.",
    });

    expect(execution.result.status).toBe("stopped");
    expect(execution.stopReason).toBe("dirty-working-tree");
    expect(architect.requests).toHaveLength(0);
    expect(readCurrentBranch(projectRoot)).toBe("main");
    expect(execution.result.git).toMatchObject({
      createdCommits: [],
      dirtyWorkingTreeOutcome: "stopped",
      dirtyWorkingTreePolicy: "stop",
      startingBranch: "main",
    });
    expect(execution.result.git?.initialWorkingTree?.isDirty).toBe(true);
    expect(
      readFileSync(
        execution.dossier.paths.files.finalReport.absolutePath,
        "utf8",
      ),
    ).toContain("Run branch: not created");
  });

  it("creates no empty commit when the run succeeds without a source diff", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);
    commitFile(projectRoot, "src/example.ts", "export const value = 1;\n");

    const loadedConfig = await createLoadedConfig(projectRoot);
    const startingCommit = readHeadCommit(projectRoot);
    const architect = createQueuedModelClient([
      {
        acceptanceCriteria: ["`npm run test` passes"],
        steps: ["Run the required test command"],
        summary: "Verify without changing the source.",
        type: "plan",
      },
      {
        decision: "approve",
        summary: "Verification is complete.",
        type: "review",
      },
    ]);
    const engineer = createQueuedModelClient([
      {
        request: {
          accessMode: "mutate",
          command: "npm run test",
          toolName: "command.execute",
        },
        stopWhenSuccessful: true,
        summary: "Verification passed immediately.",
        type: "tool",
      },
    ]);
    const fakeCommandRunner = {
      close() {},
      async executeArchitectCommand(): Promise<ContainerCommandResult> {
        throw new Error("Architect command execution should not be used.");
      },
      async executeEngineerCommand(request: {
        accessMode?: "inspect" | "mutate";
        command: string;
      }): Promise<ContainerCommandResult> {
        return {
          accessMode: request.accessMode ?? "mutate",
          command: request.command,
          containerName: "app",
          durationMs: 10,
          environment: {},
          executionTarget: "docker",
          exitCode: 0,
          role: "engineer",
          stderr: "",
          stdout: "tests passed\n",
          timestamp: "2026-04-14T12:00:10.000Z",
          workingDirectory: "/workspace",
        };
      },
    };

    const execution = await executeArchitectEngineerRun({
      architectModelClient: architect.client,
      createdAt: new Date("2026-04-14T12:00:00.000Z"),
      engineerModelClient: engineer.client,
      loadedConfig,
      now: () => new Date("2026-04-14T12:00:10.000Z"),
      projectCommandRunner: fakeCommandRunner,
      runId: "20260414T120000.000Z-abc134",
      task: "Verify the repository without changing any source files.",
    });

    expect(execution.result.status).toBe("success");
    expect(execution.result.git).toMatchObject({
      createdCommits: [],
      dirtyWorkingTreeOutcome: "clean",
      dirtyWorkingTreePolicy: "stop",
      finalCommit: startingCommit,
      startingCommit,
    });
    expect(readCommitSubjects(projectRoot)).toEqual([
      "harness init",
      "initial",
    ]);
  });

  it("carries failure notes across a revise cycle and reruns the Engineer with review feedback", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);
    commitFile(projectRoot, "src/example.ts", "export const value = 1;\n");

    const loadedConfig = await createLoadedConfig(projectRoot);
    const architect = createQueuedModelClient([
      {
        acceptanceCriteria: ["Export `2`", "Add a second named export"],
        steps: ["Update the value", "Add the follow-up export", "Run tests"],
        summary: "Make the requested code change and verify it.",
        type: "plan",
      },
      {
        decision: "revise",
        nextActions: ["Add `nextValue`", "Rerun `npm run test`"],
        summary:
          "The main fix landed, but the follow-up export is still missing.",
        type: "review",
      },
      {
        decision: "approve",
        summary: "The revised implementation is now complete.",
        type: "review",
      },
    ]);
    const engineer = createQueuedModelClient([
      {
        request: {
          content: "export const value = 2;\n",
          path: "src/example.ts",
          toolName: "file.write",
        },
        summary: "Apply the main fix.",
        type: "tool",
      },
      {
        request: {
          accessMode: "mutate",
          command: "npm run test",
          toolName: "command.execute",
        },
        stopWhenSuccessful: true,
        summary: "The first pass is verified.",
        type: "tool",
      },
      {
        request: {
          content: "export const value = 2;\nexport const nextValue = 3;\n",
          path: "src/example.ts",
          toolName: "file.write",
        },
        summary: "Apply the revision feedback.",
        type: "tool",
      },
      {
        request: {
          accessMode: "mutate",
          command: "npm run test",
          toolName: "command.execute",
        },
        stopWhenSuccessful: true,
        summary: "The revised change is verified.",
        type: "tool",
      },
    ]);
    let engineerCommandCalls = 0;
    const fakeCommandRunner = {
      close() {},
      async executeArchitectCommand(): Promise<ContainerCommandResult> {
        throw new Error("Architect command execution should not be used.");
      },
      async executeEngineerCommand(request: {
        accessMode?: "inspect" | "mutate";
        command: string;
      }): Promise<ContainerCommandResult> {
        engineerCommandCalls += 1;

        return {
          accessMode: request.accessMode ?? "mutate",
          command: request.command,
          containerName: "app",
          durationMs: 20,
          environment: {},
          executionTarget: "docker",
          exitCode: 0,
          role: "engineer",
          stderr: "",
          stdout: "tests passed\n",
          timestamp: "2026-04-14T12:01:00.000Z",
          workingDirectory: "/workspace",
        };
      },
    };

    const execution = await executeArchitectEngineerRun({
      architectModelClient: architect.client,
      createdAt: new Date("2026-04-14T12:00:00.000Z"),
      engineerModelClient: engineer.client,
      loadedConfig,
      now: () => new Date("2026-04-14T12:00:45.000Z"),
      projectCommandRunner: fakeCommandRunner,
      runId: "20260414T120000.000Z-abc129",
      task: "Update `src/example.ts` and add the requested follow-up export.",
    });

    expect(execution.result.status).toBe("success");
    expect(engineerCommandCalls).toBe(2);
    expect(
      readFileSync(path.join(projectRoot, "src/example.ts"), "utf8"),
    ).toContain("export const nextValue = 3;");

    const revisedEngineerRequest = engineer.requests.findLast((request) =>
      request.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.includes("Latest Architect Review"),
      ),
    );
    const secondEngineerUserMessage = revisedEngineerRequest?.messages.find(
      (message) => message.role === "user",
    );
    const failureNotes = readFileSync(
      execution.dossier.paths.files.failureNotes.absolutePath,
      "utf8",
    );

    expect(secondEngineerUserMessage?.content).toContain(
      "Latest Architect Review",
    );
    expect(secondEngineerUserMessage?.content).toContain("Add `nextValue`");
    expect(secondEngineerUserMessage?.content).toContain(
      "The main fix landed, but the follow-up export is still missing.",
    );
    expect(failureNotes).toContain("Architect Note");
    expect(failureNotes).toContain("Add `nextValue`");
  });

  it("fails the run when Architect review returns `fail`", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);
    commitFile(projectRoot, "src/example.ts", "export const value = 1;\n");

    const loadedConfig = await createLoadedConfig(projectRoot);
    const architect = createQueuedModelClient([
      {
        steps: ["Run the required check"],
        summary: "Verify the state before deciding.",
        type: "plan",
      },
      {
        decision: "fail",
        nextActions: ["Stop the run"],
        summary: "The requested outcome is not acceptable.",
        type: "review",
      },
    ]);
    const engineer = createQueuedModelClient([
      {
        request: {
          accessMode: "mutate",
          command: "npm run test",
          toolName: "command.execute",
        },
        stopWhenSuccessful: true,
        summary: "Run the required verification.",
        type: "tool",
      },
    ]);
    const fakeCommandRunner = {
      close() {},
      async executeArchitectCommand(): Promise<ContainerCommandResult> {
        throw new Error("Architect command execution should not be used.");
      },
      async executeEngineerCommand(request: {
        accessMode?: "inspect" | "mutate";
        command: string;
      }): Promise<ContainerCommandResult> {
        return {
          accessMode: request.accessMode ?? "mutate",
          command: request.command,
          containerName: "app",
          durationMs: 20,
          environment: {},
          executionTarget: "docker",
          exitCode: 0,
          role: "engineer",
          stderr: "",
          stdout: "tests passed\n",
          timestamp: "2026-04-14T12:01:00.000Z",
          workingDirectory: "/workspace",
        };
      },
    };

    const execution = await executeArchitectEngineerRun({
      architectModelClient: architect.client,
      createdAt: new Date("2026-04-14T12:00:00.000Z"),
      engineerModelClient: engineer.client,
      loadedConfig,
      now: () => new Date("2026-04-14T12:00:30.000Z"),
      projectCommandRunner: fakeCommandRunner,
      runId: "20260414T120000.000Z-abc130",
      task: "Run the review flow.",
    });
    const currentBranch = readCurrentBranch(projectRoot);

    expect(execution.result.status).toBe("failed");
    expect(execution.stopReason).toBe("architect-failed");
    expect(execution.result.git).toMatchObject({
      dirtyWorkingTreeOutcome: "clean",
      dirtyWorkingTreePolicy: "stop",
      runBranch: currentBranch,
      startingBranch: "main",
    });
    expect(
      readFileSync(
        execution.dossier.paths.files.architectReview.absolutePath,
        "utf8",
      ),
    ).toContain("Decision: fail");
  });

  it("stops on global timeout before planning", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);
    commitFile(projectRoot, "src/example.ts", "export const value = 1;\n");

    const loadedConfig = await createLoadedConfig(projectRoot);
    let nowCallCount = 0;
    const now = () => {
      nowCallCount += 1;

      return new Date(
        nowCallCount < 3
          ? "2026-04-14T12:00:00.000Z"
          : "2026-04-14T13:30:00.000Z",
      );
    };
    const architect = createQueuedModelClient([
      {
        steps: ["This should never be used."],
        summary: "Timeout should stop first.",
        type: "plan",
      },
    ]);

    const execution = await executeArchitectEngineerRun({
      architectModelClient: architect.client,
      loadedConfig,
      now,
      runId: "20260414T120000.000Z-abc131",
      task: "Time out before planning.",
      timeoutMs: 1,
    });

    expect(execution.result.status).toBe("stopped");
    expect(execution.stopReason).toBe("timeout");
    expect(architect.requests).toHaveLength(0);
    expect(
      readFileSync(
        execution.dossier.paths.files.finalReport.absolutePath,
        "utf8",
      ),
    ).toContain("Stop reason: timeout");
  });

  it("stops once the failed required-check threshold is reached", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);
    commitFile(projectRoot, "src/example.ts", "export const value = 1;\n");

    const loadedConfig = await createLoadedConfig(projectRoot);
    const architect = createQueuedModelClient([
      {
        steps: ["Keep running the required check until it passes"],
        summary: "Focus on the verification loop.",
        type: "plan",
      },
    ]);
    const engineer = createQueuedModelClient([
      {
        request: {
          accessMode: "mutate",
          command: "npm run test",
          toolName: "command.execute",
        },
        summary: "Run the first required check.",
        type: "tool",
      },
      {
        request: {
          accessMode: "mutate",
          command: "npm run test",
          toolName: "command.execute",
        },
        summary: "Run the second required check.",
        type: "tool",
      },
    ]);
    let callCount = 0;
    const fakeCommandRunner = {
      close() {},
      async executeArchitectCommand(): Promise<ContainerCommandResult> {
        throw new Error("Architect command execution should not be used.");
      },
      async executeEngineerCommand(request: {
        accessMode?: "inspect" | "mutate";
        command: string;
      }): Promise<ContainerCommandResult> {
        callCount += 1;

        return {
          accessMode: request.accessMode ?? "mutate",
          command: request.command,
          containerName: "app",
          durationMs: 20,
          environment: {},
          executionTarget: "docker",
          exitCode: 1,
          role: "engineer",
          stderr: "tests failed\n",
          stdout: "",
          timestamp: "2026-04-14T12:02:00.000Z",
          workingDirectory: "/workspace",
        };
      },
    };

    const execution = await executeArchitectEngineerRun({
      architectModelClient: architect.client,
      createdAt: new Date("2026-04-14T12:00:00.000Z"),
      engineerModelClient: engineer.client,
      loadedConfig,
      maxConsecutiveFailedChecks: 2,
      now: () => new Date("2026-04-14T12:00:30.000Z"),
      projectCommandRunner: fakeCommandRunner,
      runId: "20260414T120000.000Z-abc132",
      task: "Stop after the failed-check threshold.",
    });

    expect(callCount).toBe(2);
    expect(execution.result.status).toBe("failed");
    expect(execution.stopReason).toBe("max-consecutive-failed-checks");
    expect(
      readFileSync(
        execution.dossier.paths.files.failureNotes.absolutePath,
        "utf8",
      ),
    ).toContain("Required check failed 2 consecutive times.");
  });

  it("keeps passing tests as the minimum completion gate even when Architect adds extra goals", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);
    commitFile(projectRoot, "src/example.ts", "export const value = 1;\n");

    const loadedConfig = await createLoadedConfig(projectRoot);
    const architect = createQueuedModelClient([
      {
        acceptanceCriteria: ["Export `2`", "Update the summary line"],
        steps: ["Update the file", "Verify with tests"],
        summary: "Make the code change and meet the extra review goals.",
        type: "plan",
      },
      {
        decision: "approve",
        summary: "The change and follow-up goals are complete.",
        type: "review",
      },
    ]);
    const engineer = createQueuedModelClient([
      {
        request: {
          content: "export const value = 2;\n",
          path: "src/example.ts",
          toolName: "file.write",
        },
        summary: "Apply the code change.",
        type: "tool",
      },
      {
        outcome: "complete",
        summary: "The requested change is complete.",
        type: "final",
      },
      {
        request: {
          accessMode: "mutate",
          command: "npm run test",
          toolName: "command.execute",
        },
        stopWhenSuccessful: true,
        summary: "Tests pass after the change.",
        type: "tool",
      },
    ]);
    const fakeCommandRunner = {
      close() {},
      async executeArchitectCommand(): Promise<ContainerCommandResult> {
        throw new Error("Architect command execution should not be used.");
      },
      async executeEngineerCommand(request: {
        accessMode?: "inspect" | "mutate";
        command: string;
      }): Promise<ContainerCommandResult> {
        return {
          accessMode: request.accessMode ?? "mutate",
          command: request.command,
          containerName: "app",
          durationMs: 20,
          environment: {},
          executionTarget: "docker",
          exitCode: 0,
          role: "engineer",
          stderr: "",
          stdout: "tests passed\n",
          timestamp: "2026-04-14T12:03:00.000Z",
          workingDirectory: "/workspace",
        };
      },
    };

    const execution = await executeArchitectEngineerRun({
      architectModelClient: architect.client,
      createdAt: new Date("2026-04-14T12:00:00.000Z"),
      engineerModelClient: engineer.client,
      loadedConfig,
      now: () => new Date("2026-04-14T12:03:00.000Z"),
      projectCommandRunner: fakeCommandRunner,
      runId: "20260414T120000.000Z-abc135",
      task: "Update `src/example.ts` and satisfy the Architect follow-up goals.",
    });

    expect(execution.result.status).toBe("success");
    expect(
      engineer.requests.some((request) =>
        request.messages.some(
          (message) =>
            message.role === "user" &&
            message.content.includes(
              "Required check `npm run test` has not passed yet.",
            ),
        ),
      ),
    ).toBe(true);
    expect(
      readFileSync(
        execution.dossier.paths.files.finalReport.absolutePath,
        "utf8",
      ),
    ).toContain("Mandatory test gate");
  });
});
