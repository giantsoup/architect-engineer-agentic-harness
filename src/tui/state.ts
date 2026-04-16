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
  sections: Record<TuiSectionId, TuiSectionSnapshot>;
  statusText: string;
}

export type TuiAction =
  | { type: "focus.next" }
  | { type: "focus.previous" }
  | { role: TuiRoleId; type: "focus.set" }
  | { type: "follow.toggle" }
  | { open?: boolean | undefined; type: "help.toggle" }
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
    "Replace the six-pane shell with a role-oriented dashboard skeleton.";
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
            id: "architect-current-goal",
            status: "active",
            title: "Replace six-pane navigation with two role surfaces",
          },
          {
            id: "layout",
            status: "pending",
            title: "Ship a 40/60 wide dashboard for 120x30 terminals",
          },
          {
            id: "narrow",
            status: "pending",
            title: "Add a narrow Architect/Engineer role switcher",
          },
          {
            id: "tests",
            status: "pending",
            title: "Update TUI tests to the phase-1 shell contract",
          },
        ]
      : [],
    roleScroll: createRoleScrollState(),
    runLabel: options.runLabel ?? DEFAULT_RUN_LABEL,
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
      ? "Phase 1 dashboard skeleton active. Runtime section wiring remains intentionally partial."
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
          "Phase 1 goal",
          "",
          `Replace the six-pane shell with a dashboard centered on: ${task}`,
          "Keep startup, teardown, and terminal capability fallback behavior intact.",
        ],
        updatedAt,
      };
    case "reasoningHistory":
      return {
        lines: [
          "Placeholder",
          "",
          "Architect reasoning history stays explicit in Phase 1.",
          "Live reasoning chronology will be wired in a later issue.",
        ],
        updatedAt,
      };
    case "taskQueue":
      return {
        lines: [
          "Placeholder",
          "",
          "Task queue content is synthesized from queue items.",
        ],
        updatedAt,
      };
    case "executionLog":
      return {
        lines: [
          "Placeholder",
          "",
          "Execution log content is synthesized from the bounded log buffer.",
        ],
        updatedAt,
      };
    case "activeCommand":
      return {
        lines: [
          "Phase 1 engineer focus",
          "",
          "Show current command, working directory, tool activity, and check state.",
        ],
        updatedAt,
      };
    case "testsChecks":
      return {
        lines: [
          "Placeholder",
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
      return ["Waiting for architect state.", `Requested task: ${task}`];
    case "reasoningHistory":
      return [
        "Reasoning history placeholder.",
        "Detailed architect chronology is not wired into Phase 1 yet.",
      ];
    case "taskQueue":
      return [
        "Task queue placeholder.",
        "Execution-order wiring will populate this section when available.",
      ];
    case "executionLog":
      return [
        "Execution log placeholder.",
        "Live command and runtime log lines will appear here.",
      ];
    case "activeCommand":
      return [
        "Waiting for engineer execution state.",
        "Active command details will appear here when the run starts.",
      ];
    case "testsChecks":
      return [
        "Tests / Checks placeholder.",
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
