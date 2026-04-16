import type { RunDossierPaths } from "../artifacts/paths.js";
import type { HarnessEventBus } from "../runtime/harness-events.js";
import {
  readRunInspection,
  type RunInspection,
} from "../runtime/run-history.js";
import type { TuiLogEntry, TuiQueueItem, TuiStore } from "./state.js";
import {
  createTuiArtifactReader,
  type TuiArtifactSnapshot,
} from "./artifact-reader.js";
import { createTuiEventBridge } from "./event-bridge.js";
import {
  applyHarnessEventToOverlay,
  buildHydratedLogEntries,
  buildTuiProjection,
  createEmptyTuiLiveOverlay,
} from "./reconcile.js";

export interface TuiLiveDataSource {
  forceRefresh(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export interface CreateTuiLiveDataSourceOptions {
  artifactReader?: ReturnType<typeof createTuiArtifactReader> | undefined;
  eventBus: HarnessEventBus;
  inspectionReader?: typeof readRunInspection;
  now?: () => Date;
  paths: RunDossierPaths;
  pollIntervalMs?: number | undefined;
  store: TuiStore;
  task?: string | undefined;
}

type ReconcileMode = "force" | "hydrate" | "interval";

const EMPTY_ARTIFACT_SNAPSHOT: TuiArtifactSnapshot = {
  architectPlan: "",
  architectReview: "",
  checks: undefined,
  commandLog: [],
  diff: "",
  engineerTask: "",
  events: [],
};

export function createTuiLiveDataSource(
  options: CreateTuiLiveDataSourceOptions,
): TuiLiveDataSource {
  const artifactReader =
    options.artifactReader ??
    createTuiArtifactReader({
      paths: options.paths,
    });
  const inspectionReader = options.inspectionReader ?? readRunInspection;
  const now = options.now ?? (() => new Date());
  const overlay = createEmptyTuiLiveOverlay();
  const bridge = createTuiEventBridge({
    eventBus: options.eventBus,
    onBatch(events) {
      try {
        let shouldReconcile = false;
        const appendLogEntries: Omit<TuiLogEntry, "id">[] = [];

        for (const event of events) {
          if (!shouldIncludeEvent(options.paths.runId, event)) {
            continue;
          }

          const result = applyHarnessEventToOverlay(overlay, event);

          appendLogEntries.push(...result.appendLogEntries);

          shouldReconcile = shouldReconcile || result.requestReconcile;
        }

        if (appendLogEntries.length > 0) {
          options.store.dispatch({
            entries: appendLogEntries,
            type: "log.appendMany",
          });
        }

        syncProjection();

        if (shouldReconcile) {
          requestReconcile("interval");
        }
      } catch (error) {
        reportLiveDataError("processing live event updates", error);
      }
    },
  });
  let artifacts = EMPTY_ARTIFACT_SNAPSHOT;
  let inspection: RunInspection | undefined;
  let started = false;
  let stopped = false;
  let interval: NodeJS.Timeout | undefined;
  let reconcileInFlight = false;
  let queuedMode: ReconcileMode | undefined;

  const syncProjection = () => {
    const projection = buildTuiProjection({
      artifacts,
      inspection,
      overlay,
      task: options.task,
    });
    const state = options.store.getState();
    const updatedAt = now().toISOString();

    if (
      !sameLines(state.sections.currentGoal.lines, projection.currentGoalLines)
    ) {
      options.store.dispatch({
        lines: projection.currentGoalLines,
        section: "currentGoal",
        type: "section.replace",
        updatedAt,
      });
    }

    if (
      !sameLines(
        state.sections.reasoningHistory.lines,
        projection.reasoningHistoryLines,
      )
    ) {
      options.store.dispatch({
        lines: projection.reasoningHistoryLines,
        section: "reasoningHistory",
        type: "section.replace",
        updatedAt,
      });
    }

    if (!sameQueue(state.queueItems, projection.queueItems)) {
      options.store.dispatch({
        items: projection.queueItems,
        type: "queue.replace",
      });
    }

    if (
      !sameLines(
        state.sections.executionLog.lines,
        projection.executionLogLines,
      )
    ) {
      options.store.dispatch({
        lines: projection.executionLogLines,
        section: "executionLog",
        type: "section.replace",
        updatedAt,
      });
    }

    if (
      !sameLines(
        state.sections.activeCommand.lines,
        projection.activeCommandLines,
      )
    ) {
      options.store.dispatch({
        lines: projection.activeCommandLines,
        section: "activeCommand",
        type: "section.replace",
        updatedAt,
      });
    }

    if (
      !sameLines(state.sections.testsChecks.lines, projection.testsChecksLines)
    ) {
      options.store.dispatch({
        lines: projection.testsChecksLines,
        section: "testsChecks",
        type: "section.replace",
        updatedAt,
      });
    }

    if (state.statusText !== projection.statusText) {
      options.store.dispatch({
        text: projection.statusText,
        type: "status.set",
      });
    }
  };

  const syncHydratedLog = () => {
    const state = options.store.getState();
    const nextHydratedLog = buildHydratedLogEntries({
      artifacts,
      inspection,
      overlay,
      task: options.task,
    });
    const currentEntries = state.log.entries.map((entry) => ({
      level: entry.level,
      source: entry.source,
      summary: entry.summary,
      timestamp: entry.timestamp,
    }));

    if (
      !sameLogEntries(currentEntries, nextHydratedLog.entries) ||
      state.log.dropped !== nextHydratedLog.dropped
    ) {
      options.store.dispatch({
        dropped: nextHydratedLog.dropped,
        entries: nextHydratedLog.entries,
        type: "log.replace",
      });
    }
  };

  const requestReconcile = (mode: ReconcileMode) => {
    queuedMode = prioritizeMode(queuedMode, mode);
    void runReconcileLoop();
  };

  const runReconcileLoop = async () => {
    if (stopped || reconcileInFlight || queuedMode === undefined) {
      return;
    }

    reconcileInFlight = true;

    try {
      while (queuedMode !== undefined && !stopped) {
        const mode = queuedMode;
        queuedMode = undefined;
        try {
          await performReconcile(mode);
        } catch (error) {
          reportLiveDataError(`running a ${mode} reconcile`, error);
        }
      }
    } finally {
      reconcileInFlight = false;
    }
  };

  const performReconcile = async (mode: ReconcileMode) => {
    inspection = await readInspectionSafely(
      inspectionReader,
      options.paths,
      now,
    );
    artifacts = await artifactReader.read({
      force: mode === "force" || mode === "hydrate",
    });
    syncProjection();

    if (mode !== "interval") {
      syncHydratedLog();
    }
  };

  return {
    async forceRefresh() {
      requestReconcile("force");
      await waitForReconcileLoop(
        () => reconcileInFlight || queuedMode !== undefined,
      );
    },
    start() {
      if (started || stopped) {
        return;
      }

      started = true;
      bridge.start();
      requestReconcile("hydrate");
      interval = setInterval(() => {
        requestReconcile("interval");
      }, options.pollIntervalMs ?? 800);
    },
    async stop() {
      if (stopped) {
        return;
      }

      bridge.stop();

      if (interval !== undefined) {
        clearInterval(interval);
        interval = undefined;
      }

      requestReconcile("force");
      await waitForReconcileLoop(
        () => reconcileInFlight || queuedMode !== undefined,
      );
      stopped = true;
    },
  };

  function reportLiveDataError(context: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const timestamp = now().toISOString();

    options.store.dispatch({
      entry: {
        level: "error",
        source: "runtime",
        summary: `TUI live-data error while ${context}: ${message}`,
        timestamp,
      },
      type: "log.append",
    });
    options.store.dispatch({
      text: `TUI live-data degraded: ${message}`,
      type: "status.set",
    });
  }
}

async function readInspectionSafely(
  inspectionReader: typeof readRunInspection,
  paths: RunDossierPaths,
  now: () => Date,
): Promise<RunInspection | undefined> {
  try {
    return await inspectionReader(paths, { now: now() });
  } catch {
    return undefined;
  }
}

function shouldIncludeEvent(
  runId: string,
  event: { runId?: string | undefined },
): boolean {
  return event.runId === undefined || event.runId === runId;
}

function prioritizeMode(
  current: ReconcileMode | undefined,
  incoming: ReconcileMode,
): ReconcileMode {
  const priority: Record<ReconcileMode, number> = {
    force: 3,
    hydrate: 2,
    interval: 1,
  };

  if (current === undefined) {
    return incoming;
  }

  return priority[incoming] >= priority[current] ? incoming : current;
}

async function waitForReconcileLoop(isBusy: () => boolean): Promise<void> {
  while (isBusy()) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((line, index) => line === right[index]);
}

function sameQueue(
  left: readonly TuiQueueItem[],
  right: readonly TuiQueueItem[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every(
    (item, index) =>
      item.id === right[index]?.id &&
      item.status === right[index]?.status &&
      item.title === right[index]?.title &&
      item.detail === right[index]?.detail,
  );
}

function sameLogEntries(
  left: readonly Omit<TuiLogEntry, "id">[],
  right: readonly Omit<TuiLogEntry, "id">[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every(
    (entry, index) =>
      entry.level === right[index]?.level &&
      entry.source === right[index]?.source &&
      entry.summary === right[index]?.summary &&
      entry.timestamp === right[index]?.timestamp,
  );
}
