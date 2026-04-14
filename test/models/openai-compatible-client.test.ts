import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createArchitectStructuredOutputFormat,
  createRoleModelClient,
  initializeProject,
  initializeRunDossier,
  loadHarnessConfig,
  ModelHttpError,
  ModelResponseError,
  ModelStructuredOutputError,
  ModelTimeoutError,
  OpenAiCompatibleChatClient,
  resolveModelConfigForRole,
} from "../../src/index.js";

interface MockRequestRecord {
  bodyText: string;
  headers: IncomingMessage["headers"];
  method: string;
  url: string;
}

function createTempProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "aeah-models-"));
}

async function startMockServer(
  handler: (
    request: MockRequestRecord,
    response: ServerResponse<IncomingMessage>,
  ) => Promise<void> | void,
): Promise<{ close: () => Promise<void>; server: Server; url: string }> {
  const server = createServer(async (request, response) => {
    const bodyText = await readRequestBody(request);

    await handler(
      {
        bodyText,
        headers: request.headers,
        method: request.method ?? "GET",
        url: request.url ?? "/",
      },
      response,
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
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

function renderConfig(options: {
  architectApiKey?: string;
  architectBaseUrl: string;
  architectHeaders?: Record<string, string>;
  architectMaxRetries?: number;
  architectProvider?: string;
  architectTimeoutMs?: number;
  engineerBaseUrl: string;
  engineerHeaders?: Record<string, string>;
  engineerMaxRetries?: number;
  engineerProvider?: string;
  engineerTimeoutMs?: number;
}): string {
  const architectProvider = options.architectProvider ?? "openai-compatible";
  const engineerProvider = options.engineerProvider ?? "llama.cpp";

  return `version = 1

[models.architect]
provider = ${JSON.stringify(architectProvider)}
model = "architect-model"
baseUrl = ${JSON.stringify(options.architectBaseUrl)}
${options.architectApiKey === undefined ? "" : `apiKey = ${JSON.stringify(options.architectApiKey)}`}
${options.architectTimeoutMs === undefined ? "" : `timeoutMs = ${options.architectTimeoutMs}`}
${options.architectMaxRetries === undefined ? "" : `maxRetries = ${options.architectMaxRetries}`}
${renderHeaderTable("models.architect.headers", options.architectHeaders)}
[models.engineer]
provider = ${JSON.stringify(engineerProvider)}
model = "engineer-model"
baseUrl = ${JSON.stringify(options.engineerBaseUrl)}
${options.engineerTimeoutMs === undefined ? "" : `timeoutMs = ${options.engineerTimeoutMs}`}
${options.engineerMaxRetries === undefined ? "" : `maxRetries = ${options.engineerMaxRetries}`}
${renderHeaderTable("models.engineer.headers", options.engineerHeaders)}
[project]
executionTarget = "host"

[commands]
setup = "npm install"
build = "npm run build"
test = "npm run test"
lint = "npm run lint"
format = "npm run format"

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
`;
}

function renderHeaderTable(
  tableName: string,
  headers: Record<string, string> | undefined,
): string {
  if (headers === undefined || Object.keys(headers).length === 0) {
    return "";
  }

  return `\n[${tableName}]\n${Object.entries(headers)
    .map(
      ([name, value]) => `${JSON.stringify(name)} = ${JSON.stringify(value)}`,
    )
    .join("\n")}\n`;
}

async function createLoadedConfig(configContents: string) {
  const projectRoot = createTempProject();

  writeFileSync(
    path.join(projectRoot, "agent-harness.toml"),
    configContents,
    "utf8",
  );

  return {
    loadedConfig: await loadHarnessConfig({ projectRoot }),
    projectRoot,
  };
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

function parseJsonLines(filePath: string): Record<string, unknown>[] {
  const fileContents = readFileSync(filePath, "utf8").trim();

  if (fileContents.length === 0) {
    return [];
  }

  return fileContents
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("OpenAiCompatibleChatClient", () => {
  const projectRoots: string[] = [];
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));

    for (const projectRoot of projectRoots.splice(0)) {
      rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it("targets configured Architect and Engineer endpoints independently and applies custom headers", async () => {
    const architectRequests: MockRequestRecord[] = [];
    const engineerRequests: MockRequestRecord[] = [];
    const mockServer = await startMockServer((request, response) => {
      if (request.url === "/remote/v1/chat/completions") {
        architectRequests.push(request);
        response.writeHead(200, {
          "content-type": "application/json",
          "x-request-id": "architect-req-1",
        });
        response.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "Architect response",
                  role: "assistant",
                },
              },
            ],
            id: "chatcmpl-architect",
            usage: {
              completion_tokens: 11,
              prompt_tokens: 17,
              total_tokens: 28,
            },
          }),
        );
        return;
      }

      if (request.url === "/local/v1/chat/completions") {
        engineerRequests.push(request);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "Engineer response",
                  role: "assistant",
                },
              },
            ],
            id: "chatcmpl-engineer",
          }),
        );
        return;
      }

      response.writeHead(404).end();
    });
    servers.push(mockServer);

    const { loadedConfig, projectRoot } = await createLoadedConfig(
      renderConfig({
        architectApiKey: "architect-secret",
        architectBaseUrl: `${mockServer.url}/remote/v1`,
        architectHeaders: {
          "x-architect-route": "remote",
        },
        engineerBaseUrl: `${mockServer.url}/local/v1`,
        engineerHeaders: {
          "x-engineer-route": "local",
        },
      }),
    );
    projectRoots.push(projectRoot);

    const architectClient = createRoleModelClient({
      loadedConfig,
      role: "architect",
    });
    const engineerClient = createRoleModelClient({
      loadedConfig,
      role: "engineer",
    });

    const architectResponse = await architectClient.chat({
      messages: [{ content: "Plan the task.", role: "user" }],
    });
    const engineerResponse = await engineerClient.chat({
      messages: [{ content: "Implement the task.", role: "user" }],
    });

    expect(architectResponse.rawContent).toBe("Architect response");
    expect(architectResponse.providerRequestId).toBe("architect-req-1");
    expect(engineerResponse.rawContent).toBe("Engineer response");
    expect(architectRequests).toHaveLength(1);
    expect(engineerRequests).toHaveLength(1);
    expect(architectRequests[0]?.headers.authorization).toBe(
      "Bearer architect-secret",
    );
    expect(architectRequests[0]?.headers["x-architect-route"]).toBe("remote");
    expect(engineerRequests[0]?.headers.authorization).toBeUndefined();
    expect(engineerRequests[0]?.headers["x-engineer-route"]).toBe("local");

    const architectPayload = JSON.parse(
      architectRequests[0]?.bodyText ?? "{}",
    ) as {
      model?: string;
    };
    const engineerPayload = JSON.parse(
      engineerRequests[0]?.bodyText ?? "{}",
    ) as {
      model?: string;
    };

    expect(architectPayload.model).toBe("architect-model");
    expect(engineerPayload.model).toBe("engineer-model");
  });

  it("normalizes developer and tool messages for chat-completions-compatible providers", async () => {
    const seenBodies: Array<Record<string, unknown>> = [];
    const mockServer = await startMockServer((request, response) => {
      seenBodies.push(JSON.parse(request.bodyText) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "acknowledged",
                role: "assistant",
              },
            },
          ],
          id: "chatcmpl-role-normalization",
        }),
      );
    });
    servers.push(mockServer);

    const { loadedConfig, projectRoot } = await createLoadedConfig(
      renderConfig({
        architectBaseUrl: `${mockServer.url}/remote/v1`,
        engineerBaseUrl: `${mockServer.url}/local/v1`,
      }),
    );
    projectRoots.push(projectRoot);

    const client = createRoleModelClient({
      loadedConfig,
      role: "architect",
    });

    await client.chat({
      messages: [
        { content: "System prompt.", role: "system" },
        { content: "Developer instruction.", role: "developer" },
        {
          content:
            '{"type":"tool","request":{"toolName":"file.list","path":"."}}',
          role: "assistant",
        },
        {
          content: '{"ok":true,"result":{"entries":[]}}',
          name: "file.list",
          role: "tool",
        },
      ],
    });

    expect(seenBodies).toHaveLength(1);
    expect(seenBodies[0]?.messages).toEqual([
      { content: "System prompt.", role: "system" },
      { content: "Developer instruction.", role: "system" },
      {
        content:
          '{"type":"tool","request":{"toolName":"file.list","path":"."}}',
        role: "assistant",
      },
      {
        content:
          'Tool result for file.list:\n{"ok":true,"result":{"entries":[]}}',
        role: "user",
      },
    ]);
  });

  it("fails clearly on timeout", async () => {
    const mockServer = await startMockServer(async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "late",
                role: "assistant",
              },
            },
          ],
          id: "chatcmpl-timeout",
        }),
      );
    });
    servers.push(mockServer);

    const { loadedConfig, projectRoot } = await createLoadedConfig(
      renderConfig({
        architectBaseUrl: `${mockServer.url}/remote/v1`,
        architectMaxRetries: 0,
        architectTimeoutMs: 25,
        engineerBaseUrl: `${mockServer.url}/local/v1`,
      }),
    );
    projectRoots.push(projectRoot);

    const client = createRoleModelClient({
      loadedConfig,
      role: "architect",
    });

    await expect(
      client.chat({
        messages: [{ content: "This should time out.", role: "user" }],
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ModelTimeoutError);
      expect((error as Error).message).toContain("Timed out after 25ms");

      return true;
    });
  });

  it("retries retryable failures and succeeds once the provider recovers", async () => {
    let attempts = 0;
    const mockServer = await startMockServer((_request, response) => {
      attempts += 1;

      if (attempts < 3) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "try again later",
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
                content: "Recovered on retry",
                role: "assistant",
              },
            },
          ],
          id: "chatcmpl-retry",
        }),
      );
    });
    servers.push(mockServer);

    const { loadedConfig, projectRoot } = await createLoadedConfig(
      renderConfig({
        architectBaseUrl: `${mockServer.url}/remote/v1`,
        architectMaxRetries: 2,
        engineerBaseUrl: `${mockServer.url}/local/v1`,
      }),
    );
    projectRoots.push(projectRoot);

    const client = new OpenAiCompatibleChatClient({
      config: resolveModelConfigForRole(loadedConfig, "architect"),
      retryDelayMs: 0,
    });

    const response = await client.chat({
      messages: [{ content: "Retryable error test.", role: "user" }],
    });

    expect(response.rawContent).toBe("Recovered on retry");
    expect(attempts).toBe(3);
  });

  it("stops on non-retryable failures", async () => {
    let attempts = 0;
    const mockServer = await startMockServer((_request, response) => {
      attempts += 1;
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "bad request",
          },
        }),
      );
    });
    servers.push(mockServer);

    const { loadedConfig, projectRoot } = await createLoadedConfig(
      renderConfig({
        architectBaseUrl: `${mockServer.url}/remote/v1`,
        architectMaxRetries: 3,
        engineerBaseUrl: `${mockServer.url}/local/v1`,
      }),
    );
    projectRoots.push(projectRoot);

    const client = new OpenAiCompatibleChatClient({
      config: resolveModelConfigForRole(loadedConfig, "architect"),
      retryDelayMs: 0,
    });

    await expect(
      client.chat({
        messages: [{ content: "Do not retry this.", role: "user" }],
      }),
    ).rejects.toBeInstanceOf(ModelHttpError);
    expect(attempts).toBe(1);
  });

  it("validates structured Architect outputs against the packaged schema asset", async () => {
    const seenBodies: Array<Record<string, unknown>> = [];
    const mockServer = await startMockServer((request, response) => {
      seenBodies.push(JSON.parse(request.bodyText) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  acceptanceCriteria: ["all checks pass"],
                  steps: ["inspect", "implement", "verify"],
                  summary: "Deliver Milestone 3",
                }),
                role: "assistant",
              },
            },
          ],
          id: "chatcmpl-structured",
        }),
      );
    });
    servers.push(mockServer);

    const { loadedConfig, projectRoot } = await createLoadedConfig(
      renderConfig({
        architectBaseUrl: `${mockServer.url}/remote/v1`,
        engineerBaseUrl: `${mockServer.url}/local/v1`,
      }),
    );
    projectRoots.push(projectRoot);

    const client = createRoleModelClient({
      loadedConfig,
      role: "architect",
    });
    const response = await client.chat({
      messages: [{ content: "Return a plan.", role: "user" }],
      structuredOutput: await createArchitectStructuredOutputFormat("plan"),
    });

    expect(response.structuredOutput).toEqual({
      acceptanceCriteria: ["all checks pass"],
      steps: ["inspect", "implement", "verify"],
      summary: "Deliver Milestone 3",
    });
    expect(seenBodies[0]?.response_format).toMatchObject({
      type: "json_schema",
    });
  });

  it("falls back to local structured-output validation when a provider rejects response_format", async () => {
    let attempts = 0;
    const seenBodies: Array<Record<string, unknown>> = [];
    const mockServer = await startMockServer((request, response) => {
      attempts += 1;
      seenBodies.push(JSON.parse(request.bodyText) as Record<string, unknown>);

      if (attempts === 1) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "response_format json_schema is not supported",
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
              message: {
                content: JSON.stringify({
                  decision: "approve",
                  nextActions: ["ship it"],
                  summary: "Looks good",
                }),
                role: "assistant",
              },
            },
          ],
          id: "chatcmpl-fallback",
        }),
      );
    });
    servers.push(mockServer);

    const { loadedConfig, projectRoot } = await createLoadedConfig(
      renderConfig({
        architectBaseUrl: `${mockServer.url}/remote/v1`,
        architectMaxRetries: 0,
        engineerBaseUrl: `${mockServer.url}/local/v1`,
      }),
    );
    projectRoots.push(projectRoot);

    const client = new OpenAiCompatibleChatClient({
      config: resolveModelConfigForRole(loadedConfig, "architect"),
      retryDelayMs: 0,
    });
    const response = await client.chat({
      messages: [{ content: "Return a review.", role: "user" }],
      structuredOutput: await createArchitectStructuredOutputFormat("review"),
    });

    expect(response.structuredOutput).toEqual({
      decision: "approve",
      nextActions: ["ship it"],
      summary: "Looks good",
    });
    expect(attempts).toBe(2);
    expect(seenBodies[0]?.response_format).toBeDefined();
    expect(seenBodies[1]?.response_format).toBeUndefined();
    expect(
      JSON.stringify(seenBodies[1]?.messages ?? []).includes(
        "Return exactly one JSON object and nothing else.",
      ),
    ).toBe(true);
  });

  it("fails clearly when Architect structured output does not match the schema", async () => {
    const mockServer = await startMockServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "Missing steps",
                }),
                role: "assistant",
              },
            },
          ],
          id: "chatcmpl-invalid-structured",
        }),
      );
    });
    servers.push(mockServer);

    const { loadedConfig, projectRoot } = await createLoadedConfig(
      renderConfig({
        architectBaseUrl: `${mockServer.url}/remote/v1`,
        engineerBaseUrl: `${mockServer.url}/local/v1`,
      }),
    );
    projectRoots.push(projectRoot);

    const client = createRoleModelClient({
      loadedConfig,
      role: "architect",
    });

    await expect(
      client.chat({
        messages: [{ content: "Return a plan.", role: "user" }],
        structuredOutput: await createArchitectStructuredOutputFormat("plan"),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ModelStructuredOutputError);
      expect((error as Error).message).toContain("architect-plan.schema.json");
      expect((error as Error).message).toContain("architect_plan");

      return true;
    });
  });

  it("accepts fenced JSON for structured Architect outputs during local validation fallback", async () => {
    let attempts = 0;
    const mockServer = await startMockServer((_request, response) => {
      attempts += 1;

      if (attempts === 1) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "response_format is unsupported here",
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
              message: {
                content:
                  '```json\n{"summary":"Fenced output","steps":["inspect","ship"]}\n```',
                role: "assistant",
              },
            },
          ],
          id: "chatcmpl-fenced-structured",
        }),
      );
    });
    servers.push(mockServer);

    const { loadedConfig, projectRoot } = await createLoadedConfig(
      renderConfig({
        architectBaseUrl: `${mockServer.url}/remote/v1`,
        architectMaxRetries: 0,
        engineerBaseUrl: `${mockServer.url}/local/v1`,
      }),
    );
    projectRoots.push(projectRoot);

    const client = new OpenAiCompatibleChatClient({
      config: resolveModelConfigForRole(loadedConfig, "architect"),
      retryDelayMs: 0,
    });

    const response = await client.chat({
      messages: [{ content: "Return a fenced plan.", role: "user" }],
      structuredOutput: await createArchitectStructuredOutputFormat("plan"),
    });

    expect(response.structuredOutput).toEqual({
      steps: ["inspect", "ship"],
      summary: "Fenced output",
    });
  });

  it("accepts prose-wrapped structured JSON during local validation fallback", async () => {
    let attempts = 0;
    const mockServer = await startMockServer((_request, response) => {
      attempts += 1;

      if (attempts === 1) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "response_format is unsupported here",
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
              message: {
                content:
                  'Here is the requested JSON object:\n{"summary":"Wrapped output","steps":["inspect","ship"]}',
                role: "assistant",
              },
            },
          ],
          id: "chatcmpl-prose-wrapped-structured",
        }),
      );
    });
    servers.push(mockServer);

    const { loadedConfig, projectRoot } = await createLoadedConfig(
      renderConfig({
        architectBaseUrl: `${mockServer.url}/remote/v1`,
        architectMaxRetries: 0,
        engineerBaseUrl: `${mockServer.url}/local/v1`,
      }),
    );
    projectRoots.push(projectRoot);

    const client = new OpenAiCompatibleChatClient({
      config: resolveModelConfigForRole(loadedConfig, "architect"),
      retryDelayMs: 0,
    });

    const response = await client.chat({
      messages: [{ content: "Return a wrapped plan.", role: "user" }],
      structuredOutput: await createArchitectStructuredOutputFormat("plan"),
    });

    expect(response.structuredOutput).toEqual({
      steps: ["inspect", "ship"],
      summary: "Wrapped output",
    });
  });

  it("accepts the first valid structured JSON object when the response contains multiple JSON objects", async () => {
    let attempts = 0;
    const mockServer = await startMockServer((_request, response) => {
      attempts += 1;

      if (attempts === 1) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "response_format is unsupported here",
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
              message: {
                content: [
                  '{"type":"tool","tool":{"toolName":"file.list","path":"."}}',
                  '{"type":"plan","summary":"Inspect then implement","steps":["inspect the repo","make one small change","run tests"]}',
                ].join("\n"),
                role: "assistant",
              },
            },
          ],
          id: "chatcmpl-multiple-structured",
        }),
      );
    });
    servers.push(mockServer);

    const { loadedConfig, projectRoot } = await createLoadedConfig(
      renderConfig({
        architectBaseUrl: `${mockServer.url}/remote/v1`,
        architectMaxRetries: 0,
        engineerBaseUrl: `${mockServer.url}/local/v1`,
      }),
    );
    projectRoots.push(projectRoot);

    const client = new OpenAiCompatibleChatClient({
      config: resolveModelConfigForRole(loadedConfig, "architect"),
      retryDelayMs: 0,
    });

    const response = await client.chat({
      messages: [{ content: "Return one valid plan.", role: "user" }],
      structuredOutput: await createArchitectStructuredOutputFormat("plan"),
    });

    expect(response.structuredOutput).toEqual({
      type: "plan",
      summary: "Inspect then implement",
      steps: ["inspect the repo", "make one small change", "run tests"],
    });
  });

  it("classifies malformed successful provider payloads as invalid responses", async () => {
    const mockServer = await startMockServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{not-json");
    });
    servers.push(mockServer);

    const { loadedConfig, projectRoot } = await createLoadedConfig(
      renderConfig({
        architectBaseUrl: `${mockServer.url}/remote/v1`,
        architectMaxRetries: 2,
        engineerBaseUrl: `${mockServer.url}/local/v1`,
      }),
    );
    projectRoots.push(projectRoot);

    const client = new OpenAiCompatibleChatClient({
      config: resolveModelConfigForRole(loadedConfig, "architect"),
      retryDelayMs: 0,
    });

    await expect(
      client.chat({
        messages: [{ content: "Return malformed JSON.", role: "user" }],
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ModelResponseError);
      expect((error as Error).message).toContain("was not valid JSON");

      return true;
    });
  });

  it("writes model request and response records into the run dossier", async () => {
    const mockServer = await startMockServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "x-request-id": "run-dossier-request",
      });
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: "Logged Architect response",
                role: "assistant",
              },
            },
          ],
          id: "chatcmpl-dossier",
          usage: {
            completion_tokens: 4,
            prompt_tokens: 6,
            total_tokens: 10,
          },
        }),
      );
    });
    servers.push(mockServer);

    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    await initializeProject(projectRoot);

    writeFileSync(
      path.join(projectRoot, "agent-harness.toml"),
      renderConfig({
        architectApiKey: "top-secret",
        architectBaseUrl: `${mockServer.url}/remote/v1`,
        engineerBaseUrl: `${mockServer.url}/local/v1`,
      }),
      "utf8",
    );

    const loadedConfig = await loadHarnessConfig({ projectRoot });
    const dossier = await initializeRunDossier(loadedConfig, {
      createdAt: new Date("2026-04-13T12:00:00.000Z"),
      runId: "20260413T120000.000Z-abcdef",
    });
    const client = createRoleModelClient({
      dossierPaths: dossier.paths,
      loadedConfig,
      role: "architect",
    });

    await client.chat({
      messages: [{ content: "Log this request.", role: "user" }],
    });

    const events = parseJsonLines(dossier.paths.files.events.absolutePath);
    const requestEvent = events.find((event) => event.type === "model-request");
    const responseEvent = events.find(
      (event) => event.type === "model-response",
    );
    const messageEvent = events.find(
      (event) =>
        event.type === "message" &&
        event.content === "Logged Architect response",
    );

    expect(requestEvent).toMatchObject({
      provider: "openai-compatible",
      role: "architect",
      type: "model-request",
      usedNativeStructuredOutput: false,
    });
    expect(
      (requestEvent?.headers as Record<string, string>).authorization,
    ).toBe("[REDACTED]");
    expect(responseEvent).toMatchObject({
      providerRequestId: "run-dossier-request",
      role: "architect",
      statusCode: 200,
      type: "model-response",
      usage: {
        completionTokens: 4,
        promptTokens: 6,
        totalTokens: 10,
      },
    });
    expect(messageEvent).toMatchObject({
      content: "Logged Architect response",
      role: "architect",
      type: "message",
    });
  });
});
