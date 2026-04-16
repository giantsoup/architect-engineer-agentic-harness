import { describe, expect, it, vi } from "vitest";

import { createHarnessEventBus } from "../../src/runtime/harness-events.js";
import type { RunInspection } from "../../src/runtime/run-history.js";
import { createTuiLiveDataSource } from "../../src/tui/live-data.js";
import { createInitialTuiState, createTuiStore } from "../../src/tui/state.js";
import type {
  TuiArtifactReader,
  TuiArtifactSnapshot,
} from "../../src/tui/artifact-reader.js";
import type { RunDossierPaths } from "../../src/artifacts/paths.js";

describe("tui live event bridge", () => {
  it("pushes live command output into the log, engineer pane, diff pane, and tests pane", async () => {
    const eventBus = createHarnessEventBus({
      now: () => new Date("2026-04-16T01:00:00.000Z"),
    });
    const store = createTuiStore(
      createInitialTuiState({
        demoMode: false,
        runLabel: "20260416T010000.000Z-abc123",
        task: "Wire the live TUI.",
      }),
    );
    let snapshot = createArtifactSnapshot();
    const artifactReader: TuiArtifactReader = {
      read: vi.fn(async () => snapshot),
    };
    const liveData = createTuiLiveDataSource({
      artifactReader,
      eventBus,
      inspectionReader: vi.fn(async () => createInspection()),
      paths: createPaths(),
      pollIntervalMs: 10_000,
      store,
      task: "Wire the live TUI.",
    });

    liveData.start();
    await settle();

    eventBus.emit({
      accessMode: "mutate",
      command: "npm test",
      role: "engineer",
      runId: createPaths().runId,
      timestamp: "2026-04-16T01:00:01.000Z",
      type: "command:start",
      workingDirectory: "packages/app",
    });
    eventBus.emit({
      chunk: "failing test output\n",
      command: "npm test",
      role: "engineer",
      runId: createPaths().runId,
      timestamp: "2026-04-16T01:00:01.100Z",
      type: "command:stdout",
    });
    await settle();

    expect(store.getState().panes.engineer.lines).toContain(
      "Current command: npm test",
    );
    expect(store.getState().panes.engineer.lines).toContain(
      "Working dir: packages/app",
    );
    expect(
      store
        .getState()
        .log.entries.some((entry) =>
          entry.summary.includes("stdout: failing test output"),
        ),
    ).toBe(true);
    expect(store.getState().panes.tests.lines).toContain(
      "  stdout | failing test output",
    );

    snapshot = {
      ...snapshot,
      diff: "diff --git a/src/tui/app.ts b/src/tui/app.ts\n+live bridge\n",
    };
    eventBus.emit({
      artifact: "diff",
      artifactKind: "patch",
      operation: "write",
      path: ".agent-harness/runs/20260416T010000.000Z-abc123/diff.patch",
      runId: createPaths().runId,
      timestamp: "2026-04-16T01:00:01.200Z",
      type: "artifact:update",
    });
    await settle();

    expect(store.getState().panes.diff.lines[0]).toBe(
      "diff --git a/src/tui/app.ts b/src/tui/app.ts",
    );

    snapshot = {
      ...snapshot,
      checks: {
        checks: [
          {
            command: "npm test",
            durationMs: 234,
            exitCode: 1,
            name: "required-check",
            status: "failed",
          },
        ],
      },
      commandLog: [
        {
          accessMode: "mutate",
          command: "npm test",
          durationMs: 234,
          exitCode: 1,
          role: "engineer",
          status: "completed",
          stdout: "failing test output\n",
          timestamp: "2026-04-16T01:00:01.300Z",
          workingDirectory: "packages/app",
        },
      ],
    };
    eventBus.emit({
      accessMode: "mutate",
      command: "npm test",
      durationMs: 234,
      executionTarget: "host",
      exitCode: 1,
      role: "engineer",
      runId: createPaths().runId,
      status: "completed",
      timestamp: "2026-04-16T01:00:01.300Z",
      type: "command:end",
      workingDirectory: "packages/app",
    });
    eventBus.emit({
      check: {
        command: "npm test",
        durationMs: 234,
        exitCode: 1,
        name: "required-check",
        status: "failed",
      },
      consecutiveFailedChecks: 1,
      requiredCheckCommand: "npm test",
      runId: createPaths().runId,
      timestamp: "2026-04-16T01:00:01.350Z",
      totalChecks: 1,
      type: "check:update",
    });
    await settle();

    expect(store.getState().panes.tests.lines).toContain("State: failed");
    expect(store.getState().panes.tests.lines).toContain("Exit code: 1");
    expect(store.getState().panes.engineer.lines).toContain(
      "Check status: failed (exit 1): npm test",
    );

    await liveData.stop();
  });
});

function createPaths(): RunDossierPaths {
  return {
    files: {
      architectPlan: { absolutePath: "/tmp/architect-plan.md" },
      architectReview: { absolutePath: "/tmp/architect-review.md" },
      checks: { absolutePath: "/tmp/checks.json" },
      commandLog: { absolutePath: "/tmp/command-log.jsonl" },
      diff: { absolutePath: "/tmp/diff.patch" },
      engineerTask: { absolutePath: "/tmp/engineer-task.md" },
      events: { absolutePath: "/tmp/events.jsonl" },
    },
    runDirRelativePath: ".agent-harness/runs/20260416T010000.000Z-abc123",
    runId: "20260416T010000.000Z-abc123",
  } as unknown as RunDossierPaths;
}

function createInspection(): RunInspection {
  return {
    activeRole: "engineer",
    artifacts: {} as never,
    commandStatus: "Running required check: npm test",
    createdAt: "2026-04-16T01:00:00.000Z",
    currentObjective: "Run the required check",
    elapsedMs: 1_000,
    latestDecision: "Verify the change with the required check.",
    manifest: {} as never,
    phase: "Execution",
    primaryArtifacts: [],
    runDirAbsolutePath:
      "/tmp/project/.agent-harness/runs/20260416T010000.000Z-abc123",
    runDirRelativePath: ".agent-harness/runs/20260416T010000.000Z-abc123",
    runId: "20260416T010000.000Z-abc123",
    status: "running",
    summary: "Engineer execution in progress.",
    task: "Wire the live TUI.",
    updatedAt: "2026-04-16T01:00:01.000Z",
  } as unknown as RunInspection;
}

function createArtifactSnapshot(): TuiArtifactSnapshot {
  return {
    architectPlan: "",
    architectReview: "",
    checks: undefined,
    commandLog: [],
    diff: "",
    engineerTask: [
      "# Engineer Task Brief",
      "",
      "## Execution Order",
      "",
      "1. Inspect the live command output.",
      "2. Run `npm test`.",
    ].join("\n"),
    events: [
      {
        requiredCheckCommand: "npm test",
        timestamp: "2026-04-16T01:00:00.500Z",
        type: "engineer-run-started",
      },
    ],
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 80);
  });
}
