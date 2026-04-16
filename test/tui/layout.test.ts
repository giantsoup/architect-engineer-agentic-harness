import { describe, expect, it } from "vitest";

import { computeTuiLayout } from "../../src/tui/layout.js";
import { createInitialTuiState } from "../../src/tui/state.js";

describe("tui layout", () => {
  it("renders a non-overlapping six-pane grid at roughly 120 columns", () => {
    const layout = computeTuiLayout({
      height: 36,
      state: createInitialTuiState(),
      width: 120,
    });

    expect(layout.mode).toBe("wide");
    expect(layout.panes.architect.rect).toEqual({
      height: 12,
      left: 0,
      top: 0,
      width: 60,
    });
    expect(layout.panes.engineer.rect).toEqual({
      height: 12,
      left: 60,
      top: 0,
      width: 60,
    });
    expect(layout.panes.diff.rect.top).toBe(24);
    expect(layout.panes.tests.rect.left).toBe(60);
    expect(layout.statusBar.top).toBe(35);
  });

  it("degrades to a stacked layout on narrower terminals", () => {
    const layout = computeTuiLayout({
      height: 24,
      state: createInitialTuiState(),
      width: 96,
    });

    expect(layout.mode).toBe("stacked");
    expect(layout.panes.architect.rect.width).toBe(96);
    expect(layout.panes.engineer.rect.top).toBeGreaterThan(
      layout.panes.architect.rect.top,
    );
    expect(layout.panes.tests.rect.top).toBeGreaterThan(
      layout.panes.diff.rect.top,
    );
  });

  it("shows only the maximized pane when maximize is active", () => {
    const state = createInitialTuiState();
    state.maximizedPane = "log";

    const layout = computeTuiLayout({
      height: 30,
      state,
      width: 140,
    });

    expect(layout.mode).toBe("maximized");
    expect(layout.panes.log.visible).toBe(true);
    expect(layout.panes.log.rect).toEqual({
      height: 29,
      left: 0,
      top: 0,
      width: 140,
    });
    expect(layout.panes.architect.visible).toBe(false);
  });

  it("uses the actual terminal size in compact mode instead of inflating narrow terminals", () => {
    const state = createInitialTuiState();
    state.focusPane = "engineer";

    const layout = computeTuiLayout({
      height: 7,
      state,
      width: 24,
    });

    expect(layout.mode).toBe("compact");
    expect(layout.panes.engineer.rect.width).toBe(24);
    expect(layout.statusBar.width).toBe(24);
    expect(layout.helpModal.width).toBeLessThanOrEqual(24);
    expect(layout.helpModal.height).toBeLessThanOrEqual(7);
  });
});
