import { describe, expect, it } from "vitest";

import { createInitialTuiState, tuiReducer } from "../../src/tui/state.js";

describe("tui store reducer", () => {
  it("cycles focus deterministically across the two dashboard roles", () => {
    let state = createInitialTuiState();

    state = tuiReducer(state, { type: "focus.next" });
    expect(state.focusRole).toBe("engineer");

    state = tuiReducer(state, { type: "focus.next" });
    expect(state.focusRole).toBe("architect");

    state = tuiReducer(state, { type: "focus.previous" });
    expect(state.focusRole).toBe("engineer");
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

  it("routes viewport movement to the focused role scroll state", () => {
    let state = createInitialTuiState();

    state = tuiReducer(state, {
      role: "engineer",
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

    expect(state.roleScroll.engineer).toBe(11);
    expect(state.roleScroll.architect).toBe(0);
  });

  it("turns off engineer follow mode when scrolling upward and resets view state", () => {
    let state = createInitialTuiState();

    state = tuiReducer(state, {
      delta: -1,
      role: "engineer",
      type: "role.scroll",
    });
    expect(state.followMode).toBe(false);

    state = tuiReducer(state, { type: "help.toggle" });
    state = tuiReducer(state, {
      delta: 5,
      role: "architect",
      type: "role.scroll",
    });
    state = tuiReducer(state, { type: "view.reset" });

    expect(state.helpOpen).toBe(false);
    expect(state.followMode).toBe(true);
    expect(state.roleScroll.architect).toBe(0);
    expect(state.roleScroll.engineer).toBe(0);
  });
});
