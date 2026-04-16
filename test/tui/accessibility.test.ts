import { describe, expect, it } from "vitest";

import { computeTuiLayout } from "../../src/tui/layout.js";
import type { BlessedBox } from "../../src/tui/neo-blessed.js";
import { createInitialTuiState } from "../../src/tui/state.js";
import {
  createTuiTheme,
  detectTuiTerminalCapabilities,
} from "../../src/tui/theme.js";
import { renderHeaderWidget } from "../../src/tui/widgets/header.js";
import { renderHelpModalWidget } from "../../src/tui/widgets/help-modal.js";
import { renderRolePanelWidget } from "../../src/tui/widgets/role-panel.js";
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

  it("switches to a narrow one-role layout on small terminals", () => {
    const state = createInitialTuiState();
    state.focusRole = "engineer";

    const layout = computeTuiLayout({
      height: 16,
      state,
      width: 72,
    });

    expect(layout.mode).toBe("narrow");
    expect(layout.roles.engineer.visible).toBe(true);
    expect(layout.roles.architect.visible).toBe(false);
  });

  it("renders meaningful text labels without depending on color", () => {
    const state = createInitialTuiState({
      demoMode: false,
      runLabel: "qa-run",
    });
    state.focusRole = "architect";
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
    const layout = computeTuiLayout({
      height: 24,
      state,
      width: 72,
    });
    const headerBox = createRecordingBox();
    const roleBox = createRecordingBox();
    const statusBarBox = createRecordingBox();
    const theme = createTuiTheme({
      colorMode: "none",
      unicode: false,
    });

    renderHeaderWidget({
      box: headerBox,
      layout,
      rect: layout.header,
      state,
      theme,
    });
    renderRolePanelWidget({
      box: roleBox,
      rect: layout.roles.architect.rect,
      role: "architect",
      state,
      theme,
    });
    renderStatusBarWidget({
      box: statusBarBox,
      layout,
      rect: layout.footer,
      state,
      theme,
    });

    expect(headerBox.content).toContain("theme:mono/ascii");
    expect(roleBox.label).toContain("[*] Architect");
    expect(roleBox.content).toContain("Task Queue");
    expect(roleBox.content).toContain(
      "[ACTIVE] Review terminal fallback behavior",
    );
    expect(roleBox.content).toContain(
      "[BLOCKED] Confirm Windows fallback behavior",
    );
    expect(statusBarBox.content).toContain("Tab switch role (Architect)");
  });

  it("renders the footer without relying on box labels", () => {
    const state = createInitialTuiState({
      demoMode: false,
      runLabel: "qa-run",
    });
    const layout = computeTuiLayout({
      height: 24,
      state,
      width: 120,
    });
    const statusBarBox = createRecordingBox({
      setLabel() {
        throw new Error("footer should not set a label");
      },
    });
    const theme = createTuiTheme({
      colorMode: "full",
      unicode: true,
    });

    renderStatusBarWidget({
      box: statusBarBox,
      layout,
      rect: layout.footer,
      state,
      theme,
    });

    expect(statusBarBox.content).toContain("q quit-ui");
    expect(statusBarBox.style).toEqual({
      fg: "white",
    });
  });

  it("keeps widget styles intact in mono mode instead of clearing them", () => {
    const state = createInitialTuiState({
      demoMode: false,
      runLabel: "qa-run",
    });
    state.helpOpen = true;
    const layout = computeTuiLayout({
      height: 24,
      state,
      width: 120,
    });
    const theme = createTuiTheme({
      colorMode: "none",
      unicode: false,
    });
    const sentinelStyle = { fg: "white" };
    const roleBox = createRecordingBox({
      style: sentinelStyle,
    });
    const statusBarBox = createRecordingBox({
      style: sentinelStyle,
    });
    const helpModalBox = createRecordingBox({
      style: sentinelStyle,
    });

    renderRolePanelWidget({
      box: roleBox,
      rect: layout.roles.architect.rect,
      role: "architect",
      state,
      theme,
    });
    renderStatusBarWidget({
      box: statusBarBox,
      layout,
      rect: layout.footer,
      state,
      theme,
    });
    renderHelpModalWidget({
      box: helpModalBox,
      rect: layout.helpModal,
      state,
      theme,
    });

    expect(roleBox.style).toBe(sentinelStyle);
    expect(statusBarBox.style).toBe(sentinelStyle);
    expect(helpModalBox.style).toBe(sentinelStyle);
  });

  it("clips role panel content to the available body height on tiny terminals", () => {
    const state = createInitialTuiState({
      demoMode: false,
      runLabel: "qa-run",
    });
    const theme = createTuiTheme({
      colorMode: "none",
      unicode: false,
    });
    const roleBox = createRecordingBox();

    renderRolePanelWidget({
      box: roleBox,
      rect: { height: 4, left: 0, top: 0, width: 40 },
      role: "architect",
      state,
      theme,
    });

    expect(roleBox.content.split("\n")).toHaveLength(2);
  });
});

function createRecordingBox(
  overrides: Partial<BlessedBox> = {},
): BlessedBox & { content: string; label: string } {
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
    ...overrides,
  };
}
