import { describe, expect, it } from "vitest";

import { createHarnessEventBus } from "../../src/runtime/harness-events.js";

describe("harness event bus", () => {
  it("assigns monotonic sequence numbers and supports unsubscribe", () => {
    const bus = createHarnessEventBus({
      now: () => new Date("2026-04-15T12:00:00.000Z"),
    });
    const seenTypes: string[] = [];
    const unsubscribe = bus.subscribe((event) => {
      seenTypes.push(`${event.seq}:${event.type}`);
    });

    const first = bus.emit({
      type: "run:status",
      phase: "prepare",
      runId: "20260415T120000.000Z-abc123",
      status: "initialized",
      summary: "Preparing run dossier.",
    });
    const second = bus.emit({
      type: "artifact:update",
      artifact: "engineerTask",
      artifactKind: "markdown",
      operation: "write",
      path: ".agent-harness/runs/20260415T120000.000Z-abc123/engineer-task.md",
      runId: "20260415T120000.000Z-abc123",
    });

    unsubscribe();
    bus.emit({
      type: "run:status",
      phase: "finalize",
      runId: "20260415T120000.000Z-abc123",
      status: "success",
      summary: "Run completed.",
    });

    expect(first.seq).toBe(1);
    expect(first.timestamp).toBe("2026-04-15T12:00:00.000Z");
    expect(second.seq).toBe(2);
    expect(seenTypes).toEqual(["1:run:status", "2:artifact:update"]);
  });
});
