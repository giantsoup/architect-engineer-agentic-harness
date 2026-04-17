export const TUI_ROLE_ORDER = ["architect", "engineer"] as const;

export type TuiRoleId = (typeof TUI_ROLE_ORDER)[number];
export type TuiActiveRole = TuiRoleId | "system";

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

export interface TuiRoleCardSnapshot {
  lines: readonly string[];
  updatedAt: string;
}

export interface TuiState {
  activeRole: TuiActiveRole;
  cards: Record<TuiRoleId, TuiRoleCardSnapshot>;
  demoMode: boolean;
  focusRole: TuiRoleId;
  helpOpen: boolean;
  log: {
    dropped: number;
    entries: readonly TuiLogEntry[];
    limit: number;
    nextId: number;
  };
  phaseText: string;
  runLabel: string;
  runActive: boolean;
  runStopRequested: boolean;
  statusText: string;
}

export type TuiAction =
  | { type: "focus.next" }
  | { type: "focus.previous" }
  | { role: TuiRoleId; type: "focus.set" }
  | { open?: boolean | undefined; type: "help.toggle" }
  | { active: boolean; type: "run.activity.set" }
  | {
      activeRole: TuiActiveRole;
      cards: Record<TuiRoleId, { lines: readonly string[] }>;
      phaseText: string;
      statusText: string;
      type: "projection.replace";
      updatedAt?: string | undefined;
    }
  | { type: "run.stop.requested" }
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
  | { text: string; type: "status.set" };

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
    options.task ??
    "Polish the role-oriented dashboard and preserve terminal fallbacks.";
  const timestamp = now();
  const demoMode = options.demoMode ?? true;

  return {
    activeRole: demoMode ? "architect" : "system",
    cards: {
      architect: createInitialCardSnapshot(
        demoMode,
        "architect",
        task,
        timestamp,
      ),
      engineer: createInitialCardSnapshot(
        demoMode,
        "engineer",
        task,
        timestamp,
      ),
    },
    demoMode,
    focusRole: "architect",
    helpOpen: false,
    log: {
      dropped: 0,
      entries: [],
      limit: options.logLimit ?? DEFAULT_LOG_LIMIT,
      nextId: 1,
    },
    phaseText: demoMode ? "Demo" : "Waiting",
    runLabel: options.runLabel ?? DEFAULT_RUN_LABEL,
    runActive: !demoMode,
    runStopRequested: false,
    statusText: demoMode
      ? "Compact demo feed active."
      : `Waiting for live harness activity for ${options.runLabel ?? DEFAULT_RUN_LABEL}.`,
  };
}

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "focus.next":
      return {
        ...state,
        focusRole:
          TUI_ROLE_ORDER[
            (roleIndex(state.focusRole) + 1) % TUI_ROLE_ORDER.length
          ]!,
      };
    case "focus.previous":
      return {
        ...state,
        focusRole:
          TUI_ROLE_ORDER[
            (roleIndex(state.focusRole) + TUI_ROLE_ORDER.length - 1) %
              TUI_ROLE_ORDER.length
          ]!,
      };
    case "focus.set":
      return {
        ...state,
        focusRole: action.role,
      };
    case "help.toggle":
      return {
        ...state,
        helpOpen: action.open ?? !state.helpOpen,
      };
    case "run.activity.set":
      return {
        ...state,
        runActive: action.active,
        runStopRequested: action.active ? state.runStopRequested : false,
      };
    case "projection.replace": {
      const updatedAt = action.updatedAt ?? new Date().toISOString();

      return {
        ...state,
        activeRole: action.activeRole,
        cards: {
          architect: {
            lines: [...action.cards.architect.lines],
            updatedAt,
          },
          engineer: {
            lines: [...action.cards.engineer.lines],
            updatedAt,
          },
        },
        phaseText: action.phaseText,
        statusText: action.statusText,
      };
    }
    case "run.stop.requested":
      return {
        ...state,
        runStopRequested: true,
      };
    case "log.append":
      return reduceLogAppend(state, [action.entry]);
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
      };
    }
    case "status.set":
      return {
        ...state,
        statusText: action.text,
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

function roleIndex(role: TuiRoleId): number {
  return TUI_ROLE_ORDER.indexOf(role);
}

function createInitialCardSnapshot(
  demoMode: boolean,
  role: TuiRoleId,
  task: string,
  updatedAt: string,
): TuiRoleCardSnapshot {
  return {
    lines: demoMode
      ? createDemoCardLines(role, task)
      : createLivePlaceholderCardLines(role, task),
    updatedAt,
  };
}

function createDemoCardLines(role: TuiRoleId, task: string): readonly string[] {
  return role === "architect"
    ? [
        `Task      ${task}`,
        "State     demo / planning",
        "Latest    Keeping the shell compact and readable.",
        "Decision  Hand off a minimal execution surface to Engineer.",
      ]
    : [
        `Task      ${task}`,
        "State     demo / idle",
        "Tool      No tool running yet.",
        "Result    Waiting for the first command or check.",
      ];
}

function createLivePlaceholderCardLines(
  role: TuiRoleId,
  task: string,
): readonly string[] {
  return role === "architect"
    ? [
        `Task      ${task}`,
        "State     waiting",
        "Latest    No architect activity recorded yet.",
        "Decision  No planning or handoff summary recorded yet.",
      ]
    : [
        `Task      ${task}`,
        "State     idle",
        "Tool      No tool or command recorded yet.",
        "Result    No command or check result recorded yet.",
      ];
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
