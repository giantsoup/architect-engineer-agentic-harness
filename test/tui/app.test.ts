import { describe, expect, it, vi } from "vitest";

import { createTuiApp } from "../../src/tui/app.js";
import type {
  BlessedBox,
  BlessedKey,
  BlessedScreen,
} from "../../src/tui/neo-blessed.js";
import { createInitialTuiState, createTuiStore } from "../../src/tui/state.js";

describe("tui app", () => {
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

function createFakeBox(): BlessedBox {
  return {
    height: 0,
    hide() {},
    left: 0,
    setContent() {},
    setLabel() {},
    show() {},
    top: 0,
    width: 0,
  };
}
