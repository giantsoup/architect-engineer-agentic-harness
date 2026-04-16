import { describe, expect, it } from "vitest";

import { computeTuiLayout } from "../../src/tui/layout.js";
import { createInitialTuiState } from "../../src/tui/state.js";

describe("tui layout", () => {
  it("renders a two-role 40/60 dashboard at roughly 120x30", () => {
    const layout = computeTuiLayout({
      height: 30,
      state: createInitialTuiState(),
      width: 120,
    });

    expect(layout.mode).toBe("wide");
    expect(layout.header).toEqual({
      height: 1,
      left: 0,
      top: 0,
      width: 120,
    });
    expect(layout.roles.architect.rect).toEqual({
      height: 28,
      left: 0,
      top: 1,
      width: 48,
    });
    expect(layout.roles.engineer.rect).toEqual({
      height: 28,
      left: 48,
      top: 1,
      width: 72,
    });
    expect(layout.footer).toEqual({
      height: 1,
      left: 0,
      top: 29,
      width: 120,
    });
  });

  it("renders a narrow one-role-at-a-time switcher layout", () => {
    const state = createInitialTuiState();
    state.focusRole = "engineer";

    const layout = computeTuiLayout({
      height: 24,
      state,
      width: 72,
    });

    expect(layout.mode).toBe("narrow");
    expect(layout.roles.engineer.visible).toBe(true);
    expect(layout.roles.engineer.rect).toEqual({
      height: 22,
      left: 0,
      top: 1,
      width: 72,
    });
    expect(layout.roles.architect.visible).toBe(false);
    expect(layout.footer.width).toBe(72);
  });

  it("uses the actual terminal size in narrow mode instead of inflating small terminals", () => {
    const state = createInitialTuiState();
    state.focusRole = "engineer";

    const layout = computeTuiLayout({
      height: 7,
      state,
      width: 24,
    });

    expect(layout.mode).toBe("narrow");
    expect(layout.roles.engineer.rect.width).toBe(24);
    expect(layout.footer.width).toBe(24);
    expect(layout.helpModal.width).toBeLessThanOrEqual(24);
    expect(layout.helpModal.height).toBeLessThanOrEqual(7);
  });
});
