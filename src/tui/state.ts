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

  return {
    demoMode: options.demoMode ?? true,
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
      architect: {
        lines: [
          "Architect Summary",
          "",
          "Loop is currently driven by the local demo feed.",
          `Objective: ${task}`,
          "Decision: Keep runtime integration for a later issue.",
        ],
        updatedAt: timestamp,
      },
      diff: {
        lines: [
          "diff --git a/src/cli/commands/run.ts b/src/cli/commands/run.ts",
          "+ launch the TUI shell for --ui tui",
          "+ keep plain/live modes unchanged",
        ],
        updatedAt: timestamp,
      },
      engineer: {
        lines: [
          "Engineer Summary",
          "",
          "Synthetic events update this pane for now.",
          "Current action: scaffold UI-local store and widgets.",
        ],
        updatedAt: timestamp,
      },
      log: {
        lines: [],
        updatedAt: timestamp,
      },
      tasks: {
        lines: [],
        updatedAt: timestamp,
      },
      tests: {
        lines: [
          "Test Queue",
          "",
          "- store.test.ts",
          "- layout.test.ts",
          "- keyboard.test.ts",
        ],
        updatedAt: timestamp,
      },
    },
    queueItems: [
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
    ],
    queueSelection: 0,
    runLabel: options.runLabel ?? DEFAULT_RUN_LABEL,
    statusText:
      "Demo shell active. Runtime event wiring is intentionally deferred.",
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
      const appendedEntry: TuiLogEntry = {
        ...action.entry,
        id: state.log.nextId,
      };
      const entries = [...state.log.entries, appendedEntry];
      const overflow = Math.max(0, entries.length - state.log.limit);
      const nextEntries = overflow === 0 ? entries : entries.slice(overflow);

      return {
        ...state,
        log: {
          ...state.log,
          dropped: state.log.dropped + overflow,
          entries: nextEntries,
          nextId: state.log.nextId + 1,
        },
        paneScroll: {
          ...state.paneScroll,
          log: state.followMode
            ? Math.max(0, nextEntries.length - 1)
            : state.paneScroll.log,
        },
        panes: withPaneUpdated(state.panes, "log", action.entry.timestamp),
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
