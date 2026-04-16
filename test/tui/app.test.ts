import { afterEach, describe, expect, it, vi } from "vitest";

import { createTuiApp } from "../../src/tui/app.js";
import type {
  BlessedBox,
  BlessedKey,
  BlessedScreen,
} from "../../src/tui/neo-blessed.js";
import { createInitialTuiState, createTuiStore } from "../../src/tui/state.js";

describe("tui app", () => {
  afterEach(() => {
    createdBoxes.length = 0;
    vi.useRealTimers();
  });

  it("starts the demo feed, renders, quits on keyboard input, and tears down cleanly", async () => {
    const keyHandlers: Array<(character: string, key: BlessedKey) => void> = [];
    const screen = createFakeScreen({
      keyHandlers,
    });
    const demoFeed = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    const scheduler = {
      destroy: vi.fn(),
      flush: vi.fn(),
      markDirty: vi.fn(),
    };
    const store = createTuiStore(
      createInitialTuiState({
        runLabel: "qa-run",
      }),
    );
    const app = createTuiApp({
      demoFeed,
      runLabel: "qa-run",
      scheduler,
      screen,
      store,
    });

    app.start();

    expect(demoFeed.start).toHaveBeenCalledOnce();
    expect(scheduler.markDirty).toHaveBeenCalledOnce();
    expect(scheduler.flush).toHaveBeenCalledOnce();

    keyHandlers[0]?.("", { name: "q" });
    await Promise.resolve();

    expect(demoFeed.stop).toHaveBeenCalledOnce();
    expect(scheduler.destroy).toHaveBeenCalledOnce();
    expect(screen.destroy).toHaveBeenCalledOnce();

    await app.stop();
    expect(screen.destroy).toHaveBeenCalledOnce();
  });

  it("re-renders the shell when role focus and help state change", async () => {
    vi.useFakeTimers();
    const keyHandlers: Array<(character: string, key: BlessedKey) => void> = [];
    const screen = createFakeScreen({
      keyHandlers,
    });
    const store = createTuiStore(
      createInitialTuiState({
        demoMode: false,
        runLabel: "qa-run",
        task: "Polish the dashboard",
      }),
    );
    const app = createTuiApp({
      demoFeed: {
        start() {},
        stop: vi.fn(),
      },
      runLabel: "qa-run",
      screen,
      store,
    });

    app.start();

    const [architectBox, engineerBox, headerBox, footerBox, helpBox] =
      createdBoxes;

    expect(headerBox?.content).toContain(
      "Run qa-run | live | Architect + Engineer",
    );
    expect(architectBox?.label).toBe("[*] Architect");
    expect(engineerBox?.label).toBe("[ ] Engineer");
    expect(footerBox?.content).toContain("Focus Architect");

    keyHandlers[0]?.("", { name: "tab" });
    await vi.advanceTimersByTimeAsync(20);

    expect(architectBox?.label).toBe("[ ] Architect");
    expect(engineerBox?.label).toBe("[*] Engineer");
    expect(footerBox?.content).toContain("Focus Engineer");
    expect(footerBox?.content).toContain("f follow:on");

    keyHandlers[0]?.("", { full: "?", sequence: "?" });
    await vi.advanceTimersByTimeAsync(20);

    expect(footerBox?.content).toContain("? close help");
    expect(helpBox?.hidden).toBe(false);

    await app.stop();
  });

  it("requests a graceful run stop without tearing down the TUI shell", async () => {
    vi.useFakeTimers();
    const keyHandlers: Array<(character: string, key: BlessedKey) => void> = [];
    const screen = createFakeScreen({
      keyHandlers,
    });
    const onRequestRunStop = vi.fn();
    const store = createTuiStore(
      createInitialTuiState({
        demoMode: false,
        runLabel: "qa-run",
        task: "Polish the dashboard",
      }),
    );
    const app = createTuiApp({
      demoFeed: {
        start() {},
        stop: vi.fn(),
      },
      onRequestRunStop,
      runLabel: "qa-run",
      screen,
      store,
    });

    app.start();

    const footerBox = createdBoxes[3];

    keyHandlers[0]?.("", { name: "s" });
    await vi.advanceTimersByTimeAsync(20);

    expect(onRequestRunStop).toHaveBeenCalledOnce();
    expect(store.getState().runStopRequested).toBe(true);
    expect(footerBox?.content).toContain("Stopping run");
    expect(footerBox?.content).not.toContain("s stop run");
    expect(screen.destroy).not.toHaveBeenCalled();

    keyHandlers[0]?.("", { name: "s" });
    await vi.advanceTimersByTimeAsync(20);

    expect(onRequestRunStop).toHaveBeenCalledOnce();

    await app.stop();
    expect(screen.destroy).toHaveBeenCalledOnce();
  });
});

function createFakeScreen(options: {
  keyHandlers: Array<(character: string, key: BlessedKey) => void>;
}): BlessedScreen {
  return {
    destroy: vi.fn(),
    height: 32,
    key(_keys, handler) {
      options.keyHandlers.push(handler);
    },
    on() {},
    render() {},
    width: 120,
  };
}

vi.mock("../../src/tui/neo-blessed.js", () => ({
  createBlessedBox: vi.fn(() => createFakeBox()),
  createBlessedScreen: vi.fn(),
}));

const createdBoxes: Array<
  BlessedBox & { content?: string; hidden?: boolean; label?: string }
> = [];

function createFakeBox(): BlessedBox & {
  content: string;
  hidden: boolean;
  label: string;
} {
  const box = {
    content: "",
    height: 0,
    hidden: false,
    hide() {
      this.hidden = true;
    },
    label: "",
    left: 0,
    setContent(content: string) {
      this.content = content;
    },
    setLabel(label: string) {
      this.label = label;
    },
    show() {
      this.hidden = false;
    },
    top: 0,
    width: 0,
  };

  createdBoxes.push(box);

  return box;
}
