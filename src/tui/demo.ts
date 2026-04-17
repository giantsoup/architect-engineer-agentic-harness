import type { TuiAction, TuiStore } from "./state.js";

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
    options.task ??
    "Polish the role-oriented dashboard for demos and keep fallbacks intact.";
  let timer: NodeJS.Timeout | undefined;
  let stepIndex = 0;

  const steps: readonly DemoStep[] = [
    (dispatch) => {
      dispatch({
        activeRole: "architect",
        cards: {
          architect: {
            lines: [
              `Task      ${task}`,
              "State     planning / active",
              "Latest    Tightening the shell around concise role cards.",
              "Decision  Keep Architect visible beside Engineer in wide mode.",
            ],
          },
          engineer: {
            lines: [
              "Task      Awaiting architect handoff.",
              "State     idle",
              "Tool      No tool or command recorded yet.",
              "Result    Waiting for the first execution step.",
            ],
          },
        },
        phaseText: "Planning",
        statusText: "Demo feed: architect is shaping the compact shell.",
        type: "projection.replace",
        updatedAt: now().toISOString(),
      });
      dispatch({
        entry: {
          level: "info",
          source: "architect",
          summary:
            "Architect framed the TUI around current task, state, and handoff clarity.",
          timestamp: now().toISOString(),
        },
        type: "log.append",
      });
    },
    (dispatch) => {
      dispatch({
        activeRole: "engineer",
        cards: {
          architect: {
            lines: [
              `Task      ${task}`,
              "State     handoff / waiting",
              "Latest    Planning is complete and execution is underway.",
              "Decision  Engineer should validate the shell with focused TUI tests.",
            ],
          },
          engineer: {
            lines: [
              "Task      Validate the compact TUI shell.",
              "State     running",
              "Tool      npm test -- test/tui/layout.test.ts test/tui/app.test.ts",
              "Result    Command running from . with mutate access.",
            ],
          },
        },
        phaseText: "Execution",
        statusText: "Demo feed: engineer is running the focused TUI checks.",
        type: "projection.replace",
        updatedAt: now().toISOString(),
      });
      dispatch({
        entry: {
          level: "info",
          source: "engineer",
          summary:
            "Engineer switched from waiting to active execution with the focused test command.",
          timestamp: now().toISOString(),
        },
        type: "log.append",
      });
    },
    (dispatch) => {
      dispatch({
        activeRole: "engineer",
        cards: {
          architect: {
            lines: [
              `Task      ${task}`,
              "State     review / waiting",
              "Latest    Monitoring the engineer pass for shell regressions.",
              "Decision  Keep the footer minimal and the help copy current-state only.",
            ],
          },
          engineer: {
            lines: [
              "Task      Validate the compact TUI shell.",
              "State     passed",
              "Tool      npm test -- test/tui/layout.test.ts test/tui/app.test.ts",
              "Result    Checks passed (exit 0) with compact layout and key handling intact.",
            ],
          },
        },
        phaseText: "Verification",
        statusText:
          "Demo feed: compact cards, minimal footer, and focused tests all hold.",
        type: "projection.replace",
        updatedAt: now().toISOString(),
      });
      dispatch({
        entry: {
          level: "info",
          source: "demo",
          summary:
            "The demo now surfaces current status only and leaves history to the dossier.",
          timestamp: now().toISOString(),
        },
        type: "log.append",
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
