export const TUI_ROLE_ORDER = ["architect", "engineer"] as const;

export type TuiRoleId = (typeof TUI_ROLE_ORDER)[number];

export const TUI_SECTION_ORDER = [
  "currentGoal",
  "reasoningHistory",
  "taskQueue",
  "executionLog",
  "activeCommand",
  "testsChecks",
] as const;

export type TuiSectionId = (typeof TUI_SECTION_ORDER)[number];

export const TUI_ROLE_SECTIONS: Record<TuiRoleId, readonly TuiSectionId[]> = {
  architect: ["currentGoal", "reasoningHistory", "taskQueue"],
  engineer: ["executionLog", "activeCommand", "testsChecks"],
};

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

export interface TuiSectionSnapshot {
  lines: readonly string[];
  updatedAt: string;
}

export interface TuiState {
  demoMode: boolean;
  focusRole: TuiRoleId;
  followMode: boolean;
  helpOpen: boolean;
  log: {
    dropped: number;
    entries: readonly TuiLogEntry[];
    limit: number;
    nextId: number;
  };
  queueItems: readonly TuiQueueItem[];
  roleScroll: Record<TuiRoleId, number>;
  runLabel: string;
  runActive: boolean;
  runStopRequested: boolean;
  sections: Record<TuiSectionId, TuiSectionSnapshot>;
  statusText: string;
}

export type TuiAction =
  | { type: "focus.next" }
  | { type: "focus.previous" }
  | { role: TuiRoleId; type: "focus.set" }
  | { type: "follow.toggle" }
  | { open?: boolean | undefined; type: "help.toggle" }
  | { active: boolean; type: "run.activity.set" }
  | { type: "run.stop.requested" }
  | { items: readonly TuiQueueItem[]; type: "queue.replace" }
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
      role?: TuiRoleId | undefined;
      type: "role.scroll";
    }
  | {
      lines: readonly string[];
      section: TuiSectionId;
      type: "section.replace";
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
    options.task ??
    "Polish the role-oriented dashboard and preserve terminal fallbacks.";
  const timestamp = now();
  const demoMode = options.demoMode ?? true;

  return {
    demoMode,
    focusRole: "architect",
    followMode: true,
    helpOpen: false,
    log: {
      dropped: 0,
      entries: [],
      limit: options.logLimit ?? DEFAULT_LOG_LIMIT,
      nextId: 1,
    },
    queueItems: demoMode
      ? [
          {
            id: "dashboard-polish",
            status: "active",
            title: "Polish the Architect and Engineer dashboard surfaces",
          },
          {
            id: "chrome",
            status: "pending",
            title: "Tighten spacing, hierarchy, and restrained chrome",
          },
          {
            id: "narrow-switching",
            status: "pending",
            title: "Keep narrow-mode role switching obvious and fast",
          },
          {
            id: "coverage",
            status: "pending",
            title: "Refresh tests, fallbacks, and smoke notes",
          },
        ]
      : [],
    roleScroll: createRoleScrollState(),
    runLabel: options.runLabel ?? DEFAULT_RUN_LABEL,
    runActive: !demoMode,
    runStopRequested: false,
    sections: {
      currentGoal: createInitialSectionSnapshot(
        demoMode,
        "currentGoal",
        task,
        timestamp,
      ),
      reasoningHistory: createInitialSectionSnapshot(
        demoMode,
        "reasoningHistory",
        task,
        timestamp,
      ),
      taskQueue: createInitialSectionSnapshot(
        demoMode,
        "taskQueue",
        task,
        timestamp,
      ),
      executionLog: createInitialSectionSnapshot(
        demoMode,
        "executionLog",
        task,
        timestamp,
      ),
      activeCommand: createInitialSectionSnapshot(
        demoMode,
        "activeCommand",
        task,
        timestamp,
      ),
      testsChecks: createInitialSectionSnapshot(
        demoMode,
        "testsChecks",
        task,
        timestamp,
      ),
    },
    statusText: demoMode
      ? "Dashboard demo feed active. Architect context and Engineer execution stay readable without heavy chrome."
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
    case "run.activity.set":
      return {
        ...state,
        runActive: action.active,
        runStopRequested: action.active ? state.runStopRequested : false,
      };
    case "run.stop.requested":
      return {
        ...state,
        runStopRequested: true,
      };
    case "queue.replace":
      return {
        ...state,
        queueItems: [...action.items],
        sections: withSectionUpdated(state.sections, "taskQueue"),
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
        sections: withSectionUpdated(
          state.sections,
          "executionLog",
          nextEntries.at(-1)?.timestamp ??
            state.sections.executionLog.updatedAt,
        ),
      };
    }
    case "role.scroll": {
      const role = action.role ?? state.focusRole;
      const nextScroll = Math.max(0, state.roleScroll[role] + action.delta);

      return {
        ...state,
        followMode:
          role === "engineer" && action.delta < 0 ? false : state.followMode,
        roleScroll: {
          ...state.roleScroll,
          [role]: nextScroll,
        },
      };
    }
    case "section.replace":
      return {
        ...state,
        sections: {
          ...state.sections,
          [action.section]: {
            lines: [...action.lines],
            updatedAt:
              action.updatedAt ?? state.sections[action.section].updatedAt,
          },
        },
      };
    case "status.set":
      return {
        ...state,
        statusText: action.text,
      };
    case "view.adjust":
      return tuiReducer(state, {
        delta: action.delta,
        role: state.focusRole,
        type: "role.scroll",
      });
    case "view.reset":
      return {
        ...state,
        followMode: true,
        helpOpen: false,
        roleScroll: createRoleScrollState(),
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

function createRoleScrollState(): Record<TuiRoleId, number> {
  return {
    architect: 0,
    engineer: 0,
  };
}

function withSectionUpdated(
  sections: TuiState["sections"],
  section: TuiSectionId,
  updatedAt: string = new Date().toISOString(),
): TuiState["sections"] {
  return {
    ...sections,
    [section]: {
      ...sections[section],
      updatedAt,
    },
  };
}

function createInitialSectionSnapshot(
  demoMode: boolean,
  section: TuiSectionId,
  task: string,
  updatedAt: string,
): TuiSectionSnapshot {
  if (!demoMode) {
    return {
      lines: createLivePlaceholderLines(section, task),
      updatedAt,
    };
  }

  switch (section) {
    case "currentGoal":
      return {
        lines: [
          "Demo objective",
          "",
          `Center the dashboard on: ${task}`,
          "Keep the main panels prominent while startup, teardown, and terminal fallbacks remain safe.",
        ],
        updatedAt,
      };
    case "reasoningHistory":
      return {
        lines: [
          "Architect timeline",
          "",
          "Observable planning, review, and handoff milestones appear here.",
          "The TUI stays observational and does not expose hidden chain of thought.",
        ],
        updatedAt,
      };
    case "taskQueue":
      return {
        lines: [
          "Execution order",
          "",
          "Queue entries are synthesized from the engineer brief or live execution order.",
        ],
        updatedAt,
      };
    case "executionLog":
      return {
        lines: [
          "Engineer log",
          "",
          "Engineer commands, tool calls, and required checks appear here.",
        ],
        updatedAt,
      };
    case "activeCommand":
      return {
        lines: [
          "Engineer activity",
          "",
          "Show current command, working directory, tool activity, and check state.",
        ],
        updatedAt,
      };
    case "testsChecks":
      return {
        lines: [
          "Checks overview",
          "",
          "Tests / Checks will show explicit command state and captured output.",
        ],
        updatedAt,
      };
  }
}

function createLivePlaceholderLines(
  section: TuiSectionId,
  task: string,
): readonly string[] {
  switch (section) {
    case "currentGoal":
      return [
        "Waiting for architect planning or handoff state.",
        `Requested task: ${task}`,
      ];
    case "reasoningHistory":
      return [
        "No architect reasoning recorded yet.",
        "Observable planning, review, and handoff milestones will appear here.",
      ];
    case "taskQueue":
      return [
        "Awaiting an engineer brief or live execution order.",
        "The queue stays explicit instead of rendering as empty space.",
      ];
    case "executionLog":
      return [
        "No engineer execution recorded yet.",
        "Engineer commands, tool calls, and check activity will appear here.",
      ];
    case "activeCommand":
      return [
        "Waiting for engineer activity.",
        "Active command details will appear here when the run starts.",
      ];
    case "testsChecks":
      return [
        "No required check output recorded yet.",
        "Required check status and output will appear here.",
      ];
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
    sections: withSectionUpdated(
      state.sections,
      "executionLog",
      entries.at(-1)?.timestamp ?? state.sections.executionLog.updatedAt,
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
