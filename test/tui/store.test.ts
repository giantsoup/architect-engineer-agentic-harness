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

  it("replaces the compact projection in one reducer step", () => {
    let state = createInitialTuiState();

    state = tuiReducer(state, {
      activeRole: "engineer",
      cards: {
        architect: {
          lines: [
            "Task      Plan the run.",
            "State     handoff / waiting",
            "Latest    Engineer is active.",
            "Decision  Keep the shell compact.",
          ],
        },
        engineer: {
          lines: [
            "Task      Run npm test.",
            "State     running",
            "Tool      npm test",
            "Result    Running from .",
          ],
        },
      },
      phaseText: "Execution",
      statusText: "Execution | engineer | Running required check: npm test",
      type: "projection.replace",
      updatedAt: "2026-04-16T00:00:10.000Z",
    });

    expect(state.activeRole).toBe("engineer");
    expect(state.phaseText).toBe("Execution");
    expect(state.cards.engineer.lines[2]).toContain("npm test");
    expect(state.cards.architect.updatedAt).toBe("2026-04-16T00:00:10.000Z");
  });

  it("toggles help without resetting unrelated shell state", () => {
    let state = createInitialTuiState();

    state = tuiReducer(state, { type: "help.toggle" });
    expect(state.helpOpen).toBe(true);

    state = tuiReducer(state, { type: "help.toggle" });
    expect(state.helpOpen).toBe(false);
    expect(state.focusRole).toBe("architect");
  });
});
