import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  appendCommandLog,
  appendRunEvent,
  initializeRunDossier,
  loadHarnessConfig,
  writeChecks,
  writeDiff,
  writeFailureNotes,
  writeFinalReport,
  writeRunResult,
} from "../../src/index.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDirectory, "..", "..");
const cliEntrypoint = path.resolve(repoRoot, "src/cli/index.ts");
const tsxLoaderEntrypoint = path.resolve(
  repoRoot,
  "node_modules/tsx/dist/loader.mjs",
);

describe("CLI inspect", () => {
  it("prints an artifact-oriented view without dumping artifact contents", async () => {
    const projectRoot = createTempProject();

    try {
      expect(runCli(["init"], projectRoot).status).toBe(0);

      const loadedConfig = await loadHarnessConfig({ projectRoot });
      const runId = "20260414T120000.000Z-abc125";
      const dossier = await initializeRunDossier(loadedConfig, {
        createdAt: new Date("2026-04-14T12:00:00.000Z"),
        runId,
      });

      await appendRunEvent(dossier.paths, {
        requiredCheckCommand: "npm test",
        task: "Ship Milestone 11",
        timestamp: "2026-04-14T12:00:00.000Z",
        type: "architect-engineer-run-started",
      });
      await appendRunEvent(dossier.paths, {
        steps: ["Reduce terminal noise"],
        summary: "Present a concise manager-level run summary.",
        timestamp: "2026-04-14T12:00:01.000Z",
        type: "architect-plan-created",
      });
      await appendCommandLog(dossier.paths, {
        command: "npm test",
        durationMs: 3_000,
        exitCode: 1,
        role: "engineer",
        status: "completed",
        timestamp: "2026-04-14T12:00:15.000Z",
      });
      await writeChecks(
        dossier.paths,
        {
          checks: [
            {
              command: "npm test",
              exitCode: 1,
              name: "test",
              status: "failed",
              summary: "Required check failed with exit code 1.",
            },
          ],
          recordedAt: "2026-04-14T12:00:15.000Z",
        },
        "2026-04-14T12:00:15.000Z",
      );
      await writeDiff(
        dossier.paths,
        "diff --git a/src/cli/commands/run.ts b/src/cli/commands/run.ts\n",
        "2026-04-14T12:00:15.000Z",
      );
      await writeFailureNotes(
        dossier.paths,
        "# Failure Notes\n\nThe required check still fails.\n",
        "2026-04-14T12:00:15.000Z",
      );
      await writeFinalReport(
        dossier.paths,
        "# Final Report\n\nInspect should show the path, not the contents.\n",
        "2026-04-14T12:00:15.000Z",
      );
      await appendRunEvent(dossier.paths, {
        status: "failed",
        stopReason: "engineer-blocked",
        summary: "The required check still fails.",
        timestamp: "2026-04-14T12:00:15.000Z",
        type: "architect-engineer-run-finished",
      });
      await writeRunResult(
        dossier.paths,
        {
          artifacts: [
            dossier.paths.files.finalReport.relativePath,
            dossier.paths.files.result.relativePath,
            dossier.paths.files.events.relativePath,
            dossier.paths.files.checks.relativePath,
            dossier.paths.files.commandLog.relativePath,
            dossier.paths.files.failureNotes.relativePath,
          ],
          status: "failed",
          summary: "The required check still fails.",
        },
        "2026-04-14T12:00:15.000Z",
      );

      const result = runCli(["inspect", runId], projectRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Run ${runId}`);
      expect(result.stdout).toContain("Status: failed");
      expect(result.stdout).toContain("Result JSON:");
      expect(result.stdout).toContain("final-report.md");
      expect(result.stdout).toContain("result.json");
      expect(result.stdout).toContain("events.jsonl");
      expect(result.stdout).toContain("checks.json");
      expect(result.stdout).toContain("command-log.jsonl");
      expect(result.stdout).toContain("failure-notes.md");
      expect(result.stdout).not.toContain(
        "Inspect should show the path, not the contents.",
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

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
  return mkdtempSync(path.join(os.tmpdir(), "aeah-inspect-cli-"));
}
