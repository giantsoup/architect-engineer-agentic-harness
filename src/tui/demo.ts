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
  const task = options.task ?? "Build the neo-blessed TUI shell.";
  let timer: NodeJS.Timeout | undefined;
  let stepIndex = 0;

  const steps: readonly DemoStep[] = [
    (dispatch) => {
      dispatch({
        lines: [
          "Architect Summary",
          "",
          `Objective: ${task}`,
          "Decision: Keep the first phase UI-local.",
          "Plan: ship shell, reducer, layout, and demo feed before runtime wiring.",
        ],
        pane: "architect",
        type: "pane.replace",
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
          summary: "Planning the UI-local shell around a pure reducer.",
          timestamp: now().toISOString(),
        },
        type: "log.append",
      });
      dispatch({
        text: "Demo feed: architect planning shell layout and state.",
        type: "status.set",
      });
    },
    (dispatch) => {
      dispatch({
        lines: [
          "Engineer Summary",
          "",
          "Current action: add state, keyboard, layout, and widget modules.",
          "Guardrail: no runtime rewrites and no dossier changes.",
        ],
        pane: "engineer",
        type: "pane.replace",
        updatedAt: now().toISOString(),
      });
      dispatch({
        lines: [
          "diff --git a/src/tui/state.ts b/src/tui/state.ts",
          "+ introduce pure reducer-driven TuiState store",
          "+ clamp queue selection and bounded log metadata",
        ],
        pane: "diff",
        type: "pane.replace",
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
          summary: "Reducer and layout modules are now the active workstream.",
          timestamp: now().toISOString(),
        },
        type: "log.append",
      });
      dispatch({
        text: "Demo feed: engineer updating reducer and layout modules.",
        type: "status.set",
      });
    },
    (dispatch) => {
      dispatch({
        lines: [
          "Tasks / Queue",
          "",
          "Synthetic selection moves here via arrows and PgUp/PgDn.",
          "Future runtime event wiring will replace this demo data source.",
        ],
        pane: "tasks",
        type: "pane.replace",
        updatedAt: now().toISOString(),
      });
      dispatch({
        lines: [
          "Targeted tests",
          "",
          "PASS  test/tui/store.test.ts",
          "PASS  test/tui/layout.test.ts",
          "PASS  test/tui/keyboard.test.ts",
        ],
        pane: "tests",
        type: "pane.replace",
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
          summary: "CLI plumbing and demo feed are driving the shell.",
          timestamp: now().toISOString(),
        },
        type: "log.append",
      });
      dispatch({
        text: "Demo feed: CLI plumbing active; runtime integration remains deferred.",
        type: "status.set",
      });
    },
    (dispatch) => {
      dispatch({
        lines: [
          "Architect Review",
          "",
          "Focus visibility uses labels and borders, not color alone.",
          "Render scheduling coalesces bursts before drawing the screen.",
        ],
        pane: "architect",
        type: "pane.replace",
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
            "Shell is in demo mode until a later runtime-integration issue lands.",
          timestamp: now().toISOString(),
        },
        type: "log.append",
      });
      dispatch({
        text: "Demo feed: shell complete enough for interaction; live wiring deferred.",
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
  store: TuiQueueItem["status"],
  demo: TuiQueueItem["status"],
  tests: TuiQueueItem["status"],
): readonly TuiQueueItem[] {
  return [
    {
      id: "shell",
      status: shell,
      title: "Scaffold the neo-blessed shell",
    },
    {
      id: "store",
      status: store,
      title: "Implement the pure TuiState store and keyboard model",
    },
    {
      id: "demo",
      status: demo,
      title: "Hook the demo feed into the new app shell",
    },
    {
      id: "tests",
      status: tests,
      title: "Add focused TUI tests and CLI plumbing coverage",
    },
  ];
}
