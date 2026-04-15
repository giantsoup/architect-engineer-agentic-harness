import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendRunEvent,
  initializeProject,
  initializeRunDossier,
  loadHarnessConfig,
  writeRunLifecycleStatus,
  writeRunResult,
} from "../../src/index.js";
import { readRunInspection } from "../../src/runtime/run-history.js";

describe("readRunInspection", () => {
  const projectRoots: string[] = [];

  afterEach(() => {
    for (const projectRoot of projectRoots.splice(0)) {
      rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it("ignores stale result artifacts while the manifest still reports a running task", async () => {
    const projectRoot = mkdtempSync(
      path.join(os.tmpdir(), "aeah-run-history-"),
    );

    projectRoots.push(projectRoot);
    await initializeProject(projectRoot);
    const loadedConfig = await loadHarnessConfig({ projectRoot });
    const dossier = await initializeRunDossier(loadedConfig, {
      createdAt: new Date("2026-04-15T19:34:15.691Z"),
      runId: "20260415T193415.691Z-abc123",
    });

    await writeRunResult(
      dossier.paths,
      {
        status: "stopped",
        summary: "Stale placeholder result that should be ignored.",
      },
      "2026-04-15T19:34:15.800Z",
    );
    await writeRunLifecycleStatus(
      dossier.paths,
      "running",
      "2026-04-15T19:34:16.000Z",
    );
    await appendRunEvent(dossier.paths, {
      requiredCheckCommand: "npm run test",
      task: "Create SANITY.md and NOTES.md.",
      timestamp: "2026-04-15T19:34:16.100Z",
      type: "architect-engineer-run-started",
    });
    await appendRunEvent(dossier.paths, {
      actionType: "tool",
      iteration: 1,
      summary: "Run the required check.",
      timestamp: "2026-04-15T19:34:16.200Z",
      toolRequest: {
        command: "npm run test",
        toolName: "command.execute",
      },
      type: "engineer-action-selected",
    });

    const inspection = await readRunInspection(dossier.paths, {
      now: new Date("2026-04-15T19:34:18.000Z"),
    });

    expect(inspection.status).toBe("running");
    expect(inspection.phase).toBe("Execution");
    expect(inspection.summary).toBe("Running");
    expect(inspection.commandStatus).toBe(
      "Running required check: npm run test",
    );
  });
});
