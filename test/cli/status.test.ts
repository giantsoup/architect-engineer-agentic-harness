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

describe("CLI status", () => {
  it("summarizes the latest run by default with key artifact paths", async () => {
    const projectRoot = createTempProject();

    try {
      expect(runCli(["init"], projectRoot).status).toBe(0);

      const loadedConfig = await loadHarnessConfig({ projectRoot });

      await seedRun(loadedConfig, {
        createdAt: "2026-04-14T12:00:00.000Z",
        runId: "20260414T120000.000Z-abc123",
        status: "success",
        summary: "Older successful run.",
      });
      await seedRun(loadedConfig, {
        createdAt: "2026-04-14T12:10:00.000Z",
        runId: "20260414T121000.000Z-abc124",
        status: "failed",
        summary: "Latest run still has a failing check.",
      });

      const result = runCli(["status"], projectRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Run 20260414T121000.000Z-abc124");
      expect(result.stdout).toContain("Status: failed");
      expect(result.stdout).toContain(
        "Summary: Latest run still has a failing check.",
      );
      expect(result.stdout).toContain(
        "Dossier: .agent-harness/runs/20260414T121000.000Z-abc124",
      );
      expect(result.stdout).toContain("failure-notes.md");
      expect(result.stdout).toContain("checks.json");
      expect(result.stdout).toContain("command-log.jsonl");
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
  return mkdtempSync(path.join(os.tmpdir(), "aeah-status-cli-"));
}

async function seedRun(
  loadedConfig: Awaited<ReturnType<typeof loadHarnessConfig>>,
  options: {
    createdAt: string;
    runId: string;
    status: "failed" | "success";
    summary: string;
  },
): Promise<void> {
  const dossier = await initializeRunDossier(loadedConfig, {
    createdAt: new Date(options.createdAt),
    runId: options.runId,
  });
  const startedAt = options.createdAt;
  const finishedAt = new Date(
    Date.parse(options.createdAt) + 30_000,
  ).toISOString();

  await appendRunEvent(dossier.paths, {
    requiredCheckCommand: "npm test",
    task: "Ship Milestone 11",
    timestamp: startedAt,
    type: "architect-engineer-run-started",
  });
  await appendRunEvent(dossier.paths, {
    steps: ["Implement manager-level live summaries"],
    summary: "Focus the CLI on concise phase reporting.",
    timestamp: startedAt,
    type: "architect-plan-created",
  });
  await appendRunEvent(dossier.paths, {
    actionType: "tool",
    summary: "Run npm test",
    timestamp: startedAt,
    toolRequest: {
      command: "npm test",
      toolName: "command.execute",
    },
    type: "engineer-action-selected",
  });
  await appendCommandLog(dossier.paths, {
    command: "npm test",
    durationMs: 2_000,
    exitCode: options.status === "success" ? 0 : 1,
    role: "engineer",
    status: "completed",
    timestamp: finishedAt,
  });
  await writeChecks(
    dossier.paths,
    {
      checks: [
        {
          command: "npm test",
          exitCode: options.status === "success" ? 0 : 1,
          name: "test",
          status: options.status === "success" ? "passed" : "failed",
          summary:
            options.status === "success"
              ? "Required check passed."
              : "Required check failed with exit code 1.",
        },
      ],
      recordedAt: finishedAt,
    },
    finishedAt,
  );

  if (options.status === "failed") {
    await writeFailureNotes(
      dossier.paths,
      "# Failure Notes\n\nLatest required check still failed.\n",
      finishedAt,
    );
  }

  await writeFinalReport(
    dossier.paths,
    "# Final Report\n\nManager-level summary.\n",
    finishedAt,
  );
  await appendRunEvent(dossier.paths, {
    status: options.status,
    stopReason:
      options.status === "success" ? "architect-approved" : "engineer-blocked",
    summary: options.summary,
    timestamp: finishedAt,
    type: "architect-engineer-run-finished",
  });
  await writeRunResult(
    dossier.paths,
    {
      artifacts: [
        dossier.paths.files.finalReport.relativePath,
        dossier.paths.files.result.relativePath,
        dossier.paths.files.events.relativePath,
        dossier.paths.files.commandLog.relativePath,
        dossier.paths.files.checks.relativePath,
        ...(options.status === "failed"
          ? [dossier.paths.files.failureNotes.relativePath]
          : []),
      ],
      status: options.status,
      summary: options.summary,
    },
    finishedAt,
  );
}
