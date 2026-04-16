import { describe, expect, it } from "vitest";

import { computeTuiLayout } from "../../src/tui/layout.js";
import type { BlessedBox } from "../../src/tui/neo-blessed.js";
import { createInitialTuiState } from "../../src/tui/state.js";
import {
  createTuiTheme,
  detectTuiTerminalCapabilities,
} from "../../src/tui/theme.js";
import { renderPaneWidget } from "../../src/tui/widgets/pane.js";
import { renderStatusBarWidget } from "../../src/tui/widgets/status-bar.js";

describe("tui accessibility fallbacks", () => {
  it("detects color-disabled and ascii-safe terminal fallbacks", () => {
    const capabilities = detectTuiTerminalCapabilities({
      env: {
        LANG: "C",
        NO_COLOR: "1",
        TERM: "vt100",
      },
      output: {
        getColorDepth() {
          return 1;
        },
        hasColors() {
          return false;
        },
        isTTY: true,
      },
      platform: "win32",
    });

    expect(capabilities).toEqual({
      colorMode: "none",
      unicode: false,
    });
  });

  it("detects 16-color unicode terminals without requiring full color", () => {
    const capabilities = detectTuiTerminalCapabilities({
      env: {
        LANG: "en_US.UTF-8",
        TERM: "xterm-16color",
      },
      output: {
        getColorDepth() {
          return 4;
        },
        hasColors() {
          return true;
        },
        isTTY: true,
      },
      platform: "linux",
    });

    expect(capabilities).toEqual({
      colorMode: "ansi16",
      unicode: true,
    });
  });

  it("switches to a compact single-pane layout on narrow terminals", () => {
    const state = createInitialTuiState();
    state.focusPane = "tests";

    const layout = computeTuiLayout({
      height: 16,
      state,
      width: 72,
    });

    expect(layout.mode).toBe("compact");
    expect(layout.panes.tests.visible).toBe(true);
    expect(layout.panes.architect.visible).toBe(false);
  });

  it("renders meaningful text labels without depending on color", () => {
    const state = createInitialTuiState({
      demoMode: false,
      runLabel: "qa-run",
    });
    state.focusPane = "tasks";
    state.queueItems = [
      {
        id: "one",
        status: "active",
        title: "Review terminal fallback behavior",
      },
      {
        id: "two",
        status: "blocked",
        title: "Confirm Windows fallback behavior",
      },
    ];
    const paneBox = createRecordingBox();
    const statusBarBox = createRecordingBox();
    const theme = createTuiTheme({
      colorMode: "none",
      unicode: false,
    });

    renderPaneWidget({
      box: paneBox,
      pane: "tasks",
      rect: { height: 8, left: 0, top: 0, width: 72 },
      state,
      theme,
    });
    renderStatusBarWidget({
      box: statusBarBox,
      rect: { height: 1, left: 0, top: 8, width: 120 },
      state,
      theme,
    });

    expect(paneBox.label).toContain("[*] [3] Tasks / Queue");
    expect(paneBox.content).toContain(
      "[ACTIVE] Review terminal fallback behavior",
    );
    expect(paneBox.content).toContain(
      "[BLOCKED] Confirm Windows fallback behavior",
    );
    expect(statusBarBox.content).toContain("theme:mono/ascii");
    expect(statusBarBox.content).toContain("focus:Tasks / Queue");
  });
});

function createRecordingBox(): BlessedBox & { content: string; label: string } {
  return {
    content: "",
    height: 0,
    hide() {},
    label: "",
    left: 0,
    setContent(content: string) {
      this.content = content;
    },
    setLabel(label: string) {
      this.label = label;
    },
    show() {},
    top: 0,
    width: 0,
  };
}
