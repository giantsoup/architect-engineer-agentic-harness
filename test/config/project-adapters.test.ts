import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HarnessConfigError,
  initializeProject,
  loadHarnessConfig,
} from "../../src/index.js";

function createTempProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "aeah-project-config-"));
}

function writeProjectFile(
  projectRoot: string,
  relativePath: string,
  contents: string,
): void {
  writeFileSync(path.join(projectRoot, relativePath), contents, "utf8");
}

function writeBaseConfig(projectRoot: string, commandsBlock: string): void {
  writeProjectFile(
    projectRoot,
    "agent-harness.toml",
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
${commandsBlock}

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
  );
}

describe("project adapter config integration", () => {
  const projectRoots: string[] = [];

  afterEach(() => {
    for (const projectRoot of projectRoots.splice(0)) {
      rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it("initializes a TypeScript repo with detected commands", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);

    writeProjectFile(
      projectRoot,
      "package.json",
      JSON.stringify(
        {
          devDependencies: {
            typescript: "^5.8.3",
          },
          scripts: {
            lint: "eslint .",
            test: "vitest run",
            typecheck: "tsc --noEmit",
          },
        },
        null,
        2,
      ),
    );
    writeProjectFile(projectRoot, "tsconfig.json", "{}\n");
    writeProjectFile(projectRoot, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");

    const result = await initializeProject(projectRoot);
    const configContents = readFileSync(
      path.join(projectRoot, "agent-harness.toml"),
      "utf8",
    );

    expect(result.resolvedProject.adapter.id).toBe("typescript-generic");
    expect(configContents).toContain(
      "Detected project adapter: Generic TypeScript",
    );
    expect(configContents).toContain('install = "pnpm install"');
    expect(configContents).toContain('test = "pnpm run test"');
    expect(configContents).toContain('typecheck = "pnpm run typecheck"');
  });

  it("loads a minimal Laravel config by falling back to adapter detection", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);

    writeProjectFile(
      projectRoot,
      "composer.json",
      JSON.stringify(
        {
          require: {
            "laravel/framework": "^12.0",
          },
        },
        null,
        2,
      ),
    );
    writeProjectFile(projectRoot, "artisan", "#!/usr/bin/env php\n");
    writeBaseConfig(projectRoot, "");

    const loadedConfig = await loadHarnessConfig({ projectRoot });

    expect(loadedConfig.resolvedProject.adapter.id).toBe("laravel-generic");
    expect(loadedConfig.resolvedProject.commands.test).toEqual({
      command: "php artisan test",
      source: "adapter",
    });
  });

  it("initializes a Laravel repo with Laravel-aware detected commands", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);

    writeProjectFile(
      projectRoot,
      "composer.json",
      JSON.stringify(
        {
          require: {
            "laravel/framework": "^12.0",
          },
        },
        null,
        2,
      ),
    );
    writeProjectFile(projectRoot, "artisan", "#!/usr/bin/env php\n");

    const result = await initializeProject(projectRoot);
    const configContents = readFileSync(
      path.join(projectRoot, "agent-harness.toml"),
      "utf8",
    );

    expect(result.resolvedProject.adapter.id).toBe("laravel-generic");
    expect(configContents).toContain(
      "Detected project adapter: Generic Laravel",
    );
    expect(configContents).toContain('test = "php artisan test"');
    expect(configContents).toContain("[mcp.servers.laravel-boost]");
    expect(configContents).toContain('preset = "laravel-boost"');
  });

  it("lets explicit config overrides win over detected project commands", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);

    writeProjectFile(
      projectRoot,
      "package.json",
      JSON.stringify(
        {
          devDependencies: {
            typescript: "^5.8.3",
          },
          scripts: {
            test: "vitest run",
          },
        },
        null,
        2,
      ),
    );
    writeProjectFile(projectRoot, "tsconfig.json", "{}\n");
    writeBaseConfig(
      projectRoot,
      ['test = "npm run test:ci"', 'install = "npm ci"'].join("\n"),
    );

    const loadedConfig = await loadHarnessConfig({ projectRoot });

    expect(loadedConfig.resolvedProject.adapter.id).toBe("typescript-generic");
    expect(loadedConfig.resolvedProject.commands.install).toEqual({
      command: "npm ci",
      source: "config",
    });
    expect(loadedConfig.resolvedProject.commands.test).toEqual({
      command: "npm run test:ci",
      source: "config",
    });
  });

  it("still requires a test command when passing checks are mandatory", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);

    writeBaseConfig(projectRoot, "");

    await expect(loadHarnessConfig({ projectRoot })).rejects.toThrowError(
      HarnessConfigError,
    );
    await expect(loadHarnessConfig({ projectRoot })).rejects.toThrowError(
      /commands\.test: Could not resolve a required test command/u,
    );
  });
});
