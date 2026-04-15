import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendCommandLog,
  appendStructuredMessage,
  initializeProject,
  initializeRunDossier,
  loadHarnessConfig,
  readRunManifest,
  RunDossierError,
  RunResultValidationError,
  validateRunResult,
  writeRunResult,
} from "../../src/index.js";
import type { LoadedHarnessConfig } from "../../src/index.js";

const FIXED_RUN_ID = "20260413T120000.000Z-abc123";
const FIXED_CREATED_AT = new Date("2026-04-13T12:00:00.000Z");
const EXPECTED_DOSSIER_FILES = [
  "run.json",
  "events.jsonl",
  "architect-plan.md",
  "engineer-task.md",
  "architect-review.md",
  "command-log.jsonl",
  "checks.json",
  "diff.patch",
  "failure-notes.md",
  "result.json",
  "final-report.md",
] as const;

function createTempProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "aeah-run-dossier-"));
}

async function createInitializedProject(): Promise<LoadedHarnessConfig> {
  const projectRoot = createTempProject();
  await initializeProject(projectRoot);
  return loadHarnessConfig({ projectRoot });
}

describe("run dossier", () => {
  it("creates the full expected dossier layout for a dummy run", async () => {
    const loadedConfig = await createInitializedProject();

    try {
      const dossier = await initializeRunDossier(loadedConfig, {
        createdAt: FIXED_CREATED_AT,
        runId: FIXED_RUN_ID,
      });

      expect(dossier.manifest.runId).toBe(FIXED_RUN_ID);
      expect(dossier.manifest.status).toBe("initialized");
      expect(dossier.manifest.promptVersion).toBe("v1");
      expect(dossier.manifest.schemaVersion).toBe("v1");

      for (const fileName of EXPECTED_DOSSIER_FILES) {
        const artifactStats = await stat(
          path.join(dossier.paths.runDirAbsolutePath, fileName),
        );

        expect(artifactStats.isFile()).toBe(true);
      }

      const initializedResult = JSON.parse(
        readFileSync(dossier.paths.files.result.absolutePath, "utf8"),
      );
      const parsedEvents = readJsonLines(
        dossier.paths.files.events.absolutePath,
      );

      expect(await validateRunResult(initializedResult)).toEqual({
        status: "stopped",
        summary: "Run initialized. Final result pending.",
      });
      expect(parsedEvents).toHaveLength(1);
      expect(parsedEvents[0]).toMatchObject({
        schemaVersion: "v1",
        timestamp: FIXED_CREATED_AT.toISOString(),
        type: "run-initialized",
      });
    } finally {
      rmSync(loadedConfig.projectRoot, { force: true, recursive: true });
    }
  });

  it("writes a canonical manifest with consistent file references", async () => {
    const loadedConfig = await createInitializedProject();

    try {
      const dossier = await initializeRunDossier(loadedConfig, {
        createdAt: FIXED_CREATED_AT,
        runId: FIXED_RUN_ID,
      });
      const manifest = await readRunManifest(dossier.paths);

      expect(manifest.artifactsRootDir).toBe(".agent-harness");
      expect(manifest.runsDir).toBe(".agent-harness/runs");
      expect(manifest.runDir).toBe(`.agent-harness/runs/${FIXED_RUN_ID}`);
      expect(manifest.files.run.relativePath).toBe(
        `${manifest.runDir}/run.json`,
      );
      expect(manifest.files.commandLog.relativePath).toBe(
        `${manifest.runDir}/command-log.jsonl`,
      );
      expect(manifest.files.finalReport.relativePath).toBe(
        `${manifest.runDir}/final-report.md`,
      );
      expect(manifest.schemas.runResult).toEqual({
        id: "run-result",
        sourcePath: "schemas/v1/run-result.schema.json",
        sourceRoot: "package",
        version: "v1",
      });
      expect(manifest.schemas.architectPlan).toEqual({
        id: "architect-plan",
        sourcePath: "schemas/v1/architect-plan.schema.json",
        sourceRoot: "package",
        version: "v1",
      });
      expect(manifest.schemas.architectReview).toEqual({
        id: "architect-review",
        sourcePath: "schemas/v1/architect-review.schema.json",
        sourceRoot: "package",
        version: "v1",
      });
      expect(manifest.prompts.map((prompt) => prompt.sourcePath)).toEqual([
        "prompts/v1/architect/system.md",
        "prompts/v1/architect/planning.md",
        "prompts/v1/architect/review.md",
        "prompts/v1/engineer/system.md",
        "prompts/v1/engineer/execute.md",
      ]);
    } finally {
      rmSync(loadedConfig.projectRoot, { force: true, recursive: true });
    }
  });

  it("appends valid JSONL records even when the file is missing a trailing newline", async () => {
    const loadedConfig = await createInitializedProject();

    try {
      const dossier = await initializeRunDossier(loadedConfig, {
        createdAt: FIXED_CREATED_AT,
        runId: FIXED_RUN_ID,
      });

      writeFileSync(
        dossier.paths.files.commandLog.absolutePath,
        '{"timestamp":"2026-04-13T12:00:01.000Z","command":"npm test","durationMs":1,"exitCode":0}',
        "utf8",
      );

      await appendStructuredMessage(dossier.paths, {
        content: "Investigate the failing checks.",
        role: "architect",
        timestamp: "2026-04-13T12:00:02.000Z",
      });
      await appendCommandLog(dossier.paths, {
        command: "npm test",
        durationMs: 1200,
        exitCode: 0,
        role: "engineer",
        stdout: "ok",
        timestamp: "2026-04-13T12:00:03.000Z",
      });

      const parsedEvents = readJsonLines(
        dossier.paths.files.events.absolutePath,
      );
      const parsedCommandLog = readJsonLines(
        dossier.paths.files.commandLog.absolutePath,
      );

      expect(parsedEvents).toHaveLength(2);
      expect(parsedEvents[1]).toMatchObject({
        content: "Investigate the failing checks.",
        role: "architect",
        type: "message",
      });
      expect(parsedCommandLog).toHaveLength(2);
      expect(parsedCommandLog[1]).toMatchObject({
        durationMs: 1200,
        role: "engineer",
      });
    } finally {
      rmSync(loadedConfig.projectRoot, { force: true, recursive: true });
    }
  });

  it("validates and writes the final run result", async () => {
    const loadedConfig = await createInitializedProject();

    try {
      const dossier = await initializeRunDossier(loadedConfig, {
        createdAt: FIXED_CREATED_AT,
        runId: FIXED_RUN_ID,
      });

      const nextManifest = await writeRunResult(
        dossier.paths,
        {
          artifacts: [dossier.paths.files.finalReport.relativePath],
          convergence: {
            duplicateExplorationSuppressions: 1,
            explorationBudget: 12,
            explorationBudgetExhaustedAtStep: null,
            repeatedListingCount: 0,
            repeatedReadCount: 1,
            repoMemoryHits: 1,
            stepsToFirstCheck: 4,
            stepsToFirstEdit: 2,
          },
          git: {
            createdCommits: [
              {
                commitHash: "abc123",
                message: "ae(run): engineer milestone 1",
                phase: "engineer-milestone",
                recordedAt: "2026-04-13T12:00:04.000Z",
              },
            ],
            dirtyWorkingTreeOutcome: "clean",
            dirtyWorkingTreePolicy: "stop",
            errors: [],
            finalCommit: "abc123",
            initialWorkingTree: {
              changedPaths: [],
              hasStagedChanges: false,
              hasUnstagedChanges: false,
              hasUntrackedChanges: false,
              isDirty: false,
            },
            runBranch: "ae/run-branch",
            startingBranch: "main",
            startingCommit: "def456",
            warnings: [],
          },
          status: "success",
          summary: "All checks passed.",
        },
        "2026-04-13T12:00:05.000Z",
      );
      const persistedResult = JSON.parse(
        readFileSync(dossier.paths.files.result.absolutePath, "utf8"),
      );

      expect(nextManifest.status).toBe("success");
      expect(nextManifest.updatedAt).toBe("2026-04-13T12:00:05.000Z");
      expect(await validateRunResult(persistedResult)).toEqual({
        artifacts: [dossier.paths.files.finalReport.relativePath],
        convergence: {
          duplicateExplorationSuppressions: 1,
          explorationBudget: 12,
          explorationBudgetExhaustedAtStep: null,
          repeatedListingCount: 0,
          repeatedReadCount: 1,
          repoMemoryHits: 1,
          stepsToFirstCheck: 4,
          stepsToFirstEdit: 2,
        },
        git: {
          createdCommits: [
            {
              commitHash: "abc123",
              message: "ae(run): engineer milestone 1",
              phase: "engineer-milestone",
              recordedAt: "2026-04-13T12:00:04.000Z",
            },
          ],
          dirtyWorkingTreeOutcome: "clean",
          dirtyWorkingTreePolicy: "stop",
          errors: [],
          finalCommit: "abc123",
          initialWorkingTree: {
            changedPaths: [],
            hasStagedChanges: false,
            hasUnstagedChanges: false,
            hasUntrackedChanges: false,
            isDirty: false,
          },
          runBranch: "ae/run-branch",
          startingBranch: "main",
          startingCommit: "def456",
          warnings: [],
        },
        status: "success",
        summary: "All checks passed.",
      });
    } finally {
      rmSync(loadedConfig.projectRoot, { force: true, recursive: true });
    }
  });

  it("fails clearly when the final run result is invalid", async () => {
    const loadedConfig = await createInitializedProject();

    try {
      const dossier = await initializeRunDossier(loadedConfig, {
        createdAt: FIXED_CREATED_AT,
        runId: FIXED_RUN_ID,
      });

      await expect(
        writeRunResult(dossier.paths, {
          status: "success",
          summary: "",
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(RunResultValidationError);
        expect((error as Error).message).toContain(
          "schemas/v1/run-result.schema.json",
        );
        expect((error as Error).message).toContain("result.summary");

        return true;
      });
    } finally {
      rmSync(loadedConfig.projectRoot, { force: true, recursive: true });
    }
  });

  it("fails safely when reinitializing an existing run ID", async () => {
    const loadedConfig = await createInitializedProject();

    try {
      await initializeRunDossier(loadedConfig, {
        createdAt: FIXED_CREATED_AT,
        runId: FIXED_RUN_ID,
      });

      await expect(
        initializeRunDossier(loadedConfig, {
          createdAt: FIXED_CREATED_AT,
          runId: FIXED_RUN_ID,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(RunDossierError);
        expect((error as Error).message).toContain(
          `.agent-harness/runs/${FIXED_RUN_ID}`,
        );
        expect((error as Error).message).toContain("Use a new run ID");

        return true;
      });
    } finally {
      rmSync(loadedConfig.projectRoot, { force: true, recursive: true });
    }
  });

  it("uses the configured Milestone 1 artifact directories without changing bootstrap behavior", async () => {
    const projectRoot = createTempProject();

    try {
      await initializeProject(projectRoot);

      const configPath = path.join(projectRoot, "agent-harness.toml");
      const customizedConfig = readFileSync(configPath, "utf8")
        .replace('rootDir = ".agent-harness"', 'rootDir = ".custom-harness"')
        .replace(
          'runsDir = ".agent-harness/runs"',
          'runsDir = ".custom-harness/history"',
        );

      writeFileSync(configPath, customizedConfig, "utf8");

      const loadedConfig = await loadHarnessConfig({ projectRoot });
      const dossier = await initializeRunDossier(loadedConfig, {
        createdAt: FIXED_CREATED_AT,
        runId: FIXED_RUN_ID,
      });

      expect(dossier.paths.artifactsRootRelativePath).toBe(".custom-harness");
      expect(dossier.paths.runsDirRelativePath).toBe(".custom-harness/history");
      expect(dossier.paths.runDirRelativePath).toBe(
        `.custom-harness/history/${FIXED_RUN_ID}`,
      );
      expect(readFileSync(configPath, "utf8")).toContain(
        'runsDir = ".custom-harness/history"',
      );
    } finally {
      rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it("fails clearly when a programmatic caller points runs outside the artifact root", async () => {
    const loadedConfig = await createInitializedProject();

    try {
      const invalidLoadedConfig: LoadedHarnessConfig = {
        ...loadedConfig,
        config: {
          ...loadedConfig.config,
          artifacts: {
            ...loadedConfig.config.artifacts,
            runsDir: "outside-runs",
          },
        },
      };

      await expect(
        initializeRunDossier(invalidLoadedConfig, {
          createdAt: FIXED_CREATED_AT,
          runId: FIXED_RUN_ID,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(RunDossierError);
        expect((error as Error).message).toContain(
          "must stay within artifact root",
        );

        return true;
      });
    } finally {
      rmSync(loadedConfig.projectRoot, { force: true, recursive: true });
    }
  });

  it("fails clearly when a non-directory blocks artifact root creation", async () => {
    const projectRoot = createTempProject();

    try {
      await initializeProject(projectRoot);

      const artifactRootPath = path.join(projectRoot, ".agent-harness");
      rmSync(artifactRootPath, { force: true, recursive: true });
      writeFileSync(artifactRootPath, "blocked", "utf8");

      const loadedConfig = await loadHarnessConfig({ projectRoot });

      await expect(
        initializeRunDossier(loadedConfig, {
          createdAt: FIXED_CREATED_AT,
          runId: FIXED_RUN_ID,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(RunDossierError);
        expect((error as Error).message).toContain("artifact root");
        expect((error as Error).message).toContain("non-directory path");

        return true;
      });
    } finally {
      rmSync(projectRoot, { force: true, recursive: true });
    }
  });
});

function readJsonLines(filePath: string): unknown[] {
  const rawContents = readFileSync(filePath, "utf8");

  return rawContents
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}
