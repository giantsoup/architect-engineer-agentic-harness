import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HarnessConfigError,
  loadHarnessConfig,
} from "../../src/config/load-config.js";

function createTempProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "aeah-config-"));
}

describe("loadHarnessConfig", () => {
  const createdProjectRoots: string[] = [];

  afterEach(() => {
    for (const projectRoot of createdProjectRoots.splice(0)) {
      rmSync(projectRoot, { recursive: true, force: true });
    }

    delete process.env.TEST_ENGINEER_CONTAINER;
    delete process.env.TEST_ARCHITECT_API_KEY;
    delete process.env.TEST_ARCHITECT_HEADER;
  });

  it("resolves environment variable references throughout the config", async () => {
    const projectRoot = createTempProject();
    createdProjectRoots.push(projectRoot);
    process.env.TEST_ENGINEER_CONTAINER = "app-from-env";
    process.env.TEST_ARCHITECT_API_KEY = "secret-token";

    writeFileSync(
      path.join(projectRoot, "agent-harness.toml"),
      `version = 1

[models.architect]
provider = "openai-compatible"
model = "architect"
baseUrl = "https://api.example.com/v1"
apiKey = "\${TEST_ARCHITECT_API_KEY}"

[models.engineer]
provider = "llama.cpp"
model = "engineer"
baseUrl = "http://127.0.0.1:8080/v1"

[project]
executionTarget = "docker"
containerName = "\${TEST_ENGINEER_CONTAINER}"

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
mode = "container"

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

    const { config } = await loadHarnessConfig({ projectRoot });

    expect(config.project.containerName).toBe("app-from-env");
    expect(config.models.architect.apiKey).toBe("secret-token");
    expect(config.models.agent).toEqual(config.models.engineer);
  });

  it("reports a useful error when an environment variable reference is missing", async () => {
    const projectRoot = createTempProject();
    createdProjectRoots.push(projectRoot);

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
executionTarget = "docker"
containerName = "\${MISSING_ENGINEER_CONTAINER}"

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
mode = "container"

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

    await expect(loadHarnessConfig({ projectRoot })).rejects.toThrowError(
      HarnessConfigError,
    );
    await expect(loadHarnessConfig({ projectRoot })).rejects.toThrowError(
      /project\.containerName: Missing environment variable `MISSING_ENGINEER_CONTAINER`\./u,
    );
  });

  it("rejects artifact roots that point at the project root", async () => {
    const projectRoot = createTempProject();
    createdProjectRoots.push(projectRoot);

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
executionTarget = "docker"
containerName = "app"

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
mode = "container"

[artifacts]
rootDir = "."
runsDir = "runs"

[stopConditions]
maxIterations = 12
maxEngineerAttempts = 5
requirePassingChecks = true
`,
      "utf8",
    );

    await expect(loadHarnessConfig({ projectRoot })).rejects.toThrowError(
      /artifacts\.rootDir: Must not be the project root\./u,
    );
  });

  it("requires models.agent in version 2 configs", async () => {
    const projectRoot = createTempProject();
    createdProjectRoots.push(projectRoot);

    writeFileSync(
      path.join(projectRoot, "agent-harness.toml"),
      `version = 2

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

    await expect(loadHarnessConfig({ projectRoot })).rejects.toThrowError(
      /models\.agent: Invalid input: expected object, received undefined/u,
    );
  });

  it("requires sandbox mode to match the selected execution target", async () => {
    const projectRoot = createTempProject();
    createdProjectRoots.push(projectRoot);

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
allowlist = []

[network]
mode = "inherit"

[sandbox]
mode = "container"

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

    await expect(loadHarnessConfig({ projectRoot })).rejects.toThrowError(
      /sandbox\.mode: Must be "workspace-write" when project\.executionTarget is "host"\./u,
    );
  });

  it("derives projectRoot from configPath when a custom config path is used", async () => {
    const projectRoot = createTempProject();
    createdProjectRoots.push(projectRoot);

    const configPath = path.join(projectRoot, "custom.agent-harness.toml");

    writeFileSync(
      configPath,
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
executionTarget = "docker"
containerName = "app"

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
mode = "container"

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

    const loadedConfig = await loadHarnessConfig({ configPath });

    expect(loadedConfig.configPath).toBe(configPath);
    expect(loadedConfig.projectRoot).toBe(projectRoot);
  });

  it("loads optional model headers, timeouts, and retry settings", async () => {
    const projectRoot = createTempProject();
    createdProjectRoots.push(projectRoot);
    process.env.TEST_ARCHITECT_HEADER = "through-env";

    writeFileSync(
      path.join(projectRoot, "agent-harness.toml"),
      `version = 1

[models.architect]
provider = "openai-compatible"
model = "architect"
baseUrl = "https://api.example.com/v1"
timeoutMs = 45000
maxRetries = 4

[models.architect.headers]
x-route = "\${TEST_ARCHITECT_HEADER}"

[models.engineer]
provider = "llama.cpp"
model = "engineer"
baseUrl = "http://127.0.0.1:8080/v1"
timeoutMs = 90000
maxRetries = 1

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
`,
      "utf8",
    );

    const { config } = await loadHarnessConfig({ projectRoot });

    expect(config.models.architect.headers).toEqual({
      "x-route": "through-env",
    });
    expect(config.models.architect.timeoutMs).toBe(45000);
    expect(config.models.architect.maxRetries).toBe(4);
    expect(config.models.engineer.timeoutMs).toBe(90000);
    expect(config.models.engineer.maxRetries).toBe(1);
  });

  it("loads explicit MCP server definitions and Laravel Boost presets", async () => {
    const projectRoot = createTempProject();
    createdProjectRoots.push(projectRoot);

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
allowlist = ["repo", "laravel-boost"]

[mcp.servers.repo]
transport = "stdio"
command = "node"
args = ["scripts/repo-mcp.js"]
workingDirectory = "."
toolTimeoutMs = 30000

[mcp.servers.laravel-boost]
transport = "stdio"
preset = "laravel-boost"

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

    const { config } = await loadHarnessConfig({ projectRoot });

    expect(config.mcp.allowlist).toEqual(["repo", "laravel-boost"]);
    expect(config.mcp.servers).toEqual({
      "laravel-boost": {
        preset: "laravel-boost",
        transport: "stdio",
      },
      repo: {
        args: ["scripts/repo-mcp.js"],
        command: "node",
        toolTimeoutMs: 30000,
        transport: "stdio",
        workingDirectory: ".",
      },
    });
  });

  it("rejects allowlist entries that do not map to configured MCP servers", async () => {
    const projectRoot = createTempProject();
    createdProjectRoots.push(projectRoot);

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
allowlist = ["missing-server"]

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

    await expect(loadHarnessConfig({ projectRoot })).rejects.toThrowError(
      /mcp\.allowlist\[0\]: Configured MCP server `missing-server` was not found in mcp\.servers\./u,
    );
  });
});
