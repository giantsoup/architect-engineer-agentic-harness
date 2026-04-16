import type { TuiAction, TuiQueueItem, TuiStore } from "./state.js";

export interface CreateTuiDemoFeedOptions {
  intervalMs?: number | undefined;
  now?: (() => Date) | undefined;
  store: Pick<TuiStore, "dispatch">;
  task?: string | undefined;
}

export interface TuiDemoFeed {
  start(): void;
  stop(): void;
}

type DemoStep = (dispatch: (action: TuiAction) => void) => void;

export function createTuiDemoFeed(
  options: CreateTuiDemoFeedOptions,
): TuiDemoFeed {
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? 900;
  const task =
    options.task ?? "Replace the six-pane shell with a two-role dashboard.";
  let timer: NodeJS.Timeout | undefined;
  let stepIndex = 0;

  const steps: readonly DemoStep[] = [
    (dispatch) => {
      dispatch({
        lines: [
          "Architect is framing the dashboard around only two top-level surfaces.",
          "",
          `Current objective: ${task}`,
          "Wide mode should emphasize persistent Architect context alongside Engineer execution.",
        ],
        section: "currentGoal",
        type: "section.replace",
        updatedAt: now().toISOString(),
      });
      dispatch({
        lines: [
          "Phase 1 placeholder",
          "",
          "Reasoning history remains explicit even before live chronology is fully wired.",
          "The shell should never render blank sections.",
        ],
        section: "reasoningHistory",
        type: "section.replace",
        updatedAt: now().toISOString(),
      });
      dispatch({
        items: buildQueueItems("active", "pending", "pending", "pending"),
        type: "queue.replace",
      });
      dispatch({
        entry: {
          level: "info",
          source: "architect",
          summary: "Planning a role-based shell with explicit placeholders.",
          timestamp: now().toISOString(),
        },
        type: "log.append",
      });
      dispatch({
        text: "Demo feed: architect is shaping the phase-1 dashboard skeleton.",
        type: "status.set",
      });
    },
    (dispatch) => {
      dispatch({
        lines: [
          "Current command: refactor TuiState around role focus instead of pane focus",
          "Access mode: mutate",
          "Working dir: src/tui",
          "Last tool: file.write",
          "Last exit code: n/a",
          "Check status: waiting to run",
        ],
        section: "activeCommand",
        type: "section.replace",
        updatedAt: now().toISOString(),
      });
      dispatch({
        items: buildQueueItems("done", "active", "pending", "pending"),
        type: "queue.replace",
      });
      dispatch({
        entry: {
          level: "info",
          source: "engineer",
          summary:
            "Replacing the layout engine with a 40/60 two-column dashboard.",
          timestamp: now().toISOString(),
        },
        type: "log.append",
      });
      dispatch({
        text: "Demo feed: engineer is landing role panels, header, and footer hints.",
        type: "status.set",
      });
    },
    (dispatch) => {
      dispatch({
        lines: [
          "Required command: npm test -- test/tui",
          "Current command: npm test -- test/tui",
          "State: running",
          "Exit code: running",
          "Duration: running",
          "",
          "Output:",
          "  stdout | updating layout, keyboard, and app coverage",
        ],
        section: "testsChecks",
        type: "section.replace",
        updatedAt: now().toISOString(),
      });
      dispatch({
        items: buildQueueItems("done", "done", "active", "pending"),
        type: "queue.replace",
      });
      dispatch({
        entry: {
          level: "info",
          source: "demo",
          summary:
            "Narrow mode now swaps between Architect and Engineer with Tab.",
          timestamp: now().toISOString(),
        },
        type: "log.append",
      });
      dispatch({
        text: "Demo feed: narrow role switching and placeholders are active.",
        type: "status.set",
      });
    },
    (dispatch) => {
      dispatch({
        lines: [
          "Current command: npm test -- test/tui",
          "Access mode: inspect",
          "Working dir: .",
          "Last tool: command.execute",
          "Last exit code: 0",
          "Check status: passed (exit 0): npm test -- test/tui",
        ],
        section: "activeCommand",
        type: "section.replace",
        updatedAt: now().toISOString(),
      });
      dispatch({
        lines: [
          "Required command: npm test -- test/tui",
          "Current command: idle",
          "State: passed",
          "Exit code: 0",
          "Duration: 1.2s",
          "",
          "Output:",
          "  stdout | all focused TUI tests passed",
        ],
        section: "testsChecks",
        type: "section.replace",
        updatedAt: now().toISOString(),
      });
      dispatch({
        items: buildQueueItems("done", "done", "done", "active"),
        type: "queue.replace",
      });
      dispatch({
        entry: {
          level: "warn",
          source: "demo",
          summary:
            "Reasoning history and diff integration stay intentionally partial in Phase 1.",
          timestamp: now().toISOString(),
        },
        type: "log.append",
      });
      dispatch({
        text: "Demo feed: phase-1 shell complete enough for interaction; deeper live wiring is deferred.",
        type: "status.set",
      });
    },
  ];

  const runStep = () => {
    const nextStep = steps[stepIndex % steps.length]!;

    nextStep((action) => {
      options.store.dispatch(action);
    });
    stepIndex += 1;
  };

  return {
    start() {
      if (timer !== undefined) {
        return;
      }

      runStep();
      timer = setInterval(runStep, intervalMs);
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

function buildQueueItems(
  shell: TuiQueueItem["status"],
  layout: TuiQueueItem["status"],
  narrow: TuiQueueItem["status"],
  tests: TuiQueueItem["status"],
): readonly TuiQueueItem[] {
  return [
    {
      id: "shell",
      status: shell,
      title: "Replace six-pane navigation with two role surfaces",
    },
    {
      id: "layout",
      status: layout,
      title: "Ship the 40/60 dashboard layout for 120x30 terminals",
    },
    {
      id: "narrow",
      status: narrow,
      title: "Add a narrow-screen Architect/Engineer switcher",
    },
    {
      id: "tests",
      status: tests,
      title: "Update TUI tests and keep startup / teardown behavior intact",
    },
  ];
}
