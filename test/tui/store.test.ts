import { describe, expect, it } from "vitest";

import { createInitialTuiState, tuiReducer } from "../../src/tui/state.js";

describe("tui store reducer", () => {
  it("cycles focus deterministically across the six panes", () => {
    let state = createInitialTuiState();

    state = tuiReducer(state, { type: "focus.next" });
    state = tuiReducer(state, { type: "focus.next" });
    state = tuiReducer(state, { type: "focus.next" });

    expect(state.focusPane).toBe("log");

    state = tuiReducer(state, { type: "focus.previous" });

    expect(state.focusPane).toBe("tasks");
  });

  it("bounds log entries and tracks dropped metadata", () => {
    let state = createInitialTuiState({
      logLimit: 2,
    });

    state = tuiReducer(state, {
      entry: {
        level: "info",
        source: "demo",
        summary: "first",
        timestamp: "2026-04-16T00:00:01.000Z",
      },
      type: "log.append",
    });
    state = tuiReducer(state, {
      entry: {
        level: "info",
        source: "demo",
        summary: "second",
        timestamp: "2026-04-16T00:00:02.000Z",
      },
      type: "log.append",
    });
    state = tuiReducer(state, {
      entry: {
        level: "warn",
        source: "demo",
        summary: "third",
        timestamp: "2026-04-16T00:00:03.000Z",
      },
      type: "log.append",
    });

    expect(state.log.entries).toHaveLength(2);
    expect(state.log.entries[0]?.summary).toBe("second");
    expect(state.log.entries[1]?.summary).toBe("third");
    expect(state.log.dropped).toBe(1);
  });

  it("routes viewport movement to queue selection when the tasks pane is focused", () => {
    let state = createInitialTuiState();

    state = tuiReducer(state, {
      pane: "tasks",
      type: "focus.set",
    });
    state = tuiReducer(state, {
      delta: 1,
      type: "view.adjust",
    });
    state = tuiReducer(state, {
      delta: 10,
      type: "view.adjust",
    });

    expect(state.queueSelection).toBe(state.queueItems.length - 1);
    expect(state.paneScroll.tasks).toBe(0);
  });

  it("toggles maximize on the focused pane and resets view state", () => {
    let state = createInitialTuiState();

    state = tuiReducer(state, { type: "maximize.toggle" });
    expect(state.maximizedPane).toBe("architect");

    state = tuiReducer(state, {
      delta: 5,
      pane: "engineer",
      type: "pane.scroll",
    });
    state = tuiReducer(state, { type: "help.toggle" });
    state = tuiReducer(state, { type: "view.reset" });

    expect(state.maximizedPane).toBeNull();
    expect(state.helpOpen).toBe(false);
    expect(state.followMode).toBe(true);
    expect(state.paneScroll.engineer).toBe(0);
  });
});
