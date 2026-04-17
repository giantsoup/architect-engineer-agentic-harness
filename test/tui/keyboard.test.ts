import { describe, expect, it } from "vitest";

import { resolveTuiKeyboardCommand } from "../../src/tui/keyboard.js";
import { createInitialTuiState } from "../../src/tui/state.js";

describe("tui keyboard model", () => {
  const state = createInitialTuiState();

  it("maps role focus keys to deterministic dashboard actions", () => {
    expect(resolveTuiKeyboardCommand(state, { name: "tab" })).toEqual({
      action: { type: "focus.next" },
      type: "dispatch",
    });
    expect(
      resolveTuiKeyboardCommand(state, {
        full: "S-tab",
        name: "tab",
        shift: true,
      }),
    ).toEqual({
      action: { type: "focus.previous" },
      type: "dispatch",
    });
    expect(
      resolveTuiKeyboardCommand(state, {
        name: "backtab",
      }),
    ).toEqual({
      action: { type: "focus.previous" },
      type: "dispatch",
    });
  });

  it("maps help keys and drops obsolete history-navigation keys", () => {
    expect(resolveTuiKeyboardCommand(state, { name: "f" })).toEqual({
      type: "none",
    });
    expect(
      resolveTuiKeyboardCommand(state, { full: "?", sequence: "?" }),
    ).toEqual({
      action: { type: "help.toggle" },
      type: "dispatch",
    });
    expect(
      resolveTuiKeyboardCommand(state, {
        full: "S-/",
        name: "/",
        shift: true,
      }),
    ).toEqual({
      action: { type: "help.toggle" },
      type: "dispatch",
    });
    expect(resolveTuiKeyboardCommand(state, { name: "down" })).toEqual({
      type: "none",
    });
    expect(resolveTuiKeyboardCommand(state, { name: "pageup" })).toEqual({
      type: "none",
    });
    expect(resolveTuiKeyboardCommand(state, { name: "r" })).toEqual({
      type: "none",
    });
  });

  it("maps s to a run-stop command only for active live runs", () => {
    expect(
      resolveTuiKeyboardCommand(
        createInitialTuiState({
          demoMode: false,
        }),
        { name: "s" },
      ),
    ).toEqual({
      type: "stop-run",
    });
    expect(
      resolveTuiKeyboardCommand(
        createInitialTuiState({
          demoMode: true,
        }),
        { name: "s" },
      ),
    ).toEqual({
      type: "none",
    });

    const stopRequestedState = createInitialTuiState({
      demoMode: false,
    });
    stopRequestedState.runStopRequested = true;

    expect(
      resolveTuiKeyboardCommand(stopRequestedState, { name: "s" }),
    ).toEqual({
      type: "none",
    });

    const finishedRunState = createInitialTuiState({
      demoMode: false,
    });
    finishedRunState.runActive = false;

    expect(resolveTuiKeyboardCommand(finishedRunState, { name: "s" })).toEqual({
      type: "none",
    });
  });

  it("treats q and ctrl-c as TUI-local quit commands", () => {
    expect(resolveTuiKeyboardCommand(state, { name: "q" })).toEqual({
      type: "quit",
    });
    expect(
      resolveTuiKeyboardCommand(state, {
        ctrl: true,
        full: "C-c",
        name: "c",
      }),
    ).toEqual({
      type: "quit",
    });
  });

  it("drops legacy pane jump and maximize bindings", () => {
    expect(resolveTuiKeyboardCommand(state, { full: "1", name: "1" })).toEqual({
      type: "none",
    });
    expect(resolveTuiKeyboardCommand(state, { name: "x" })).toEqual({
      type: "none",
    });
    expect(resolveTuiKeyboardCommand(state, { name: "left" })).toEqual({
      type: "none",
    });
  });
});
