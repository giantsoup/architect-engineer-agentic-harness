import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  executeEngineerTask,
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
  McpServerUnavailableError,
} from "../../src/index.js";

function createTempProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "aeah-engineer-task-"));
}

async function startMockServer(
  responses: readonly Record<string, unknown>[],
): Promise<{ close: () => Promise<void>; url: string }> {
  const queuedResponses = [...responses];
  const server = createServer(async (request, response) => {
    await readRequestBody(request);
    const nextResponse = queuedResponses.shift();

    if (nextResponse === undefined) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Unexpected extra Engineer model request.",
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

async function createLoadedConfig(options: {
  engineerBaseUrl: string;
  mcpBlock?: string;
  projectRoot: string;
  stopConditions?: {
    maxEngineerAttempts?: number;
    maxIterations?: number;
  };
}): Promise<LoadedHarnessConfig> {
  await initializeProject(options.projectRoot);

  const configPath = path.join(options.projectRoot, "agent-harness.toml");
  const updatedConfig = readFileSync(configPath, "utf8")
    .replace(
      'baseUrl = "http://127.0.0.1:8080/v1"',
      `baseUrl = ${JSON.stringify(options.engineerBaseUrl)}`,
    )
    .replace("maxEngineerAttempts = 5", () => {
      const value = options.stopConditions?.maxEngineerAttempts ?? 5;
      return `maxEngineerAttempts = ${value}`;
    })
    .replace("maxIterations = 12", () => {
      const value = options.stopConditions?.maxIterations ?? 12;
      return `maxIterations = ${value}`;
    })
    .replace("allowlist = []", options.mcpBlock ?? "allowlist = []");

  writeFileSync(configPath, updatedConfig, "utf8");

  return loadHarnessConfig({ projectRoot: options.projectRoot });
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

function parseJsonLines(filePath: string): Record<string, unknown>[] {
  const contents = readFileSync(filePath, "utf8").trim();

  if (contents.length === 0) {
    return [];
  }

  return contents
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
    );
  }

  return Buffer.concat(chunks).toString("utf8");
}

function createQueuedModelClient<TStructured>(
  outputs: readonly TStructured[],
): {
  client: {
    chat<TRequestStructured>(
      request: ModelChatRequest<TRequestStructured>,
    ): Promise<ModelChatResponse<TRequestStructured>>;
  };
} {
  const queue = [...outputs];
  let requestCount = 0;

  return {
    client: {
      async chat<TRequestStructured>(
        request: ModelChatRequest<TRequestStructured>,
      ): Promise<ModelChatResponse<TRequestStructured>> {
        void request;
        const nextOutput = queue.shift();

        if (nextOutput === undefined) {
          throw new Error("Unexpected extra model request.");
        }

        requestCount += 1;
        return {
          id: `mock-${requestCount}`,
          rawContent: JSON.stringify(nextOutput),
          role: "assistant",
          structuredOutput: nextOutput as TRequestStructured,
        };
      },
    },
  };
}

function createCapturingModelClient<TStructured>(
  outputs: readonly TStructured[],
): {
  client: {
    chat<TRequestStructured>(
      request: ModelChatRequest<TRequestStructured>,
    ): Promise<ModelChatResponse<TRequestStructured>>;
  };
  requests: Array<ModelChatRequest<unknown>>;
} {
  const queue = [...outputs];
  const requests: Array<ModelChatRequest<unknown>> = [];
  let requestCount = 0;

  return {
    client: {
      async chat<TRequestStructured>(
        request: ModelChatRequest<TRequestStructured>,
      ): Promise<ModelChatResponse<TRequestStructured>> {
        requests.push(request as ModelChatRequest<unknown>);
        const nextOutput = queue.shift();

        if (nextOutput === undefined) {
          throw new Error("Unexpected extra model request.");
        }

        requestCount += 1;
        return {
          id: `mock-${requestCount}`,
          rawContent: JSON.stringify(nextOutput),
          role: "assistant",
          structuredOutput: nextOutput as TRequestStructured,
        };
      },
    },
    requests,
  };
}

type ToolCallEventRecord = {
  error?: { code?: string };
  request?: { server?: string };
  result?: { content?: Array<{ text?: string }> };
  toolName?: string;
  type?: string;
};

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

describe("executeEngineerTask", () => {
  const projectRoots: string[] = [];
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));

    for (const projectRoot of projectRoots.splice(0)) {
      rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it("completes an Engineer task end-to-end, edits files through built-in tools, runs checks, and writes dossier artifacts", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);

    const modelServer = await startMockServer([
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
        summary:
          "Verification passed after running the configured test command.",
        type: "tool",
      },
    ]);
    servers.push(modelServer);

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: `${modelServer.url}/v1`,
      projectRoot,
    });
    const sourcePath = path.join(projectRoot, "src", "example.ts");

    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, "export const value = 1;\n", "utf8");
    expect(
      spawnSync("git", ["add", "src/example.ts"], {
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

    const runnerCalls: Array<{
      accessMode: string | undefined;
      command: string;
    }> = [];
    const fakeCommandRunner = {
      close() {},
      async executeArchitectCommand(): Promise<ContainerCommandResult> {
        throw new Error("Architect command execution should not be used.");
      },
      async executeEngineerCommand(request: {
        accessMode?: "inspect" | "mutate";
        command: string;
      }): Promise<ContainerCommandResult> {
        runnerCalls.push({
          accessMode: request.accessMode,
          command: request.command,
        });

        return {
          accessMode: request.accessMode ?? "mutate",
          command: request.command,
          containerName: "app",
          durationMs: 25,
          environment: {},
          executionTarget: "docker",
          exitCode: 0,
          role: "engineer",
          stderr: "",
          stdout: "tests passed\n",
          timestamp: "2026-04-13T12:00:05.000Z",
          workingDirectory: "/workspace",
        };
      },
    };

    const execution = await executeEngineerTask({
      createdAt: new Date("2026-04-13T12:00:00.000Z"),
      loadedConfig,
      projectCommandRunner: fakeCommandRunner,
      runId: "20260413T120000.000Z-abcdef",
      task: "## Goal\n\nChange `src/example.ts` so the exported value becomes `2`.\n",
    });

    expect(execution.result.status).toBe("success");
    expect(execution.stopReason).toBe("passing-checks");
    expect(execution.iterationCount).toBe(2);
    expect(readFileSync(sourcePath, "utf8")).toBe("export const value = 2;\n");
    expect(runnerCalls).toEqual([
      {
        accessMode: "mutate",
        command: "npm run test",
      },
    ]);

    const engineerTask = readFileSync(
      execution.dossier.paths.files.engineerTask.absolutePath,
      "utf8",
    );
    const checks = JSON.parse(
      readFileSync(execution.dossier.paths.files.checks.absolutePath, "utf8"),
    ) as {
      checks: Array<{ command: string; status: string }>;
    };
    const result = JSON.parse(
      readFileSync(execution.dossier.paths.files.result.absolutePath, "utf8"),
    ) as {
      artifacts?: string[];
      status: string;
      summary: string;
    };
    const finalReport = readFileSync(
      execution.dossier.paths.files.finalReport.absolutePath,
      "utf8",
    );
    const diffPatch = readFileSync(
      execution.dossier.paths.files.diff.absolutePath,
      "utf8",
    );
    const events = parseJsonLines(
      execution.dossier.paths.files.events.absolutePath,
    );

    expect(engineerTask).toContain("# Engineer Task Brief");
    expect(engineerTask).toContain("## Available Built-in Tools");
    expect(engineerTask).toContain("### `file.write`");
    expect(checks.checks).toEqual([
      {
        command: "npm run test",
        durationMs: 25,
        exitCode: 0,
        name: "test",
        status: "passed",
        summary: "Required check passed.",
      },
    ]);
    expect(result).toMatchObject({
      status: "success",
      summary: "Verification passed after running the configured test command.",
    });
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        execution.dossier.paths.files.run.relativePath,
        execution.dossier.paths.files.events.relativePath,
        execution.dossier.paths.files.commandLog.relativePath,
        execution.dossier.paths.files.engineerTask.relativePath,
        execution.dossier.paths.files.checks.relativePath,
        execution.dossier.paths.files.finalReport.relativePath,
        execution.dossier.paths.files.result.relativePath,
      ]),
    );
    expect(finalReport).toContain("## Outcome");
    expect(finalReport).toContain(
      "Verification passed after running the configured test command.",
    );
    expect(finalReport).toContain("## Workspace");
    expect(diffPatch).toContain("-export const value = 1;");
    expect(diffPatch).toContain("+export const value = 2;");
    expect(events.some((event) => event.type === "model-request")).toBe(true);
    expect(events.some((event) => event.type === "model-response")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "tool-call" && event.toolName === "file.write",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "tool-call" && event.toolName === "command.execute",
      ),
    ).toBe(true);
  });

  it("stops cleanly on timeout before requesting another model step", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: "http://127.0.0.1:65535/v1",
      projectRoot,
    });
    let modelCalls = 0;
    let nowCallCount = 0;
    const now = () => {
      nowCallCount += 1;

      return new Date(nowCallCount < 3 ? 0 : 5);
    };
    const modelClient = {
      async chat<TStructured>(
        request: ModelChatRequest<TStructured>,
      ): Promise<ModelChatResponse<TStructured>> {
        void request;
        modelCalls += 1;

        throw new Error("Model should not be called after timeout.");
      },
    };

    const execution = await executeEngineerTask({
      loadedConfig,
      modelClient,
      now,
      runId: "20260413T120000.000Z-abcdea",
      task: "Timeout before the first step.",
      timeoutMs: 1,
    });

    expect(execution.result.status).toBe("stopped");
    expect(execution.stopReason).toBe("timeout");
    expect(modelCalls).toBe(0);
    expect(
      readFileSync(
        execution.dossier.paths.files.finalReport.absolutePath,
        "utf8",
      ),
    ).toContain("Stop reason: timeout");
  });

  it("stops cleanly after hitting the failed-check threshold", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);

    const modelServer = await startMockServer([
      {
        request: {
          accessMode: "mutate",
          command: "npm run test",
          toolName: "command.execute",
        },
        summary: "Run the required check once.",
        type: "tool",
      },
      {
        request: {
          accessMode: "mutate",
          command: "npm run test",
          toolName: "command.execute",
        },
        summary: "Run the required check again.",
        type: "tool",
      },
    ]);
    servers.push(modelServer);

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: `${modelServer.url}/v1`,
      projectRoot,
      stopConditions: {
        maxEngineerAttempts: 2,
      },
    });
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
          durationMs: 10,
          environment: {},
          executionTarget: "docker",
          exitCode: 1,
          role: "engineer",
          stderr: "tests failed\n",
          stdout: "",
          timestamp: "2026-04-13T12:10:00.000Z",
          workingDirectory: "/workspace",
        };
      },
    };

    const execution = await executeEngineerTask({
      loadedConfig,
      projectCommandRunner: fakeCommandRunner,
      runId: "20260413T121000.000Z-abcdeb",
      task: "Keep running the configured test command until the stop condition triggers.",
    });

    expect(callCount).toBe(2);
    expect(execution.result.status).toBe("failed");
    expect(execution.stopReason).toBe("max-consecutive-failed-checks");
    expect(execution.result.artifacts).toEqual(
      expect.arrayContaining([
        execution.dossier.paths.files.failureNotes.relativePath,
      ]),
    );

    const checks = JSON.parse(
      readFileSync(execution.dossier.paths.files.checks.absolutePath, "utf8"),
    ) as {
      checks: Array<{ status: string }>;
    };

    expect(checks.checks).toHaveLength(2);
    expect(checks.checks.every((check) => check.status === "failed")).toBe(
      true,
    );
    expect(
      readFileSync(
        execution.dossier.paths.files.failureNotes.absolutePath,
        "utf8",
      ),
    ).toContain("Required check failed 2 consecutive times.");
  });

  it("invokes an allowlisted MCP server during a run and records MCP activity in the dossier", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: "http://127.0.0.1:65535/v1",
      mcpBlock: `allowlist = ["repo"]

[mcp.servers.repo]
transport = "stdio"
command = "node"
args = ["repo-mcp.js"]`,
      projectRoot,
    });
    const modelClient = createQueuedModelClient([
      {
        request: {
          name: "lookup",
          server: "repo",
          toolName: "mcp.call",
        },
        summary: "Inspect repository context through MCP.",
        type: "tool",
      },
      {
        request: {
          accessMode: "mutate",
          command: "npm run test",
          toolName: "command.execute",
        },
        stopWhenSuccessful: true,
        summary: "Checks passed after the MCP-assisted inspection.",
        type: "tool",
      },
    ]).client;
    const fakeMcp = createFakeMcpClientFactory({
      repo: {
        callResult: {
          content: [{ text: "resolved context", type: "text" }],
          isError: false,
          name: "lookup",
          server: "repo",
          toolName: "mcp.call",
        },
        listTools: [{ name: "lookup", server: "repo" }],
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
          durationMs: 15,
          environment: {},
          executionTarget: "docker",
          exitCode: 0,
          role: "engineer",
          stderr: "",
          stdout: "tests passed\n",
          timestamp: "2026-04-13T12:20:00.000Z",
          workingDirectory: "/workspace",
        };
      },
    };

    const execution = await executeEngineerTask({
      loadedConfig,
      mcpClientFactory: fakeMcp.factory,
      modelClient,
      projectCommandRunner: fakeCommandRunner,
      runId: "20260413T122000.000Z-abcded",
      task: "Use MCP context before running the required test command.",
    });
    const events = parseJsonLines(
      execution.dossier.paths.files.events.absolutePath,
    );
    const finalReport = readFileSync(
      execution.dossier.paths.files.finalReport.absolutePath,
      "utf8",
    );

    expect(execution.result.status).toBe("success");
    expect(fakeMcp.calls).toEqual([
      {
        name: "lookup",
        server: "repo",
        toolName: "mcp.call",
      },
    ]);
    expect(
      events.some((event) => {
        const typedEvent = event as ToolCallEventRecord;

        return (
          typedEvent.type === "tool-call" &&
          typedEvent.toolName === "mcp.call" &&
          typedEvent.request?.server === "repo" &&
          typedEvent.result?.content?.[0]?.text === "resolved context"
        );
      }),
    ).toBe(true);
    expect(finalReport).toContain("MCP calls recorded: 1");
    expect(finalReport).toContain("repo.lookup (completed)");
  });

  it("blocks non-allowlisted MCP servers during a run", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: "http://127.0.0.1:65535/v1",
      mcpBlock: `allowlist = []

[mcp.servers.repo]
transport = "stdio"
command = "node"
args = ["repo-mcp.js"]`,
      projectRoot,
      stopConditions: {
        maxIterations: 2,
      },
    });
    const modelClient = createQueuedModelClient([
      {
        request: {
          name: "lookup",
          server: "repo",
          toolName: "mcp.call",
        },
        summary: "Try the blocked MCP server.",
        type: "tool",
      },
      {
        blockers: ["MCP server access is blocked by config."],
        outcome: "blocked",
        summary: "Cannot continue without the blocked MCP server.",
        type: "final",
      },
    ]).client;
    const execution = await executeEngineerTask({
      loadedConfig,
      modelClient,
      runId: "20260413T122100.000Z-abcded",
      task: "Attempt to use a blocked MCP server.",
    });
    const events = parseJsonLines(
      execution.dossier.paths.files.events.absolutePath,
    );

    expect(execution.result.status).toBe("failed");
    expect(execution.stopReason).toBe("blocked");
    expect(
      events.some((event) => {
        const typedEvent = event as ToolCallEventRecord;

        return (
          typedEvent.type === "tool-call" &&
          typedEvent.toolName === "mcp.call" &&
          typedEvent.error?.code === "mcp-not-allowed"
        );
      }),
    ).toBe(true);
  });

  it("records unavailable MCP server diagnostics while keeping built-in tools usable", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: "http://127.0.0.1:65535/v1",
      mcpBlock: `allowlist = ["repo"]

[mcp.servers.repo]
transport = "stdio"
command = "node"
args = ["repo-mcp.js"]`,
      projectRoot,
    });
    const sourcePath = path.join(projectRoot, "src", "example.ts");

    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, "export const value = 1;\n", "utf8");

    const modelClient = createQueuedModelClient([
      {
        request: {
          content: "export const value = 2;\n",
          path: "src/example.ts",
          toolName: "file.write",
        },
        summary: "Apply the built-in file write anyway.",
        type: "tool",
      },
      {
        request: {
          accessMode: "mutate",
          command: "npm run test",
          toolName: "command.execute",
        },
        stopWhenSuccessful: true,
        summary: "Built-in tools still complete the run.",
        type: "tool",
      },
    ]).client;
    const fakeMcp = createFakeMcpClientFactory({
      repo: {
        listTools: new McpServerUnavailableError(
          "MCP server `repo` did not answer `listTools`: spawn failed",
        ),
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
          durationMs: 10,
          environment: {},
          executionTarget: "docker",
          exitCode: 0,
          role: "engineer",
          stderr: "",
          stdout: "tests passed\n",
          timestamp: "2026-04-13T12:30:00.000Z",
          workingDirectory: "/workspace",
        };
      },
    };

    const execution = await executeEngineerTask({
      loadedConfig,
      mcpClientFactory: fakeMcp.factory,
      modelClient,
      projectCommandRunner: fakeCommandRunner,
      runId: "20260413T123000.000Z-abcded",
      task: "Keep using built-in tools even if MCP is unavailable.",
    });
    const engineerTask = readFileSync(
      execution.dossier.paths.files.engineerTask.absolutePath,
      "utf8",
    );
    const finalReport = readFileSync(
      execution.dossier.paths.files.finalReport.absolutePath,
      "utf8",
    );

    expect(execution.result.status).toBe("success");
    expect(readFileSync(sourcePath, "utf8")).toBe("export const value = 2;\n");
    expect(engineerTask).toContain(
      "MCP server `repo` did not answer `listTools`",
    );
    expect(finalReport).toContain("## MCP Diagnostics");
    expect(finalReport).toContain("spawn failed");
    expect(finalReport).toContain("MCP calls recorded: 0");
  });

  it("adds a convergence reminder after too many consecutive exploration steps", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: "http://127.0.0.1:65535/v1",
      projectRoot,
      stopConditions: {
        maxIterations: 20,
      },
    });
    const outputs = [
      ...Array.from({ length: 12 }, (_, index) => ({
        request: { path: ".", toolName: "file.list" as const },
        summary: `Explore step ${index + 1}`,
        type: "tool" as const,
      })),
      {
        blockers: ["stop after reminder"],
        outcome: "blocked" as const,
        summary: "Blocked after reminder",
        type: "final" as const,
      },
    ];
    const { client, requests } = createCapturingModelClient(outputs);

    const execution = await executeEngineerTask({
      loadedConfig,
      modelClient: client,
      persistFinalArtifacts: false,
      task: "Find one tiny improvement.",
    });

    expect(execution.stopReason).toBe("blocked");
    expect(requests).toHaveLength(13);
    expect(
      requests[12]?.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.includes("Stop broad exploration."),
      ),
    ).toBe(true);
  });

  it("truncates large file reads before feeding tool results back to the engineer model", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);
    const largeReadmePath = path.join(projectRoot, "README.md");

    writeFileSync(largeReadmePath, `${"A".repeat(6000)}\n`, "utf8");

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: "http://127.0.0.1:65535/v1",
      projectRoot,
    });
    const outputs = [
      {
        request: { path: "README.md", toolName: "file.read" as const },
        summary: "Read README",
        type: "tool" as const,
      },
      {
        blockers: ["stop after read"],
        outcome: "blocked" as const,
        summary: "Blocked after read",
        type: "final" as const,
      },
    ];
    const { client, requests } = createCapturingModelClient(outputs);

    const execution = await executeEngineerTask({
      loadedConfig,
      modelClient: client,
      persistFinalArtifacts: false,
      task: "Inspect README and stop.",
    });

    expect(execution.stopReason).toBe("blocked");
    expect(requests).toHaveLength(2);

    const toolMessage = requests[1]?.messages.find(
      (message) => message.role === "tool" && message.name === "file.read",
    );

    expect(toolMessage?.content).toContain("[truncated ");
    expect(toolMessage?.content.length).toBeLessThan(6000);
  });
});
