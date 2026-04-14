import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createToolRouter,
  loadHarnessConfig,
  McpServerUnavailableError,
  McpToolNotAllowedError,
  type CreateMcpServerClient,
  type LoadedHarnessConfig,
  type McpAvailableTool,
  type McpToolCallRequest,
  type McpToolCallResult,
} from "../../src/index.js";

function createTempProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "aeah-tool-router-"));
}

function writeHarnessConfig(projectRoot: string, mcpBlock: string): void {
  writeFileSync(
    path.join(projectRoot, "agent-harness.toml"),
    `version = 1

[models.architect]
provider = "openai-compatible"
model = "architect"
baseUrl = "https://api.example.com/v1"

[models.engineer]
provider = "llama.cpp"
model = "engineer"
baseUrl = "http://127.0.0.1:8080/v1"

[project]
executionTarget = "host"

[commands]
test = "npm run test"

[mcp]
${mcpBlock}

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
}

async function loadConfig(projectRoot: string): Promise<LoadedHarnessConfig> {
  return loadHarnessConfig({ projectRoot });
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

describe("ToolRouter", () => {
  const projectRoots: string[] = [];

  afterEach(() => {
    for (const projectRoot of projectRoots.splice(0)) {
      rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it("routes built-in tools and allowlisted MCP tools through the correct executors", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    writeHarnessConfig(
      projectRoot,
      `allowlist = ["repo"]

[mcp.servers.repo]
transport = "stdio"
command = "node"
args = ["repo-mcp.js"]`,
    );

    const loadedConfig = await loadConfig(projectRoot);
    const sourcePath = path.join(projectRoot, "src", "example.ts");
    const fakeMcp = createFakeMcpClientFactory({
      repo: {
        callResult: {
          content: [{ text: "resolved", type: "text" }],
          isError: false,
          name: "lookup",
          server: "repo",
          toolName: "mcp.call",
        },
        listTools: [{ name: "lookup", server: "repo" }],
      },
    });
    const router = createToolRouter({
      loadedConfig,
      mcpClientFactory: fakeMcp.factory,
    });

    try {
      const catalog = await router.prepare();
      const fileWriteResult = await router.execute(
        { role: "engineer" },
        {
          content: "export const value = 2;\n",
          path: "src/example.ts",
          toolName: "file.write",
        },
      );
      const mcpResult = await router.execute(
        { role: "engineer" },
        {
          arguments: {
            path: "src/example.ts",
          },
          name: "lookup",
          server: "repo",
          toolName: "mcp.call",
        },
      );

      expect(catalog.mcpTools).toEqual([
        {
          name: "lookup",
          server: "repo",
        },
      ]);
      expect(fileWriteResult.toolName).toBe("file.write");
      expect(readFileSync(sourcePath, "utf8")).toBe(
        "export const value = 2;\n",
      );
      expect(mcpResult).toMatchObject({
        content: [{ text: "resolved", type: "text" }],
        name: "lookup",
        server: "repo",
        toolName: "mcp.call",
      });
      expect(fakeMcp.calls).toEqual([
        {
          arguments: {
            path: "src/example.ts",
          },
          name: "lookup",
          server: "repo",
          toolName: "mcp.call",
        },
      ]);
      expect(router.getExecutionSummary()).toMatchObject({
        builtInCallCount: 1,
        mcpCallCount: 1,
        mcpServers: {
          available: ["repo"],
        },
      });
    } finally {
      await router.close();
    }
  });

  it("blocks MCP servers that are configured but not allowlisted", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    writeHarnessConfig(
      projectRoot,
      `allowlist = []

[mcp.servers.repo]
transport = "stdio"
command = "node"
args = ["repo-mcp.js"]`,
    );

    const loadedConfig = await loadConfig(projectRoot);
    const fakeMcp = createFakeMcpClientFactory({
      repo: {
        listTools: [{ name: "lookup", server: "repo" }],
      },
    });
    const router = createToolRouter({
      loadedConfig,
      mcpClientFactory: fakeMcp.factory,
    });

    try {
      await expect(
        router.execute(
          { role: "engineer" },
          {
            name: "lookup",
            server: "repo",
            toolName: "mcp.call",
          },
        ),
      ).rejects.toBeInstanceOf(McpToolNotAllowedError);
    } finally {
      await router.close();
    }
  });

  it("reports clear diagnostics when an allowlisted MCP server is unavailable", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    writeHarnessConfig(
      projectRoot,
      `allowlist = ["repo"]

[mcp.servers.repo]
transport = "stdio"
command = "node"
args = ["repo-mcp.js"]`,
    );

    const loadedConfig = await loadConfig(projectRoot);
    const fakeMcp = createFakeMcpClientFactory({
      repo: {
        listTools: new McpServerUnavailableError(
          "MCP server `repo` did not answer `listTools`: spawn failed",
        ),
      },
    });
    const router = createToolRouter({
      loadedConfig,
      mcpClientFactory: fakeMcp.factory,
    });

    try {
      const catalog = await router.prepare();

      expect(catalog.mcpServers.unavailable).toEqual([
        {
          message: "MCP server `repo` did not answer `listTools`: spawn failed",
          server: "repo",
        },
      ]);
      await expect(
        router.execute(
          { role: "engineer" },
          {
            name: "lookup",
            server: "repo",
            toolName: "mcp.call",
          },
        ),
      ).rejects.toBeInstanceOf(McpServerUnavailableError);
    } finally {
      await router.close();
    }
  });

  it("allows the Architect role to invoke allowlisted MCP tools", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    writeHarnessConfig(
      projectRoot,
      `allowlist = ["repo"]

[mcp.servers.repo]
transport = "stdio"
command = "node"
args = ["repo-mcp.js"]`,
    );

    const loadedConfig = await loadConfig(projectRoot);
    const fakeMcp = createFakeMcpClientFactory({
      repo: {
        callResult: {
          content: [{ text: "architect context", type: "text" }],
          isError: false,
          name: "lookup",
          server: "repo",
          toolName: "mcp.call",
        },
        listTools: [{ name: "lookup", server: "repo" }],
      },
    });
    const router = createToolRouter({
      loadedConfig,
      mcpClientFactory: fakeMcp.factory,
    });

    try {
      await router.prepare();

      await expect(
        router.execute(
          { role: "architect" },
          {
            name: "lookup",
            server: "repo",
            toolName: "mcp.call",
          },
        ),
      ).resolves.toMatchObject({
        content: [{ text: "architect context", type: "text" }],
        server: "repo",
        toolName: "mcp.call",
      });
    } finally {
      await router.close();
    }
  });
});
