import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDirectory, "..", "..");
const builtCliEntrypoint = path.join(repoRoot, "dist", "cli.js");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

describe.sequential("packaged CLI smoke", () => {
  beforeAll(() => {
    const buildResult = spawnSync(npmCommand, ["run", "build"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(buildResult.status).toBe(0);
  });

  it("prints help from the built CLI when invoked outside the repo root", () => {
    const outsideRoot = createTempProject("aeah-built-help-");

    try {
      const result = runBuiltCli(["--help"], outsideRoot);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).toContain("init");
      expect(result.stdout).toContain("run");
      expect(result.stdout).toContain("status");
      expect(result.stdout).toContain("inspect");
    } finally {
      rmSync(outsideRoot, { force: true, recursive: true });
    }
  });

  it("supports built-CLI init and run flows from an external temp repo", () => {
    const projectRoot = createTempProject("aeah-built-run-");

    try {
      const initResult = runBuiltCli(["init"], projectRoot);

      expect(initResult.status).toBe(0);
      expect(initResult.stdout).toContain("Setup Complete");
      expect(initResult.stdout).toContain("created agent-harness.toml");
      expect(initResult.stdout).toContain("Next steps");
      expect(
        readFileSync(path.join(projectRoot, "agent-harness.toml"), "utf8"),
      ).toContain('executionTarget = "host"');
      mkdirSync(path.join(projectRoot, "workspace", "app"), {
        recursive: true,
      });
      writeFileSync(
        path.join(projectRoot, "print-host-context.js"),
        [
          "process.stdout.write(`${process.cwd()}\\n`);",
          'process.stdout.write(`${process.env.APP_ENV ?? ""}\\n`);',
        ].join("\n"),
        "utf8",
      );

      const runResult = runBuiltCli(
        [
          "run",
          "--role",
          "engineer",
          "--command",
          "node ../../print-host-context.js",
          "--cwd",
          "workspace/app",
          "--env",
          "APP_ENV=testing",
        ],
        projectRoot,
      );

      expect(runResult.status).toBe(0);
      expect(runResult.stdout).toContain("workspace/app");
      expect(runResult.stdout).toContain("testing");
      expect(runResult.stderr).toContain("Command completed with exit code 0.");
      expect(runResult.stderr).toContain(".agent-harness/runs/");

      const runIds = readdirSync(
        path.join(projectRoot, ".agent-harness", "runs"),
      );

      expect(runIds).toHaveLength(1);
    } finally {
      rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it("supports tarball install, npx execution, init, and run outside the repo", () => {
    const packDirectory = createTempProject("aeah-pack-");
    const installRoot = createTempProject("aeah-install-");
    const projectRoot = path.join(installRoot, "project");

    try {
      mkdirSync(projectRoot, { recursive: true });

      const packResult = spawnSync(
        npmCommand,
        ["pack", "--pack-destination", packDirectory],
        {
          cwd: repoRoot,
          encoding: "utf8",
        },
      );

      expect(packResult.status).toBe(0);

      const tarballFileName = packResult.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .at(-1);

      expect(tarballFileName).toBe(
        "architect-engineer-agentic-harness-0.1.0.tgz",
      );

      const tarballPath = path.join(packDirectory, tarballFileName!);

      const npmInitResult = spawnSync(npmCommand, ["init", "-y"], {
        cwd: projectRoot,
        encoding: "utf8",
      });
      expect(npmInitResult.status).toBe(0);

      const installResult = spawnSync(
        npmCommand,
        ["install", "--silent", tarballPath],
        {
          cwd: projectRoot,
          encoding: "utf8",
        },
      );
      expect(installResult.status).toBe(0);
      mkdirSync(path.join(projectRoot, "workspace", "app"), {
        recursive: true,
      });
      writeFileSync(
        path.join(projectRoot, "print-host-context.js"),
        [
          "process.stdout.write(`${process.cwd()}\\n`);",
          'process.stdout.write(`${process.env.APP_ENV ?? ""}\\n`);',
        ].join("\n"),
        "utf8",
      );
      const env = { ...process.env };

      const helpResult = spawnSync(
        npxCommand(),
        ["architect-engineer-agentic-harness", "--help"],
        {
          cwd: projectRoot,
          encoding: "utf8",
          env,
        },
      );
      expect(helpResult.status).toBe(0);
      expect(helpResult.stdout).toContain("Usage:");
      expect(helpResult.stdout).toContain(
        "Usage: architect-engineer-agentic-harness",
      );

      const aliasHelpResult = spawnSync(npxCommand(), ["blueprint", "--help"], {
        cwd: projectRoot,
        encoding: "utf8",
        env,
      });
      expect(aliasHelpResult.status).toBe(0);
      expect(aliasHelpResult.stdout).toContain("Usage: blueprint");

      const initResult = spawnSync(npxCommand(), ["blueprint", "init"], {
        cwd: projectRoot,
        encoding: "utf8",
        env,
      });
      expect(initResult.status).toBe(0);
      expect(initResult.stdout).toContain("Setup Complete");
      expect(initResult.stdout).toContain("created agent-harness.toml");
      expect(initResult.stdout).toContain("Files");
      expect(
        readFileSync(path.join(projectRoot, "agent-harness.toml"), "utf8"),
      ).toContain('executionTarget = "host"');

      const runResult = spawnSync(
        npxCommand(),
        [
          "blueprint",
          "run",
          "--role",
          "engineer",
          "--command",
          "node ../../print-host-context.js",
          "--cwd",
          "workspace/app",
          "--env",
          "APP_ENV=testing",
        ],
        {
          cwd: projectRoot,
          encoding: "utf8",
          env,
        },
      );

      expect(runResult.status).toBe(0);
      expect(runResult.stdout).toContain("workspace/app");
      expect(runResult.stdout).toContain("testing");
      expect(runResult.stderr).toContain("Command completed with exit code 0.");
    } finally {
      rmSync(packDirectory, { force: true, recursive: true });
      rmSync(installRoot, { force: true, recursive: true });
    }
  }, 20_000);

  it("keeps the packed file list limited to runtime assets and examples", () => {
    const packResult = spawnSync(
      npmCommand,
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(packResult.status).toBe(0);

    const packedEntries = JSON.parse(packResult.stdout) as Array<{
      files: Array<{ path: string }>;
    }>;
    const packedPaths = packedEntries[0]!.files
      .map((file) => normalizePackPath(file.path))
      .sort();

    expect(packedPaths).toContain("dist/cli.js");
    expect(packedPaths).toContain("dist/index.js");
    expect(packedPaths).toContain("examples/typescript/agent-harness.toml");
    expect(packedPaths).toContain("examples/laravel/agent-harness.toml");
    expect(packedPaths).toContain("prompts/v1/architect/system.md");
    expect(packedPaths).toContain("schemas/v1/run-result.schema.json");
    expect(packedPaths).toContain("README.md");
    expect(packedPaths).toContain("LICENSE");
    expect(packedPaths).not.toContain("src/cli/index.ts");
    expect(packedPaths).not.toContain("test/cli/package-smoke.test.ts");
  });
});

function createTempProject(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runBuiltCli(args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [builtCliEntrypoint, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
}

function npxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function normalizePackPath(packPath: string): string {
  return packPath.replace(/^package\//u, "");
}
