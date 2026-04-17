import { describe, expect, it, vi } from "vitest";

import type { RunDossierPaths } from "../../src/artifacts/paths.js";
import { createHarnessEventBus } from "../../src/runtime/harness-events.js";
import type { RunInspection } from "../../src/runtime/run-history.js";
import { createTuiApp } from "../../src/tui/app.js";
import { createTuiEventBridge } from "../../src/tui/event-bridge.js";
import { createTuiLiveDataSource } from "../../src/tui/live-data.js";
import type {
  BlessedBox,
  BlessedKey,
  BlessedScreen,
} from "../../src/tui/neo-blessed.js";
import { createRenderScheduler } from "../../src/tui/render-scheduler.js";
import { createInitialTuiState, createTuiStore } from "../../src/tui/state.js";
import type {
  TuiArtifactReader,
  TuiArtifactSnapshot,
} from "../../src/tui/artifact-reader.js";

describe("tui backpressure", () => {
  it("drains bursty event queues in bounded batches", async () => {
    vi.useFakeTimers();
    const eventBus = createHarnessEventBus();
    const batchSizes: number[] = [];
    const bridge = createTuiEventBridge({
      batchDelayMs: 5,
      eventBus,
      maxBatchSize: 2,
      onBatch(events) {
        batchSizes.push(events.length);
      },
    });

    bridge.start();

    for (let index = 0; index < 5; index += 1) {
      eventBus.emit({
        runId: "qa-run",
        status: "running",
        summary: `event ${index + 1}`,
        type: "run:status",
      });
    }

    await vi.runAllTimersAsync();

    expect(batchSizes).toEqual([2, 2, 1]);

    bridge.stop();
    vi.useRealTimers();
  });

  it("coalesces redraws when many store updates arrive in one burst", async () => {
    vi.useFakeTimers();
    const keyHandlers: Array<(character: string, key: BlessedKey) => void> = [];
    const screen = createFakeScreen({
      keyHandlers,
    });
    const store = createTuiStore(createInitialTuiState({ runLabel: "qa-run" }));
    const scheduler = createRenderScheduler({
      delayMs: 10,
      render: () => {
        screen.render();
      },
    });
    const app = createTuiApp({
      demoFeed: {
        start() {},
        stop: vi.fn(),
      },
      runLabel: "qa-run",
      scheduler,
      screen,
      store,
    });

    app.start();
    expect(screen.render).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 80; index += 1) {
      store.dispatch({
        entry: {
          level: "info",
          source: "engineer",
          summary: `line ${index + 1}`,
          timestamp: `2026-04-16T04:00:${String(index).padStart(2, "0")}.000Z`,
        },
        type: "log.append",
      });
    }

    await vi.advanceTimersByTimeAsync(11);

    expect(screen.render).toHaveBeenCalledTimes(2);

    await app.stop();
    vi.useRealTimers();
  });

  it("bounds live log history and command output under bursty stdout and stderr", async () => {
    const eventBus = createHarnessEventBus({
      now: () => new Date("2026-04-16T04:30:00.000Z"),
    });
    const store = createTuiStore(
      createInitialTuiState({
        demoMode: false,
        logLimit: 20,
        runLabel: "20260416T043000.000Z-burst",
        task: "Handle bursty output without freezing.",
      }),
    );
    const artifactReader: TuiArtifactReader = {
      read: vi.fn(async () => createArtifactSnapshot()),
    };
    const liveData = createTuiLiveDataSource({
      artifactReader,
      eventBus,
      inspectionReader: vi.fn(async () => createInspection()),
      paths: createPaths(),
      pollIntervalMs: 10_000,
      store,
      task: "Handle bursty output without freezing.",
    });

    liveData.start();
    await settle();

    eventBus.emit({
      accessMode: "mutate",
      command: "npm test",
      role: "engineer",
      runId: createPaths().runId,
      timestamp: "2026-04-16T04:30:01.000Z",
      type: "command:start",
      workingDirectory: ".",
    });

    for (let index = 0; index < 160; index += 1) {
      eventBus.emit({
        chunk: `stdout line ${index + 1}\n`,
        command: "npm test",
        role: "engineer",
        runId: createPaths().runId,
        timestamp: `2026-04-16T04:30:01.${String(index).padStart(3, "0")}Z`,
        type: index % 2 === 0 ? "command:stdout" : "command:stderr",
      });
    }

    await settle();

    expect(store.getState().log.entries).toHaveLength(20);
    expect(store.getState().log.dropped).toBeGreaterThan(0);
    expect(
      store
        .getState()
        .cards.engineer.lines.some(
          (line: string) =>
            line.includes("Running") || line.includes("stdout line"),
        ),
    ).toBe(true);

    await liveData.stop();
  });
});

function createFakeScreen(options: {
  keyHandlers: Array<(character: string, key: BlessedKey) => void>;
}): BlessedScreen {
  return {
    destroy: vi.fn(),
    height: 32,
    key(_keys, handler) {
      options.keyHandlers.push(handler);
    },
    on() {},
    render: vi.fn(),
    width: 120,
  };
}

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
    runDirRelativePath: ".agent-harness/runs/20260416T043000.000Z-burst",
    runId: "20260416T043000.000Z-burst",
  } as unknown as RunDossierPaths;
}

function createInspection(): RunInspection {
  return {
    activeRole: "engineer",
    artifacts: {} as never,
    commandStatus: "Running required check: npm test",
    createdAt: "2026-04-16T04:30:00.000Z",
    currentObjective: "Run the required check",
    elapsedMs: 1_000,
    latestDecision: "Keep the UI responsive.",
    manifest: {} as never,
    phase: "Execution",
    primaryArtifacts: [],
    runDirAbsolutePath:
      "/tmp/project/.agent-harness/runs/20260416T043000.000Z-burst",
    runDirRelativePath: ".agent-harness/runs/20260416T043000.000Z-burst",
    runId: "20260416T043000.000Z-burst",
    status: "running",
    summary: "Engineer execution in progress.",
    task: "Handle bursty output without freezing.",
    updatedAt: "2026-04-16T04:30:01.000Z",
  } as unknown as RunInspection;
}

function createArtifactSnapshot(): TuiArtifactSnapshot {
  return {
    architectPlan: "",
    architectReview: "",
    checks: undefined,
    commandLog: [],
    diff: "",
    engineerTask:
      "# Engineer Task Brief\n\n## Execution Order\n\n1. Run `npm test`.\n",
    events: [
      {
        requiredCheckCommand: "npm test",
        timestamp: "2026-04-16T04:30:00.500Z",
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

vi.mock("../../src/tui/neo-blessed.js", () => ({
  createBlessedBox: vi.fn(() => createFakeBox()),
  createBlessedScreen: vi.fn(),
}));

function createFakeBox(): BlessedBox {
  return {
    height: 0,
    hide() {},
    left: 0,
    setContent() {},
    setLabel() {},
    show() {},
    top: 0,
    width: 0,
  };
}
