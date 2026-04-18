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
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDirectory, "..", "..");
const cliEntrypoint = path.resolve(repoRoot, "src/cli/index.ts");
const tsxLoaderEntrypoint = path.resolve(
  repoRoot,
  "node_modules/tsx/dist/loader.mjs",
);

function runCli(args: string[], cwd: string) {
  return spawnSync(
    process.execPath,
    ["--import", tsxLoaderEntrypoint, cliEntrypoint, ...args],
    {
      cwd,
      encoding: "utf8",
    },
  );
}

function createTempProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "aeah-init-"));
}

describe("CLI init", () => {
  it("creates the config file, artifact directories, and gitignore entry", () => {
    const projectRoot = createTempProject();

    try {
      const result = runCli(["init"], projectRoot);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Setup Complete");
      expect(result.stdout).toContain("____  _");
      expect(result.stdout).toContain("created agent-harness.toml");
      expect(result.stdout).toContain("Files");
      expect(result.stdout).toContain("Detected defaults");
      expect(result.stdout).toContain("Next steps");
      expect(result.stdout).toContain("Execution target: host");
      expect(result.stdout).toContain(
        'Smoke test the command path with `blueprint run --command "npm test"`.',
      );
      expect(
        readFileSync(path.join(projectRoot, "agent-harness.toml"), "utf8"),
      ).toContain("version = 2");
      expect(
        readFileSync(path.join(projectRoot, "agent-harness.toml"), "utf8"),
      ).toContain("[models.agent]");
      expect(
        readFileSync(path.join(projectRoot, "agent-harness.toml"), "utf8"),
      ).toContain("[models.architect]");
      expect(
        readFileSync(path.join(projectRoot, "agent-harness.toml"), "utf8"),
      ).toContain('executionTarget = "host"');
      expect(
        readFileSync(path.join(projectRoot, ".gitignore"), "utf8"),
      ).toContain("/.agent-harness/");
      expect(
        readFileSync(path.join(projectRoot, "agent-harness.toml"), "utf8"),
      ).toContain("allowlist = []");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("is safe to re-run without overwriting the existing config", () => {
    const projectRoot = createTempProject();

    try {
      expect(runCli(["init"], projectRoot).status).toBe(0);

      const configPath = path.join(projectRoot, "agent-harness.toml");
      const customizedConfig = readFileSync(configPath, "utf8").replace(
        'executionTarget = "host"',
        'executionTarget = "docker"\ncontainerName = "web"',
      );
      const dockerConfig = customizedConfig.replace(
        'mode = "workspace-write"',
        'mode = "container"',
      );

      writeFileSync(configPath, dockerConfig, "utf8");

      const secondRun = runCli(["init"], projectRoot);
      const gitignoreContents = readFileSync(
        path.join(projectRoot, ".gitignore"),
        "utf8",
      );

      expect(secondRun.status).toBe(0);
      expect(secondRun.stdout).toContain("Setup Complete");
      expect(secondRun.stdout).toContain(
        "preserved existing agent-harness.toml",
      );
      expect(secondRun.stdout).toContain("models.agent");
      expect(secondRun.stdout).toContain("Next steps");
      expect(readFileSync(configPath, "utf8")).toContain(
        'executionTarget = "docker"',
      );
      expect(readFileSync(configPath, "utf8")).toContain(
        'containerName = "web"',
      );
      expect(secondRun.stdout).toContain("Execution target: docker");
      expect(secondRun.stdout).toContain(
        "Make sure the configured project container is already running before `blueprint run`.",
      );
      expect(gitignoreContents.match(/\/\.agent-harness\//gu)).toHaveLength(1);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("fails with a useful error when an existing config is invalid", () => {
    const projectRoot = createTempProject();

    try {
      writeFileSync(
        path.join(projectRoot, "agent-harness.toml"),
        `version = 1

[models.architect]
provider = 42
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

      const result = runCli(["init"], projectRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Invalid harness config");
      expect(result.stderr).toContain("agent-harness.toml");
      expect(result.stderr).toContain("models.architect.provider");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("does not duplicate the artifact ignore rule when .gitignore already has one", () => {
    const projectRoot = createTempProject();

    try {
      writeFileSync(
        path.join(projectRoot, ".gitignore"),
        ".agent-harness/\n",
        "utf8",
      );

      const result = runCli(["init"], projectRoot);
      const gitignoreContents = readFileSync(
        path.join(projectRoot, ".gitignore"),
        "utf8",
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("already contains /.agent-harness/");
      expect(result.stdout).toContain(
        "Keeps generated harness artifacts out of version control.",
      );
      expect(gitignoreContents).toBe(".agent-harness/\n");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("fails with a useful error when the config path is a directory", () => {
    const projectRoot = createTempProject();

    try {
      mkdirSync(path.join(projectRoot, "agent-harness.toml"));

      const result = runCli(["init"], projectRoot);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Invalid harness config");
      expect(result.stderr).toContain("Could not read config file");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
