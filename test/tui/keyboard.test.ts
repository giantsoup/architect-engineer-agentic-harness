import { describe, expect, it } from "vitest";

import { resolveTuiKeyboardCommand } from "../../src/tui/keyboard.js";
import { createInitialTuiState } from "../../src/tui/state.js";

describe("tui keyboard model", () => {
  const state = createInitialTuiState();

  it("maps focus keys to deterministic pane actions", () => {
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
    expect(resolveTuiKeyboardCommand(state, { full: "5", name: "5" })).toEqual({
      action: { pane: "diff", type: "focus.set" },
      type: "dispatch",
    });
  });

  it("maps navigation and toggle keys to reducer actions", () => {
    expect(resolveTuiKeyboardCommand(state, { name: "down" })).toEqual({
      action: { delta: 1, type: "view.adjust" },
      type: "dispatch",
    });
    expect(resolveTuiKeyboardCommand(state, { name: "pageup" })).toEqual({
      action: { delta: -5, type: "view.adjust" },
      type: "dispatch",
    });
    expect(resolveTuiKeyboardCommand(state, { name: "x" })).toEqual({
      action: { type: "maximize.toggle" },
      type: "dispatch",
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
});
