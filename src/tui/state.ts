export const TUI_PANE_ORDER = [
  "architect",
  "engineer",
  "tasks",
  "log",
  "diff",
  "tests",
] as const;

export type TuiPaneId = (typeof TUI_PANE_ORDER)[number];

export type TuiQueueItemStatus = "active" | "blocked" | "done" | "pending";

export type TuiLogLevel = "error" | "info" | "warn";

export interface TuiQueueItem {
  detail?: string | undefined;
  id: string;
  status: TuiQueueItemStatus;
  title: string;
}

export interface TuiLogEntry {
  id: number;
  level: TuiLogLevel;
  source: string;
  summary: string;
  timestamp: string;
}

export interface TuiPaneSnapshot {
  lines: readonly string[];
  updatedAt: string;
}

export interface TuiState {
  demoMode: boolean;
  focusPane: TuiPaneId;
  followMode: boolean;
  helpOpen: boolean;
  log: {
    dropped: number;
    entries: readonly TuiLogEntry[];
    limit: number;
    nextId: number;
  };
  maximizedPane: TuiPaneId | null;
  paneScroll: Record<TuiPaneId, number>;
  panes: Record<TuiPaneId, TuiPaneSnapshot>;
  queueItems: readonly TuiQueueItem[];
  queueSelection: number;
  runLabel: string;
  statusText: string;
}

export type TuiAction =
  | { type: "focus.next" }
  | { type: "focus.previous" }
  | { pane: TuiPaneId; type: "focus.set" }
  | { type: "follow.toggle" }
  | { open?: boolean | undefined; type: "help.toggle" }
  | { pane?: TuiPaneId | undefined; type: "maximize.toggle" }
  | { items: readonly TuiQueueItem[]; type: "queue.replace" }
  | { delta: number; type: "queue.move" }
  | {
      entry: Omit<TuiLogEntry, "id">;
      type: "log.append";
    }
  | {
      entries: readonly Omit<TuiLogEntry, "id">[];
      type: "log.appendMany";
    }
  | {
      dropped?: number | undefined;
      entries: readonly Omit<TuiLogEntry, "id">[];
      type: "log.replace";
    }
  | {
      delta: number;
      pane?: TuiPaneId | undefined;
      type: "pane.scroll";
    }
  | {
      lines: readonly string[];
      pane: TuiPaneId;
      type: "pane.replace";
      updatedAt?: string | undefined;
    }
  | { text: string; type: "status.set" }
  | { delta: number; type: "view.adjust" }
  | { type: "view.reset" };

export interface CreateInitialTuiStateOptions {
  demoMode?: boolean | undefined;
  logLimit?: number | undefined;
  now?: (() => string) | undefined;
  runLabel?: string | undefined;
  task?: string | undefined;
}

export interface TuiStore {
  dispatch(action: TuiAction): TuiState;
  getState(): TuiState;
  subscribe(listener: TuiStoreListener): () => void;
}

export type TuiStoreListener = (
  state: TuiState,
  action: TuiAction,
) => void | Promise<void>;

const DEFAULT_LOG_LIMIT = 200;
const DEFAULT_RUN_LABEL = "demo-run";

export function createInitialTuiState(
  options: CreateInitialTuiStateOptions = {},
): TuiState {
  const now = options.now ?? (() => new Date().toISOString());
  const task =
    options.task ?? "Wire the TUI shell and keep runtime behavior stable.";
  const timestamp = now();
  const demoMode = options.demoMode ?? true;

  return {
    demoMode,
    focusPane: "architect",
    followMode: true,
    helpOpen: false,
    log: {
      dropped: 0,
      entries: [],
      limit: options.logLimit ?? DEFAULT_LOG_LIMIT,
      nextId: 1,
    },
    maximizedPane: null,
    paneScroll: createPaneScrollState(),
    panes: {
      architect: createInitialPaneSnapshot(
        demoMode,
        "architect",
        task,
        timestamp,
      ),
      diff: createInitialPaneSnapshot(demoMode, "diff", task, timestamp),
      engineer: createInitialPaneSnapshot(
        demoMode,
        "engineer",
        task,
        timestamp,
      ),
      log: {
        lines: [],
        updatedAt: timestamp,
      },
      tasks: {
        lines: [],
        updatedAt: timestamp,
      },
      tests: createInitialPaneSnapshot(demoMode, "tests", task, timestamp),
    },
    queueItems: demoMode
      ? [
          {
            id: "plan-shell",
            status: "active",
            title: "Scaffold neo-blessed shell",
          },
          {
            id: "store-layout",
            status: "pending",
            title: "Implement reducer, layout, and keyboard model",
          },
          {
            id: "demo-plumbing",
            status: "pending",
            title: "Add demo feed and CLI tui path",
          },
          {
            id: "tests",
            status: "pending",
            title: "Add focused test coverage",
          },
        ]
      : [],
    queueSelection: 0,
    runLabel: options.runLabel ?? DEFAULT_RUN_LABEL,
    statusText: demoMode
      ? "Demo shell active. Runtime event wiring is intentionally deferred."
      : `Waiting for live harness activity for ${options.runLabel ?? DEFAULT_RUN_LABEL}.`,
  };
}

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "focus.next":
      return {
        ...state,
        focusPane:
          TUI_PANE_ORDER[
            (paneIndex(state.focusPane) + 1) % TUI_PANE_ORDER.length
          ]!,
      };
    case "focus.previous":
      return {
        ...state,
        focusPane:
          TUI_PANE_ORDER[
            (paneIndex(state.focusPane) + TUI_PANE_ORDER.length - 1) %
              TUI_PANE_ORDER.length
          ]!,
      };
    case "focus.set":
      return {
        ...state,
        focusPane: action.pane,
      };
    case "follow.toggle":
      return {
        ...state,
        followMode: !state.followMode,
      };
    case "help.toggle":
      return {
        ...state,
        helpOpen: action.open ?? !state.helpOpen,
      };
    case "maximize.toggle": {
      const pane = action.pane ?? state.focusPane;

      return {
        ...state,
        maximizedPane: state.maximizedPane === pane ? null : pane,
      };
    }
    case "queue.replace":
      return {
        ...state,
        queueItems: [...action.items],
        queueSelection: clampIndex(state.queueSelection, action.items.length),
        panes: withPaneUpdated(state.panes, "tasks"),
      };
    case "queue.move":
      return {
        ...state,
        queueSelection: clampIndex(
          state.queueSelection + action.delta,
          state.queueItems.length,
        ),
      };
    case "log.append": {
      return reduceLogAppend(state, [action.entry]);
    }
    case "log.appendMany":
      return reduceLogAppend(state, action.entries);
    case "log.replace": {
      const boundedEntries = boundLogEntries(action.entries, state.log.limit);
      const nextEntries = boundedEntries.entries.map((entry, index) => ({
        ...entry,
        id: index + 1,
      }));

      return {
        ...state,
        log: {
          ...state.log,
          dropped: (action.dropped ?? 0) + boundedEntries.dropped,
          entries: nextEntries,
          nextId: nextEntries.length + 1,
        },
        paneScroll: {
          ...state.paneScroll,
          log: state.followMode
            ? Math.max(0, nextEntries.length - 1)
            : state.paneScroll.log,
        },
        panes: withPaneUpdated(
          state.panes,
          "log",
          nextEntries.at(-1)?.timestamp ?? state.panes.log.updatedAt,
        ),
      };
    }
    case "pane.scroll": {
      const pane = action.pane ?? state.focusPane;
      const nextScroll = Math.max(0, state.paneScroll[pane] + action.delta);

      return {
        ...state,
        followMode:
          pane === "log" && action.delta < 0 ? false : state.followMode,
        paneScroll: {
          ...state.paneScroll,
          [pane]: nextScroll,
        },
      };
    }
    case "pane.replace":
      return {
        ...state,
        panes: {
          ...state.panes,
          [action.pane]: {
            lines: [...action.lines],
            updatedAt: action.updatedAt ?? state.panes[action.pane].updatedAt,
          },
        },
      };
    case "status.set":
      return {
        ...state,
        statusText: action.text,
      };
    case "view.adjust":
      return state.focusPane === "tasks"
        ? tuiReducer(state, { delta: action.delta, type: "queue.move" })
        : tuiReducer(state, {
            delta: action.delta,
            pane: state.focusPane,
            type: "pane.scroll",
          });
    case "view.reset":
      return {
        ...state,
        followMode: true,
        helpOpen: false,
        maximizedPane: null,
        paneScroll: createPaneScrollState(),
        queueSelection: 0,
      };
  }
}

export function createTuiStore(initialState: TuiState): TuiStore {
  let state = initialState;
  const listeners = new Set<TuiStoreListener>();

  return {
    dispatch(action) {
      state = tuiReducer(state, action);

      for (const listener of listeners) {
        listener(state, action);
      }

      return state;
    },
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function paneIndex(pane: TuiPaneId): number {
  return TUI_PANE_ORDER.indexOf(pane);
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(length - 1, index));
}

function createPaneScrollState(): Record<TuiPaneId, number> {
  return {
    architect: 0,
    diff: 0,
    engineer: 0,
    log: 0,
    tasks: 0,
    tests: 0,
  };
}

function withPaneUpdated(
  panes: TuiState["panes"],
  pane: TuiPaneId,
  updatedAt: string = new Date().toISOString(),
): TuiState["panes"] {
  return {
    ...panes,
    [pane]: {
      ...panes[pane],
      updatedAt,
    },
  };
}

function createInitialPaneSnapshot(
  demoMode: boolean,
  pane: TuiPaneId,
  task: string,
  updatedAt: string,
): TuiPaneSnapshot {
  if (!demoMode) {
    return {
      lines: createLivePlaceholderLines(pane, task),
      updatedAt,
    };
  }

  switch (pane) {
    case "architect":
      return {
        lines: [
          "Architect Summary",
          "",
          "Loop is currently driven by the local demo feed.",
          `Objective: ${task}`,
          "Decision: Keep runtime integration for a later issue.",
        ],
        updatedAt,
      };
    case "diff":
      return {
        lines: [
          "diff --git a/src/cli/commands/run.ts b/src/cli/commands/run.ts",
          "+ launch the TUI shell for --ui tui",
          "+ keep plain/live modes unchanged",
        ],
        updatedAt,
      };
    case "engineer":
      return {
        lines: [
          "Engineer Summary",
          "",
          "Synthetic events update this pane for now.",
          "Current action: scaffold UI-local store and widgets.",
        ],
        updatedAt,
      };
    case "tests":
      return {
        lines: [
          "Test Queue",
          "",
          "- store.test.ts",
          "- layout.test.ts",
          "- keyboard.test.ts",
        ],
        updatedAt,
      };
    case "tasks":
    case "log":
      return {
        lines: [],
        updatedAt,
      };
  }
}

function reduceLogAppend(
  state: TuiState,
  entries: readonly Omit<TuiLogEntry, "id">[],
): TuiState {
  if (entries.length === 0) {
    return state;
  }

  const appendedEntries = entries.map((entry, index) => ({
    ...entry,
    id: state.log.nextId + index,
  }));
  const boundedEntries = boundStoredLogEntries(
    [...state.log.entries, ...appendedEntries],
    state.log.limit,
  );

  return {
    ...state,
    log: {
      ...state.log,
      dropped: state.log.dropped + boundedEntries.dropped,
      entries: boundedEntries.entries,
      nextId: state.log.nextId + entries.length,
    },
    paneScroll: {
      ...state.paneScroll,
      log: state.followMode
        ? Math.max(0, boundedEntries.entries.length - 1)
        : state.paneScroll.log,
    },
    panes: withPaneUpdated(
      state.panes,
      "log",
      entries.at(-1)?.timestamp ?? state.panes.log.updatedAt,
    ),
  };
}

function boundLogEntries(
  entries: readonly Omit<TuiLogEntry, "id">[],
  limit: number,
): { dropped: number; entries: readonly Omit<TuiLogEntry, "id">[] } {
  const overflow = Math.max(0, entries.length - limit);

  return {
    dropped: overflow,
    entries: overflow === 0 ? entries : entries.slice(overflow),
  };
}

function boundStoredLogEntries(
  entries: readonly TuiLogEntry[],
  limit: number,
): { dropped: number; entries: readonly TuiLogEntry[] } {
  const overflow = Math.max(0, entries.length - limit);

  return {
    dropped: overflow,
    entries: overflow === 0 ? entries : entries.slice(overflow),
  };
}

function createLivePlaceholderLines(
  pane: TuiPaneId,
  task: string,
): readonly string[] {
  switch (pane) {
    case "architect":
      return [
        "Architect Summary",
        "",
        `Objective: ${task}`,
        "Waiting for live architect activity.",
      ];
    case "engineer":
      return [
        "Engineer Summary",
        "",
        `Task: ${task}`,
        "Waiting for live engineer activity.",
      ];
    case "diff":
      return ["Waiting for diff.patch to be written."];
    case "tests":
      return ["Waiting for test or check activity."];
    case "tasks":
    case "log":
      return [];
  }
}
