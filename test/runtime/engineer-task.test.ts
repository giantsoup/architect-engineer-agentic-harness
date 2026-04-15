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

type MockModelResponse =
  | Record<string, unknown>
  | {
      content?: string;
      tool_calls?: Array<{
        function: {
          arguments: string;
          name: string;
        };
        id: string;
        type: "function";
      }>;
    };

async function startMockServer(
  responses: readonly MockModelResponse[],
): Promise<{ close: () => Promise<void>; url: string }> {
  return startMockServerWithBodies(responses).then(({ close, url }) => ({
    close,
    url,
  }));
}

async function startMockServerWithBodies(
  responses: readonly MockModelResponse[],
): Promise<{
  close: () => Promise<void>;
  requestBodies: Array<Record<string, unknown>>;
  url: string;
}> {
  const queuedResponses = [...responses];
  const requestBodies: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    requestBodies.push(
      JSON.parse(await readRequestBody(request)) as Record<string, unknown>,
    );
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
    const assistantMessage = normalizeMockAssistantMessage(nextResponse);
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: assistantMessage,
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
    requestBodies,
    url: `http://127.0.0.1:${address.port}`,
  };
}

function normalizeMockAssistantMessage(response: MockModelResponse): {
  content?: string;
  role: "assistant";
  tool_calls?: Array<{
    function: {
      arguments: string;
      name: string;
    };
    id: string;
    type: "function";
  }>;
} {
  if (
    "tool_calls" in response ||
    ("content" in response && !("request" in response) && !("type" in response))
  ) {
    const content =
      typeof response.content === "string" ? response.content : undefined;
    const toolCalls = Array.isArray(response.tool_calls)
      ? response.tool_calls
      : undefined;

    return {
      ...(content === undefined ? {} : { content }),
      role: "assistant",
      ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
    };
  }

  return {
    content: JSON.stringify(response),
    role: "assistant",
  };
}

async function createLoadedConfig(options: {
  engineerBaseUrl: string;
  engineerModel?: string;
  engineerProvider?: string;
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
    .replace(
      'model = "replace-with-your-engineer-model"',
      `model = ${JSON.stringify(options.engineerModel ?? "replace-with-your-engineer-model")}`,
    )
    .replace(
      'provider = "llama.cpp"',
      `provider = ${JSON.stringify(options.engineerProvider ?? "llama.cpp")}`,
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

function nativeToolCallResponse(
  toolName: string,
  argumentsObject: Record<string, unknown>,
  content?: string,
): MockModelResponse {
  return {
    ...(content === undefined ? {} : { content }),
    tool_calls: [
      {
        function: {
          arguments: JSON.stringify(argumentsObject),
          name: toolName,
        },
        id: `call_${toolName.replace(/\W+/gu, "_")}`,
        type: "function",
      },
    ],
  };
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
      convergence?: {
        explorationBudget: number;
        stepsToFirstCheck: number | null;
        stepsToFirstEdit: number | null;
      };
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
    expect(engineerTask).toContain("## Execution Order");
    expect(engineerTask).toContain(
      "Follow the objective literally and prefer the smallest correct action.",
    );
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
      convergence: {
        explorationBudget: 12,
        stepsToFirstCheck: 2,
        stepsToFirstEdit: 1,
      },
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
    expect(finalReport).toContain("## Convergence");
    expect(finalReport).toContain("- Steps to first edit: 1");
    expect(finalReport).toContain("- Steps to first required check: 2");
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

  it("smoke: completes a hosted-style native tool-call loop through the shared runtime", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);

    const modelServer = await startMockServerWithBodies([
      nativeToolCallResponse(
        "file.write",
        {
          content: "export const value = 3;\n",
          path: "src/example.ts",
        },
        "Update the source file.",
      ),
      nativeToolCallResponse(
        "command.execute",
        {
          accessMode: "mutate",
          command: "npm run test",
        },
        "Run the required check.\nSTOP_ON_SUCCESS",
      ),
    ]);
    servers.push(modelServer);

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: `${modelServer.url}/v1`,
      engineerProvider: "openai-compatible",
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
          durationMs: 12,
          environment: {},
          executionTarget: "docker",
          exitCode: 0,
          role: "engineer",
          stderr: "",
          stdout: "tests passed\n",
          timestamp: "2026-04-14T12:00:05.000Z",
          workingDirectory: "/workspace",
        };
      },
    };

    const execution = await executeEngineerTask({
      loadedConfig,
      projectCommandRunner: fakeCommandRunner,
      runId: "20260414T120000.000Z-abcdaa",
      task: "Update `src/example.ts` so the exported value becomes `3`.",
    });

    expect(execution.result.status).toBe("success");
    expect(execution.stopReason).toBe("passing-checks");
    expect(readFileSync(sourcePath, "utf8")).toBe("export const value = 3;\n");
    expect(modelServer.requestBodies).toHaveLength(2);
    expect(modelServer.requestBodies[0]?.tools).toBeDefined();
    expect(modelServer.requestBodies[0]?.response_format).toBeUndefined();
    expect(modelServer.requestBodies[0]?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          function: expect.objectContaining({
            name: "file.write",
          }),
          type: "function",
        }),
      ]),
    );
    const assistantMessages = (
      (modelServer.requestBodies[1]?.messages as Array<{
        content?: string;
        role?: string;
      }>) ?? []
    ).filter((message) => message.role === "assistant");

    expect(
      assistantMessages.some((message) =>
        String(message.content ?? "").includes("Tool call:"),
      ),
    ).toBe(false);
  });

  it("smoke: completes a local llama.cpp-style native tool-call loop through the same runtime", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);

    const modelServer = await startMockServerWithBodies([
      nativeToolCallResponse(
        "file.write",
        {
          content: "export const value = 4;\n",
          path: "src/example.ts",
        },
        "Apply the requested edit.",
      ),
      nativeToolCallResponse(
        "command.execute",
        {
          accessMode: "mutate",
          command: "npm run test",
        },
        "Verify the change.\nSTOP_ON_SUCCESS",
      ),
    ]);
    servers.push(modelServer);

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: `${modelServer.url}/v1`,
      engineerProvider: "llama.cpp",
      projectRoot,
    });
    const sourcePath = path.join(projectRoot, "src", "example.ts");

    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, "export const value = 1;\n", "utf8");

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
          durationMs: 8,
          environment: {},
          executionTarget: "docker",
          exitCode: 0,
          role: "engineer",
          stderr: "",
          stdout: "tests passed\n",
          timestamp: "2026-04-14T12:01:05.000Z",
          workingDirectory: "/workspace",
        };
      },
    };

    const execution = await executeEngineerTask({
      loadedConfig,
      projectCommandRunner: fakeCommandRunner,
      runId: "20260414T120100.000Z-abcdab",
      task: "Update `src/example.ts` so the exported value becomes `4`.",
    });

    expect(execution.result.status).toBe("success");
    expect(execution.stopReason).toBe("passing-checks");
    expect(readFileSync(sourcePath, "utf8")).toBe("export const value = 4;\n");
    expect(modelServer.requestBodies).toHaveLength(2);
    expect(modelServer.requestBodies[0]?.tools).toBeDefined();
    expect(modelServer.requestBodies[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining(
            "If you need a tool, call exactly one native tool.",
          ),
        }),
      ]),
    );
    const assistantMessages = (
      (modelServer.requestBodies[1]?.messages as Array<{
        content?: string;
        role?: string;
      }>) ?? []
    ).filter((message) => message.role === "assistant");

    expect(assistantMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: "Used `file.write` on `src/example.ts`.",
        }),
      ]),
    );
    expect(
      assistantMessages.some((message) =>
        String(message.content ?? "").includes("Apply the requested edit."),
      ),
    ).toBe(false);
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
    writeFileSync(path.join(projectRoot, "README.md"), "# Repo\n", "utf8");

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
          path: "README.md",
          toolName: "file.read",
        },
        summary: "Ground on one verified file before retrying.",
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

  it("refuses to rerun a failed required check before any grounded progress", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: "http://127.0.0.1:65535/v1",
      projectRoot,
      stopConditions: {
        maxEngineerAttempts: 3,
      },
    });
    const { client, requests } = createCapturingModelClient([
      {
        request: {
          accessMode: "mutate",
          command: "npm run test",
          toolName: "command.execute",
        },
        summary: "Run the required check once.",
        type: "tool" as const,
      },
      {
        request: {
          accessMode: "mutate",
          command: "npm run test",
          toolName: "command.execute",
        },
        summary: "Try the required check again without making progress.",
        type: "tool" as const,
      },
      {
        blockers: ["stop after the repeated-check refusal"],
        outcome: "blocked" as const,
        summary: "Blocked after repeated-check refusal",
        type: "final" as const,
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
          durationMs: 10,
          environment: {},
          executionTarget: "docker",
          exitCode: 1,
          role: "engineer",
          stderr: "tests failed\n",
          stdout: "",
          timestamp: "2026-04-13T12:12:00.000Z",
          workingDirectory: "/workspace",
        };
      },
    };

    const execution = await executeEngineerTask({
      loadedConfig,
      modelClient: client,
      persistFinalArtifacts: false,
      projectCommandRunner: fakeCommandRunner,
      task: "Keep trying the same failing required check.",
    });

    expect(execution.stopReason).toBe("blocked");
    expect(callCount).toBe(1);
    expect(
      requests[2]?.messages.some(
        (message) =>
          message.role === "tool" &&
          message.content.includes(
            "The previous required check already failed and no verified progress was made since then.",
          ),
      ),
    ).toBe(true);
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

  it("refuses further exploration after the budget is exhausted and emits convergence metrics", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);
    const explorationDirectories = Array.from(
      { length: 12 },
      (_value, index) => `step-${index + 1}`,
    );

    for (const directoryName of explorationDirectories) {
      mkdirSync(path.join(projectRoot, directoryName), { recursive: true });
    }

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: "http://127.0.0.1:65535/v1",
      projectRoot,
      stopConditions: {
        maxIterations: 20,
      },
    });
    const outputs = [
      ...explorationDirectories.map((directoryName, index) => ({
        request: { path: directoryName, toolName: "file.list" as const },
        summary: `Explore ${directoryName} (${index + 1})`,
        type: "tool" as const,
      })),
      {
        request: { path: ".", toolName: "file.list" as const },
        summary: "Try to keep exploring past the budget.",
        type: "tool" as const,
      },
      {
        blockers: ["stop after budget refusal"],
        outcome: "blocked" as const,
        summary: "Blocked after budget refusal",
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
    expect(execution.result.convergence).toMatchObject({
      explorationBudget: 12,
      explorationBudgetExhaustedAtStep: 13,
      stepsToFirstCheck: null,
      stepsToFirstEdit: null,
    });
    expect(requests).toHaveLength(14);
    expect(
      requests[13]?.messages.some(
        (message) =>
          message.role === "tool" &&
          message.content.includes("Exploration budget exhausted."),
      ),
    ).toBe(true);

    const events = parseJsonLines(
      execution.dossier.paths.files.events.absolutePath,
    );

    expect(
      events.some(
        (event) => event.type === "engineer-convergence-guard-triggered",
      ),
    ).toBe(true);
  });

  it("suppresses duplicate rereads and records duplicate-exploration counters", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);
    writeFileSync(path.join(projectRoot, "README.md"), "# Repo\n", "utf8");

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: "http://127.0.0.1:65535/v1",
      projectRoot,
      stopConditions: {
        maxIterations: 10,
      },
    });
    const outputs = [
      {
        request: { path: "README.md", toolName: "file.read" as const },
        summary: "Read the README once.",
        type: "tool" as const,
      },
      {
        request: { path: "README.md", toolName: "file.read" as const },
        summary: "Read the README again.",
        type: "tool" as const,
      },
      {
        blockers: ["stop after duplicate suppression"],
        outcome: "blocked" as const,
        summary: "Blocked after duplicate suppression",
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
    expect(execution.result.convergence).toMatchObject({
      duplicateExplorationSuppressions: 1,
      repeatedReadCount: 1,
      repoMemoryHits: 1,
    });
    expect(requests).toHaveLength(3);
    expect(
      requests[2]?.messages.some(
        (message) =>
          message.role === "tool" &&
          message.content.includes(
            "Repeated read for `README.md` was suppressed.",
          ),
      ),
    ).toBe(true);
  });

  it("feeds known verified paths back after an invalid file path request", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);
    mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    writeFileSync(
      path.join(projectRoot, "package.json"),
      '{"name":"test-repo"}\n',
      "utf8",
    );
    writeFileSync(
      path.join(projectRoot, "src", "example.ts"),
      "export const value = 1;\n",
      "utf8",
    );

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: "http://127.0.0.1:65535/v1",
      projectRoot,
    });
    const { client, requests } = createCapturingModelClient([
      {
        request: { path: ".", toolName: "file.list" as const },
        summary: "List the repo root first.",
        type: "tool" as const,
      },
      {
        request: { path: "src/missing.ts", toolName: "file.read" as const },
        summary: "Try to read a missing file.",
        type: "tool" as const,
      },
      {
        blockers: ["stop after invalid-path guidance"],
        outcome: "blocked" as const,
        summary: "Blocked after invalid-path guidance",
        type: "final" as const,
      },
    ]);

    const execution = await executeEngineerTask({
      loadedConfig,
      modelClient: client,
      persistFinalArtifacts: false,
      task: "Inspect one source file and stop.",
    });

    expect(execution.stopReason).toBe("blocked");
    expect(
      requests[2]?.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.includes("Known verified paths:") &&
          message.content.includes("`package.json`") &&
          message.content.includes("`src`"),
      ),
    ).toBe(true);
  });

  it("emits null first-edit and first-check metrics for no-edit runs", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);
    writeFileSync(path.join(projectRoot, "README.md"), "# Repo\n", "utf8");

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: "http://127.0.0.1:65535/v1",
      projectRoot,
    });
    const execution = await executeEngineerTask({
      loadedConfig,
      modelClient: createQueuedModelClient([
        {
          request: {
            path: ".",
            query: "README",
            toolName: "file.search",
          },
          summary: "Search once before giving up.",
          type: "tool",
        },
        {
          blockers: ["no safe edit found"],
          outcome: "blocked",
          summary: "Blocked without editing.",
          type: "final",
        },
      ]).client,
      persistFinalArtifacts: false,
      task: "Find one tiny improvement.",
    });

    expect(execution.result.convergence).toEqual({
      duplicateExplorationSuppressions: 0,
      explorationBudget: 12,
      explorationBudgetExhaustedAtStep: null,
      repeatedListingCount: 0,
      repeatedReadCount: 0,
      repoMemoryHits: 0,
      stepsToFirstCheck: null,
      stepsToFirstEdit: null,
    });
  });

  it("records delayed-check metrics when verification happens after an edit and extra exploration", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);

    const sourcePath = path.join(projectRoot, "src", "example.ts");
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, "export const value = 1;\n", "utf8");

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: "http://127.0.0.1:65535/v1",
      projectRoot,
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
          timestamp: "2026-04-13T12:35:00.000Z",
          workingDirectory: "/workspace",
        };
      },
    };

    const execution = await executeEngineerTask({
      loadedConfig,
      modelClient: createQueuedModelClient([
        {
          request: {
            content: "export const value = 2;\n",
            path: "src/example.ts",
            toolName: "file.write",
          },
          summary: "Edit the source file first.",
          type: "tool",
        },
        {
          request: { path: "src", toolName: "file.list" },
          summary: "Wander once after the edit.",
          type: "tool",
        },
        {
          request: {
            accessMode: "mutate",
            command: "npm run test",
            toolName: "command.execute",
          },
          stopWhenSuccessful: true,
          summary: "Run the required check after the delay.",
          type: "tool",
        },
      ]).client,
      projectCommandRunner: fakeCommandRunner,
      persistFinalArtifacts: false,
      task: "Change the exported value to `2` and verify it.",
    });

    expect(execution.result.status).toBe("success");
    expect(execution.result.convergence).toMatchObject({
      explorationBudgetExhaustedAtStep: null,
      stepsToFirstCheck: 3,
      stepsToFirstEdit: 1,
    });
  });

  it("smoke: suppresses wandering rereads before the run reaches first edit and check", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);
    writeFileSync(path.join(projectRoot, "README.md"), "# Repo\n", "utf8");

    const sourcePath = path.join(projectRoot, "src", "example.ts");
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, "export const value = 1;\n", "utf8");

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: "http://127.0.0.1:65535/v1",
      projectRoot,
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
          timestamp: "2026-04-13T12:40:00.000Z",
          workingDirectory: "/workspace",
        };
      },
    };

    const execution = await executeEngineerTask({
      loadedConfig,
      modelClient: createQueuedModelClient([
        {
          request: { path: "README.md", toolName: "file.read" },
          summary: "Read the README once.",
          type: "tool",
        },
        {
          request: { path: "README.md", toolName: "file.read" },
          summary: "Wander by rereading the same file.",
          type: "tool",
        },
        {
          request: {
            content: "export const value = 2;\n",
            path: "src/example.ts",
            toolName: "file.write",
          },
          summary: "Make the actual edit.",
          type: "tool",
        },
        {
          request: {
            accessMode: "mutate",
            command: "npm run test",
            toolName: "command.execute",
          },
          stopWhenSuccessful: true,
          summary: "Run the required check.",
          type: "tool",
        },
      ]).client,
      projectCommandRunner: fakeCommandRunner,
      task: "Update `src/example.ts` and verify it.",
    });
    const events = parseJsonLines(
      execution.dossier.paths.files.events.absolutePath,
    );

    expect(execution.result.status).toBe("success");
    expect(execution.result.convergence).toMatchObject({
      duplicateExplorationSuppressions: 1,
      repeatedReadCount: 1,
      stepsToFirstCheck: 4,
      stepsToFirstEdit: 3,
    });
    expect(
      events.some(
        (event) =>
          event.type === "tool-call" &&
          event.status === "failed" &&
          event.toolName === "file.read",
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

  it("feeds compact command results back to the engineer model", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: "http://127.0.0.1:65535/v1",
      projectRoot,
    });
    const { client, requests } = createCapturingModelClient([
      {
        request: {
          accessMode: "mutate" as const,
          command: "npm run test",
          toolName: "command.execute" as const,
        },
        summary: "Run the required check",
        type: "tool" as const,
      },
      {
        blockers: ["stop after command"],
        outcome: "blocked" as const,
        summary: "Blocked after command",
        type: "final" as const,
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
          durationMs: 12,
          environment: { CI: "1" },
          executionTarget: "docker",
          exitCode: 1,
          role: "engineer",
          stderr: "failing stderr\n",
          stdout: "failing stdout\n",
          timestamp: "2026-04-14T12:01:05.000Z",
          workingDirectory: "/workspace",
        };
      },
    };

    const execution = await executeEngineerTask({
      loadedConfig,
      modelClient: client,
      persistFinalArtifacts: false,
      projectCommandRunner: fakeCommandRunner,
      task: "Run the required check and stop.",
    });

    expect(execution.stopReason).toBe("blocked");

    const toolMessage = requests[1]?.messages.find(
      (message) =>
        message.role === "tool" && message.name === "command.execute",
    );

    expect(toolMessage?.content).toContain('"command":"npm run test"');
    expect(toolMessage?.content).toContain('"exitCode":1');
    expect(toolMessage?.content).toContain(
      '"summary":"Command failed with exit code 1."',
    );
    expect(toolMessage?.content).not.toContain("workingDirectory");
    expect(toolMessage?.content).not.toContain("executionTarget");
    expect(toolMessage?.content).not.toContain('"environment"');
  });

  it("filters noisy root directory entries before feeding file lists back to the engineer model", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);

    mkdirSync(path.join(projectRoot, "node_modules"), { recursive: true });
    mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    writeFileSync(path.join(projectRoot, "README.md"), "# Test Repo\n", "utf8");
    writeFileSync(
      path.join(projectRoot, "package.json"),
      '{"name":"test-repo"}\n',
      "utf8",
    );

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: "http://127.0.0.1:65535/v1",
      projectRoot,
    });
    const outputs = [
      {
        request: { path: ".", toolName: "file.list" as const },
        summary: "List repo root",
        type: "tool" as const,
      },
      {
        blockers: ["stop after list"],
        outcome: "blocked" as const,
        summary: "Blocked after list",
        type: "final" as const,
      },
    ];
    const { client, requests } = createCapturingModelClient(outputs);

    const execution = await executeEngineerTask({
      loadedConfig,
      modelClient: client,
      persistFinalArtifacts: false,
      task: "Inspect the repo root and stop.",
    });

    expect(execution.stopReason).toBe("blocked");

    const toolMessage = requests[1]?.messages.find(
      (message) => message.role === "tool" && message.name === "file.list",
    );

    expect(toolMessage?.content).toContain('"path":"."');
    expect(toolMessage?.content).toContain("README.md");
    expect(toolMessage?.content).not.toContain("node_modules");
    expect(toolMessage?.content).not.toContain(".agent-harness");
  });

  it("advertises search-first exploration and batch reads in the engineer prompt", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: "http://127.0.0.1:65535/v1",
      projectRoot,
    });
    const { client, requests } = createCapturingModelClient([
      {
        blockers: ["stop immediately"],
        outcome: "blocked" as const,
        summary: "Blocked immediately",
        type: "final" as const,
      },
    ]);

    const execution = await executeEngineerTask({
      loadedConfig,
      modelClient: client,
      persistFinalArtifacts: false,
      task: "Stop immediately.",
    });

    expect(execution.stopReason).toBe("blocked");
    expect(
      requests[0]?.messages.some(
        (message) =>
          message.role === "developer" &&
          message.content.includes(
            "Explore search-first: prefer `file.search`",
          ) &&
          message.content.includes(
            "`command.execute` already runs from the project root by default.",
          ),
      ),
    ).toBe(true);
    expect(
      requests[0]?.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.includes("### `file.search`") &&
          message.content.includes("### `file.read_many`") &&
          message.content.includes("Not a text-search substitute."),
      ),
    ).toBe(true);
  });

  it("smoke: completes a Qwen3-Coder tool-call loop through the shared runtime without runtime prompt branches", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);

    const modelServer = await startMockServerWithBodies([
      {
        content: [
          "Apply the requested edit.",
          "<tool_call>",
          "<function=file.write>",
          "<parameter=path>",
          "src/example.ts",
          "</parameter>",
          "<parameter=content>",
          "export const value = 5;\n",
          "</parameter>",
          "</function>",
          "</tool_call>",
        ].join("\n"),
      },
      {
        content: [
          "Run the required check.",
          "STOP_ON_SUCCESS",
          "<tool_call>",
          "<function=command.execute>",
          "<parameter=accessMode>",
          "mutate",
          "</parameter>",
          "<parameter=command>",
          "npm run test",
          "</parameter>",
          "</function>",
          "</tool_call>",
        ].join("\n"),
      },
    ]);
    servers.push(modelServer);

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: `${modelServer.url}/v1`,
      engineerModel: "Qwen/Qwen3-Coder-Next",
      engineerProvider: "openai-compatible",
      projectRoot,
    });
    const sourcePath = path.join(projectRoot, "src", "example.ts");

    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, "export const value = 1;\n", "utf8");

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
          durationMs: 8,
          environment: {},
          executionTarget: "docker",
          exitCode: 0,
          role: "engineer",
          stderr: "",
          stdout: "tests passed\n",
          timestamp: "2026-04-14T12:02:05.000Z",
          workingDirectory: "/workspace",
        };
      },
    };

    const execution = await executeEngineerTask({
      loadedConfig,
      projectCommandRunner: fakeCommandRunner,
      runId: "20260414T120200.000Z-abcdac",
      task: "Update `src/example.ts` so the exported value becomes `5`.",
    });

    expect(execution.result.status).toBe("success");
    expect(execution.stopReason).toBe("passing-checks");
    expect(readFileSync(sourcePath, "utf8")).toBe("export const value = 5;\n");
    expect(modelServer.requestBodies).toHaveLength(2);
    expect(modelServer.requestBodies[0]?.tools).toBeDefined();
    expect(
      JSON.stringify(modelServer.requestBodies[0]?.messages ?? []),
    ).not.toContain("Stay in non-thinking mode.");
  });

  it("continues after malformed Engineer output and accepts the next valid step", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);

    const loadedConfig = await createLoadedConfig({
      engineerBaseUrl: "http://127.0.0.1:65535/v1",
      projectRoot,
    });
    const requests: Array<ModelChatRequest<unknown>> = [];
    let callCount = 0;
    const client = {
      async chat<TStructured>(
        request: ModelChatRequest<TStructured>,
      ): Promise<ModelChatResponse<TStructured>> {
        requests.push(request as ModelChatRequest<unknown>);
        callCount += 1;

        if (callCount === 1) {
          return {
            id: `mock-${callCount}`,
            rawContent: "Inspect the workspace state first.",
            role: "assistant",
            toolCalls: [
              {
                arguments: {
                  path: "README.md",
                },
                id: "call_bad_git_status",
                name: "git.status",
              },
            ],
          };
        }

        return {
          id: `mock-${callCount}`,
          rawContent: "BLOCKED: Blocked after retry guidance.",
          role: "assistant",
        };
      },
    };

    const execution = await executeEngineerTask({
      loadedConfig,
      modelClient: client,
      persistFinalArtifacts: false,
      task: "Find one tiny improvement.",
    });

    expect(execution.stopReason).toBe("blocked");
    expect(requests).toHaveLength(2);
    expect(
      requests[1]?.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.includes("do not wrap it in a JSON envelope"),
      ),
    ).toBe(true);
  });
});
