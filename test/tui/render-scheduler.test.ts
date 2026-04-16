import { describe, expect, it, vi } from "vitest";

import { createRenderScheduler } from "../../src/tui/render-scheduler.js";

describe("render scheduler", () => {
  it("coalesces bursty dirty marks into a single render", async () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const scheduler = createRenderScheduler({
      delayMs: 10,
      render,
    });

    scheduler.markDirty();
    scheduler.markDirty();
    scheduler.markDirty();

    await vi.advanceTimersByTimeAsync(11);

    expect(render).toHaveBeenCalledTimes(1);

    scheduler.destroy();
    vi.useRealTimers();
  });

  it("flushes immediately when requested", () => {
    const render = vi.fn();
    const scheduler = createRenderScheduler({
      delayMs: 1_000,
      render,
    });

    scheduler.markDirty();
    scheduler.flush();

    expect(render).toHaveBeenCalledTimes(1);
    scheduler.destroy();
  });
});
