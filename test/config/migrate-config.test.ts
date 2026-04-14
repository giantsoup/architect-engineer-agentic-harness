import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CURRENT_HARNESS_CONFIG_VERSION,
  HarnessConfigError,
  loadHarnessConfig,
  migrateHarnessConfig,
} from "../../src/index.js";

function createTempProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "aeah-config-migrate-"));
}

describe("migrateHarnessConfig", () => {
  const projectRoots: string[] = [];

  afterEach(() => {
    for (const projectRoot of projectRoots.splice(0)) {
      rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it("normalizes the legacy commands.setup alias into commands.install", () => {
    const migrated = migrateHarnessConfig({
      commands: {
        setup: "npm ci",
      },
      version: CURRENT_HARNESS_CONFIG_VERSION,
    });

    expect(migrated.migrated).toBe(true);
    expect(migrated.value).toMatchObject({
      commands: {
        install: "npm ci",
        setup: "npm ci",
      },
      version: CURRENT_HARNESS_CONFIG_VERSION,
    });
  });

  it("rejects configs that omit the explicit version", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);

    writeFileSync(
      path.join(projectRoot, "agent-harness.toml"),
      `
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

    await expect(loadHarnessConfig({ projectRoot })).rejects.toThrowError(
      HarnessConfigError,
    );
    await expect(loadHarnessConfig({ projectRoot })).rejects.toThrowError(
      /version: Missing required config version\./u,
    );
  });

  it("rejects configs that declare a newer unsupported version", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);

    writeFileSync(
      path.join(projectRoot, "agent-harness.toml"),
      `version = ${CURRENT_HARNESS_CONFIG_VERSION + 1}

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

    await expect(loadHarnessConfig({ projectRoot })).rejects.toThrowError(
      /version: Config version 2 is newer than this CLI supports \(1\)\./u,
    );
  });
});
