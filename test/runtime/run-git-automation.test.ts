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

import { commitRunGitChanges } from "../../src/runtime/run-git-automation.js";
import { createInitialRunGitMetadata } from "../../src/runtime/run-git-state.js";
import {
  initializeProject,
  initializeRunDossier,
  loadHarnessConfig,
  type LoadedHarnessConfig,
} from "../../src/index.js";

function createTempProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "aeah-run-git-automation-"));
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

function git(projectRoot: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function commitAll(projectRoot: string, message: string): void {
  expect(
    spawnSync("git", ["add", "--all"], {
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
        message,
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
      },
    ).status,
  ).toBe(0);
}

async function createLoadedConfig(
  projectRoot: string,
): Promise<LoadedHarnessConfig> {
  await initializeProject(projectRoot);
  return loadHarnessConfig({ projectRoot });
}

describe("run git automation", () => {
  const projectRoots: string[] = [];

  afterEach(() => {
    for (const projectRoot of projectRoots.splice(0)) {
      rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it("does not include tracked artifact-root files in automation commits", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);
    initializeGitRepository(projectRoot);
    const loadedConfig = await createLoadedConfig(projectRoot);
    const artifactFile = path.join(
      projectRoot,
      ".agent-harness",
      "runs",
      "tracked-artifact.txt",
    );
    const sourceFile = path.join(projectRoot, "src", "example.ts");

    mkdirSync(path.dirname(sourceFile), { recursive: true });
    writeFileSync(sourceFile, "export const value = 1;\n", "utf8");
    writeFileSync(artifactFile, "artifact v1\n", "utf8");
    expect(
      spawnSync("git", ["add", "src/example.ts"], {
        cwd: projectRoot,
        encoding: "utf8",
      }).status,
    ).toBe(0);
    expect(
      spawnSync(
        "git",
        ["add", "-f", ".agent-harness/runs/tracked-artifact.txt"],
        {
          cwd: projectRoot,
          encoding: "utf8",
        },
      ).status,
    ).toBe(0);
    commitAll(projectRoot, "initial");

    const dossier = await initializeRunDossier(loadedConfig, {
      createdAt: new Date("2026-04-14T12:00:00.000Z"),
      runId: "20260414T120000.000Z-abc901",
    });

    writeFileSync(sourceFile, "export const value = 2;\n", "utf8");
    writeFileSync(artifactFile, "artifact v2\n", "utf8");

    const result = await commitRunGitChanges({
      dossier,
      engineerAttempt: 1,
      git: {
        ...createInitialRunGitMetadata(),
        dirtyWorkingTreeOutcome: "clean",
        runBranch: "main",
        startingBranch: "main",
        startingCommit: git(projectRoot, ["rev-parse", "HEAD"]),
      },
      loadedConfig,
      now: () => new Date("2026-04-14T12:00:30.000Z"),
      phase: "engineer-milestone",
      reviewCycle: 0,
      runId: "20260414T120000.000Z-abc901",
      task: "Update the source file only.",
    });

    expect(result.kind).toBe("committed");
    expect(git(projectRoot, ["show", "--name-only", "--format=", "HEAD"])).toBe(
      "src/example.ts",
    );
    expect(readFileSync(artifactFile, "utf8")).toBe("artifact v2\n");
  });
});
