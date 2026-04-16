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
    options.task ??
    "Polish the role-oriented dashboard for demos and keep fallbacks intact.";
  let timer: NodeJS.Timeout | undefined;
  let stepIndex = 0;

  const steps: readonly DemoStep[] = [
    (dispatch) => {
      dispatch({
        lines: [
          "Architect is tightening the shell around two primary panels.",
          "",
          `Current objective: ${task}`,
          "Wide mode should keep Architect context visible beside Engineer execution without noisy chrome.",
        ],
        section: "currentGoal",
        type: "section.replace",
        updatedAt: now().toISOString(),
      });
      dispatch({
        lines: [
          "11:59:59 Plan created: keep the dashboard centered on two role panels.",
          "",
          "12:00:00 Goal set: keep header restrained and footer context-sensitive.",
          "12:00:01 Constraint: preserve mono, ASCII, and terminal recovery behavior.",
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
          summary:
            "Architect framed the polish pass around spacing, hierarchy, and fallback safety.",
          timestamp: now().toISOString(),
        },
        type: "log.append",
      });
      dispatch({
        lines: [
          "No engineer execution recorded yet.",
          "Live commands, tool calls, and required-check activity will appear here.",
        ],
        section: "executionLog",
        type: "section.replace",
        updatedAt: now().toISOString(),
      });
      dispatch({
        text: "Demo feed: architect is shaping the polish pass and preserving fallback guarantees.",
        type: "status.set",
      });
    },
    (dispatch) => {
      dispatch({
        lines: [
          "Task: polish the role dashboard shell",
          "State: running",
          "Current command: npm test -- test/tui/layout.test.ts test/tui/app.test.ts",
          "Last command: rg --files src/tui test/tui",
          "Access mode: mutate",
          "Working dir: .",
          "Last tool: file.write",
          "Last exit code: 0",
          "Check status: waiting for npm test -- test/tui",
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
            "Engineer tightened the chrome and widened the gap between the role panels.",
          timestamp: now().toISOString(),
        },
        type: "log.append",
      });
      dispatch({
        lines: [
          "12:00:02 engineer-action-selected Tighten spacing and shell copy.",
          "12:00:03 tool-call file.write completed",
        ],
        section: "executionLog",
        type: "section.replace",
        updatedAt: now().toISOString(),
      });
      dispatch({
        text: "Demo feed: engineer is landing the shell polish and wide-layout spacing.",
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
          "  stdout | updating layout, keyboard, fallback, and reconcile coverage",
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
            "Narrow mode swaps between Architect and Engineer with Tab and keeps the footer concise.",
          timestamp: now().toISOString(),
        },
        type: "log.append",
      });
      dispatch({
        lines: [
          "12:00:02 engineer-action-selected Tighten spacing and shell copy.",
          "12:00:03 tool-call file.write completed",
          "12:00:04 command:start npm test -- test/tui",
          "12:00:05 stdout updating layout, keyboard, fallback, and reconcile coverage",
        ],
        section: "executionLog",
        type: "section.replace",
        updatedAt: now().toISOString(),
      });
      dispatch({
        text: "Demo feed: narrow role switching, explicit placeholders, and tests coverage are active.",
        type: "status.set",
      });
    },
    (dispatch) => {
      dispatch({
        lines: [
          "Task: polish the role dashboard shell",
          "State: idle",
          "Current command: idle",
          "Last command: npm test -- test/tui",
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
          "  stdout | all focused TUI and fallback tests passed",
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
          level: "info",
          source: "demo",
          summary:
            "Architect handoff, engineer-only execution history, and fallback notes all read cleanly in the polished shell.",
          timestamp: now().toISOString(),
        },
        type: "log.append",
      });
      dispatch({
        lines: [
          "12:00:02 engineer-action-selected Tighten spacing and shell copy.",
          "12:00:03 tool-call file.write completed",
          "12:00:04 command:start npm test -- test/tui",
          "12:00:06 command:end npm test -- test/tui (exit 0)",
          "12:00:06 check passed (exit 0): npm test -- test/tui",
        ],
        section: "executionLog",
        type: "section.replace",
        updatedAt: now().toISOString(),
      });
      dispatch({
        text: "Demo feed: polished dashboard contract holds across wide, narrow, and fallback scenarios.",
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
      title: "Polish the Architect and Engineer dashboard surfaces",
    },
    {
      id: "layout",
      status: layout,
      title: "Tighten spacing, hierarchy, and restrained chrome",
    },
    {
      id: "narrow",
      status: narrow,
      title: "Keep narrow-mode role switching obvious and fast",
    },
    {
      id: "tests",
      status: tests,
      title: "Refresh tests, fallbacks, and smoke notes",
    },
  ];
}
