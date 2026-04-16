import { describe, expect, it, vi } from "vitest";

import { createTuiApp } from "../../src/tui/app.js";
import type {
  BlessedBox,
  BlessedKey,
  BlessedScreen,
} from "../../src/tui/neo-blessed.js";

describe("tui terminal restore", () => {
  it("tears down the terminal if rendering throws", async () => {
    const screen = createFakeScreen({
      renderError: new Error("render exploded"),
    });
    const errorWrites: string[] = [];
    const dataSource = {
      start() {},
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const app = createTuiApp({
      dataSource,
      errorOutput: {
        write(chunk) {
          errorWrites.push(String(chunk));
          return true;
        },
      },
      runLabel: "qa-run",
      screen,
    });

    app.start();
    await settle();

    expect(dataSource.stop).toHaveBeenCalledOnce();
    expect(screen.destroy).toHaveBeenCalledOnce();
    expect(errorWrites.join("")).toContain(
      "TUI disabled after render failed. Terminal state was restored.",
    );
  });

  it("restores the terminal if startup fails before the first render", async () => {
    const screen = createFakeScreen();
    const errorWrites: string[] = [];
    const dataSource = {
      start: vi.fn(() => {
        throw new Error("startup exploded");
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const app = createTuiApp({
      dataSource,
      errorOutput: {
        write(chunk) {
          errorWrites.push(String(chunk));
          return true;
        },
      },
      runLabel: "qa-run",
      screen,
    });

    app.start();
    await settle();

    expect(dataSource.stop).toHaveBeenCalledOnce();
    expect(screen.destroy).toHaveBeenCalledOnce();
    expect(errorWrites.join("")).toContain(
      "TUI disabled after startup failed. Terminal state was restored.",
    );
  });

  it("still destroys the screen when teardown itself reports an error", async () => {
    const screen = createFakeScreen();
    const errorWrites: string[] = [];
    const app = createTuiApp({
      dataSource: {
        start() {},
        stop: vi.fn().mockRejectedValue(new Error("stop exploded")),
      },
      errorOutput: {
        write(chunk) {
          errorWrites.push(String(chunk));
          return true;
        },
      },
      runLabel: "qa-run",
      screen,
    });

    app.start();
    await app.stop();

    expect(screen.destroy).toHaveBeenCalledOnce();
    expect(errorWrites.join("")).toContain(
      "TUI disabled after data source teardown failed. Terminal state was restored.",
    );
  });
});

function createFakeScreen(
  options: {
    renderError?: Error | undefined;
  } = {},
): BlessedScreen {
  return {
    destroy: vi.fn(),
    height: 32,
    key(
      keys: string | readonly string[],
      handler: (character: string, key: BlessedKey) => void,
    ) {
      void keys;
      void handler;
    },
    on() {},
    render: vi.fn(() => {
      if (options.renderError !== undefined) {
        throw options.renderError;
      }
    }),
    width: 120,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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
