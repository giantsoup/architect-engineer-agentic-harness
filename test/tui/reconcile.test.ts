import { describe, expect, it, vi } from "vitest";

import { createHarnessEventBus } from "../../src/runtime/harness-events.js";
import type { RunInspection } from "../../src/runtime/run-history.js";
import type {
  TuiArtifactReader,
  TuiArtifactSnapshot,
} from "../../src/tui/artifact-reader.js";
import { createTuiLiveDataSource } from "../../src/tui/live-data.js";
import { createInitialTuiState, createTuiStore } from "../../src/tui/state.js";
import type { RunDossierPaths } from "../../src/artifacts/paths.js";

describe("tui reconcile", () => {
  it("hydrates from inspection plus artifacts and force refresh rehydrates changed disk state", async () => {
    const eventBus = createHarnessEventBus({
      now: () => new Date("2026-04-16T02:00:00.000Z"),
    });
    const store = createTuiStore(
      createInitialTuiState({
        demoMode: false,
        runLabel: "20260416T020000.000Z-def456",
        task: "Hydrate the TUI from disk.",
      }),
    );
    let inspection = createInspection({
      currentObjective: "Implement the live reconcile path.",
      latestDecision: "Hydrate from inspection and artifacts.",
      status: "running",
      updatedAt: "2026-04-16T02:00:01.000Z",
    });
    let snapshot = createArtifactSnapshotOne();
    const artifactReader: TuiArtifactReader = {
      read: vi.fn(async () => snapshot),
    };
    const liveData = createTuiLiveDataSource({
      artifactReader,
      eventBus,
      inspectionReader: vi.fn(async () => inspection),
      paths: createPaths(),
      pollIntervalMs: 10_000,
      store,
      task: "Hydrate the TUI from disk.",
    });

    liveData.start();
    await settle();

    const initialState = store.getState();

    expect(
      initialState.cards.architect.lines.some((line: string) =>
        line.includes("Keep the change additive."),
      ),
    ).toBe(true);
    expect(
      initialState.cards.architect.lines.some((line: string) =>
        line.includes("handoff / waiting"),
      ),
    ).toBe(true);
    expect(
      initialState.cards.architect.lines.some((line: string) =>
        line.includes("Hydrate from inspection and artifacts."),
      ),
    ).toBe(true);
    expect(
      initialState.cards.engineer.lines.some((line: string) =>
        line.includes("Implement the live reconcile path."),
      ),
    ).toBe(true);
    expect(
      initialState.cards.engineer.lines.some((line: string) =>
        line.includes("passed"),
      ),
    ).toBe(true);
    expect(
      initialState.cards.engineer.lines.some((line: string) =>
        line.includes("npm test"),
      ),
    ).toBe(true);
    expect(
      initialState.cards.engineer.lines.some((line: string) =>
        line.includes("passed (exit 0): npm test"),
      ),
    ).toBe(true);
    expect(
      initialState.log.entries.some((entry) =>
        entry.summary.includes("file.write completed"),
      ),
    ).toBe(true);

    inspection = createInspection({
      currentObjective: "Verify the refreshed diff and failed check output.",
      latestDecision: "Force refresh after the diff and checks changed.",
      status: "failed",
      updatedAt: "2026-04-16T02:00:03.000Z",
    });
    snapshot = createArtifactSnapshotTwo();
    store.dispatch({
      type: "run.stop.requested",
    });

    await liveData.forceRefresh();

    const refreshedState = store.getState();

    expect(
      refreshedState.cards.architect.lines.some((line: string) =>
        line.includes("Force refresh after the diff and checks changed."),
      ),
    ).toBe(true);
    expect(
      refreshedState.cards.engineer.lines.some((line: string) =>
        line.includes("failed"),
      ),
    ).toBe(true);
    expect(
      refreshedState.cards.engineer.lines.some((line: string) =>
        line.includes("exit 1"),
      ),
    ).toBe(true);
    expect(refreshedState.statusText).toContain(
      "Required check failed (exit 1): npm test",
    );
    expect(refreshedState.runActive).toBe(false);
    expect(refreshedState.runStopRequested).toBe(false);

    await liveData.stop();
  });

  it("degrades cleanly when a reconcile read fails instead of throwing through the UI", async () => {
    const eventBus = createHarnessEventBus({
      now: () => new Date("2026-04-16T02:30:00.000Z"),
    });
    const store = createTuiStore(
      createInitialTuiState({
        demoMode: false,
        runLabel: "20260416T023000.000Z-ghi789",
        task: "Handle reconcile failures safely.",
      }),
    );
    const artifactReader: TuiArtifactReader = {
      read: vi.fn(async () => {
        throw new Error("diff parse failed");
      }),
    };
    const liveData = createTuiLiveDataSource({
      artifactReader,
      eventBus,
      inspectionReader: vi.fn(async () =>
        createInspection({
          currentObjective: "Recover from a reconcile failure.",
          latestDecision: "Keep the TUI responsive after a disk read error.",
          status: "running",
          updatedAt: "2026-04-16T02:30:01.000Z",
        }),
      ),
      paths: createPaths(),
      pollIntervalMs: 10_000,
      store,
      task: "Handle reconcile failures safely.",
    });

    liveData.start();
    await settle();

    expect(store.getState().statusText).toContain(
      "TUI live-data degraded: diff parse failed",
    );
    expect(
      store
        .getState()
        .log.entries.some((entry) =>
          entry.summary.includes(
            "TUI live-data error while running a hydrate reconcile: diff parse failed",
          ),
        ),
    ).toBe(true);

    await liveData.stop();
  });

  it("surfaces architect handoff state even when only inspection data shows the engineer is active", async () => {
    const eventBus = createHarnessEventBus({
      now: () => new Date("2026-04-16T02:45:00.000Z"),
    });
    const store = createTuiStore(
      createInitialTuiState({
        demoMode: false,
        runLabel: "20260416T024500.000Z-handoff",
        task: "Verify architect handoff messaging.",
      }),
    );
    const artifactReader: TuiArtifactReader = {
      read: vi.fn(async () => ({
        ...createArtifactSnapshotOne(),
        events: [
          {
            summary: "Shape the embedded architect sections.",
            timestamp: "2026-04-16T02:45:00.400Z",
            type: "architect-plan-created",
          },
        ],
      })),
    };
    const liveData = createTuiLiveDataSource({
      artifactReader,
      eventBus,
      inspectionReader: vi.fn(async () =>
        createInspection({
          currentObjective: "Handoff to the engineer for execution.",
          latestDecision: "The shell is ready for execution.",
          status: "running",
          updatedAt: "2026-04-16T02:45:01.000Z",
        }),
      ),
      paths: createPaths(),
      pollIntervalMs: 10_000,
      store,
      task: "Verify architect handoff messaging.",
    });

    liveData.start();
    await settle();

    expect(
      store
        .getState()
        .cards.architect.lines.some((line: string) =>
          line.includes("handoff / waiting"),
        ),
    ).toBe(true);
    expect(
      store
        .getState()
        .cards.architect.lines.some((line: string) =>
          line.includes("The shell is ready for execution."),
        ),
    ).toBe(true);

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
    runDirRelativePath: ".agent-harness/runs/20260416T020000.000Z-def456",
    runId: "20260416T020000.000Z-def456",
  } as unknown as RunDossierPaths;
}

function createInspection(overrides: {
  currentObjective: string;
  latestDecision: string;
  status: "failed" | "running" | "stopped" | "success";
  updatedAt: string;
}): RunInspection {
  return {
    activeRole: overrides.status === "running" ? "engineer" : "system",
    artifacts: {} as never,
    commandStatus:
      overrides.status === "failed"
        ? "Required check failed (exit 1): npm test"
        : "Required check passed (exit 0): npm test",
    createdAt: "2026-04-16T02:00:00.000Z",
    currentObjective: overrides.currentObjective,
    elapsedMs: 3_000,
    latestDecision: overrides.latestDecision,
    manifest: {} as never,
    phase: overrides.status === "running" ? "Execution" : "Failed",
    primaryArtifacts: [],
    runDirAbsolutePath:
      "/tmp/project/.agent-harness/runs/20260416T020000.000Z-def456",
    runDirRelativePath: ".agent-harness/runs/20260416T020000.000Z-def456",
    runId: "20260416T020000.000Z-def456",
    status: overrides.status,
    summary: overrides.latestDecision,
    task: "Hydrate the TUI from disk.",
    updatedAt: overrides.updatedAt,
  } as unknown as RunInspection;
}

function createArtifactSnapshotOne(): TuiArtifactSnapshot {
  return {
    architectPlan: ["# Architect Plan", "", "- Keep the change additive."].join(
      "\n",
    ),
    architectReview: "",
    checks: {
      checks: [
        {
          command: "npm test",
          durationMs: 111,
          exitCode: 0,
          name: "required-check",
          status: "passed",
        },
      ],
    },
    commandLog: [
      {
        accessMode: "mutate",
        command: "npm test",
        durationMs: 111,
        exitCode: 0,
        role: "engineer",
        status: "completed",
        stdout: "all green\n",
        timestamp: "2026-04-16T02:00:01.200Z",
        workingDirectory: ".",
      },
    ],
    diff: "diff --git a/src/tui/app.ts b/src/tui/app.ts\n+first hydrate\n",
    engineerTask: [
      "# Engineer Task Brief",
      "",
      "## Execution Order",
      "",
      "1. Update the TUI bridge.",
      "2. Run `npm test`.",
      "3. Summarize the result.",
    ].join("\n"),
    events: [
      {
        summary: "Shape the embedded architect sections.",
        timestamp: "2026-04-16T02:00:00.400Z",
        type: "architect-plan-created",
      },
      {
        requiredCheckCommand: "npm test",
        timestamp: "2026-04-16T02:00:00.500Z",
        type: "engineer-run-started",
      },
      {
        request: {
          path: "src/tui/app.ts",
          toolName: "file.write",
        },
        role: "engineer",
        status: "completed",
        timestamp: "2026-04-16T02:00:01.100Z",
        toolName: "file.write",
        type: "tool-call",
      },
    ],
  };
}

function createArtifactSnapshotTwo(): TuiArtifactSnapshot {
  return {
    architectPlan: ["# Architect Plan", "", "- Keep the change additive."].join(
      "\n",
    ),
    architectReview: [
      "# Architect Review",
      "",
      "- Force refresh should rehydrate from disk.",
    ].join("\n"),
    checks: {
      checks: [
        {
          command: "npm test",
          durationMs: 222,
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
        durationMs: 222,
        exitCode: 1,
        role: "engineer",
        status: "completed",
        stderr: "one test failed\n",
        timestamp: "2026-04-16T02:00:02.800Z",
        workingDirectory: ".",
      },
    ],
    diff: "diff --git a/src/tui/app.ts b/src/tui/app.ts\n+refresh from disk\n",
    engineerTask: [
      "# Engineer Task Brief",
      "",
      "## Execution Order",
      "",
      "1. Update the TUI bridge.",
      "2. Run `npm test`.",
      "3. Summarize the result.",
    ].join("\n"),
    events: [
      {
        summary: "Shape the embedded architect sections.",
        timestamp: "2026-04-16T02:00:00.400Z",
        type: "architect-plan-created",
      },
      {
        requiredCheckCommand: "npm test",
        timestamp: "2026-04-16T02:00:00.500Z",
        type: "engineer-run-started",
      },
      {
        request: {
          command: "npm test",
          toolName: "command.execute",
        },
        role: "engineer",
        status: "completed",
        timestamp: "2026-04-16T02:00:02.800Z",
        toolName: "command.execute",
        type: "tool-call",
      },
    ],
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 80);
  });
}
