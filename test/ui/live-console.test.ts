import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildRunDossierPaths } from "../../src/artifacts/paths.js";

const mockedModules = vi.hoisted(() => ({
  readRunInspection: vi.fn(),
}));

vi.mock("../../src/runtime/run-history.js", () => ({
  readRunInspection: mockedModules.readRunInspection,
}));

describe("live console renderer", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("emits concise non-TTY updates only when the manager-level snapshot changes", async () => {
    vi.useFakeTimers();

    const { createLiveConsoleRenderer } =
      await import("../../src/ui/live-console.js");
    const paths = buildRunDossierPaths({
      artifactsRootDir: ".agent-harness",
      projectRoot: path.join(os.tmpdir(), "aeah-live-console"),
      runId: "20260414T120000.000Z-abc123",
      runsDir: ".agent-harness/runs",
    });
    const writes: string[] = [];

    mockedModules.readRunInspection
      .mockResolvedValueOnce(
        createInspection({
          commandStatus: "No commands or checks recorded yet.",
          currentObjective: "Plan the change",
          elapsedMs: 5_000,
          latestDecision: "Break the CLI output into a concise summary.",
          phase: "Planning",
          status: "running",
        }),
      )
      .mockResolvedValueOnce(
        createInspection({
          commandStatus: "No commands or checks recorded yet.",
          currentObjective: "Plan the change",
          elapsedMs: 5_000,
          latestDecision: "Break the CLI output into a concise summary.",
          phase: "Planning",
          status: "running",
        }),
      )
      .mockResolvedValue(
        createInspection({
          commandStatus: "Required check failed (exit 1): npm test",
          currentObjective: "Fix the failing check",
          elapsedMs: 15_000,
          latestDecision: "Revise the renderer after the failing check.",
          phase: "Execution",
          status: "running",
        }),
      );

    const renderer = createLiveConsoleRenderer({
      output: {
        isTTY: false,
        write(chunk: string | Uint8Array) {
          writes.push(String(chunk));
          return true;
        },
      },
      paths,
      pollIntervalMs: 10,
    });

    renderer.start();
    await vi.advanceTimersByTimeAsync(35);
    await renderer.stop();

    const output = writes.join("");

    expect(output).toContain(
      "Starting run 20260414T120000.000Z-abc123. Dossier: .agent-harness/runs/20260414T120000.000Z-abc123",
    );
    expect(output).toContain(
      "[00:00:05] | RUNNING | Planning / Architect | objective: Plan the change",
    );
    expect(output).toContain(
      "[00:00:15] | RUNNING | Execution / Engineer | objective: Fix the failing check",
    );
    expect(output.match(/Planning \/ Architect/gm)).toHaveLength(1);
  });
});

function createInspection(overrides: {
  commandStatus: string;
  currentObjective: string;
  elapsedMs: number;
  latestDecision: string;
  phase: string;
  status: "failed" | "running" | "stopped" | "success";
}) {
  return {
    activeRole: overrides.phase === "Planning" ? "architect" : "engineer",
    artifacts: {} as never,
    commandStatus: overrides.commandStatus,
    createdAt: "2026-04-14T12:00:00.000Z",
    currentObjective: overrides.currentObjective,
    elapsedMs: overrides.elapsedMs,
    latestDecision: overrides.latestDecision,
    manifest: {} as never,
    phase: overrides.phase,
    primaryArtifacts: [],
    runDirAbsolutePath:
      "/tmp/project/.agent-harness/runs/20260414T120000.000Z-abc123",
    runDirRelativePath: ".agent-harness/runs/20260414T120000.000Z-abc123",
    runId: "20260414T120000.000Z-abc123",
    status: overrides.status,
    summary: overrides.latestDecision,
    updatedAt: "2026-04-14T12:00:15.000Z",
  };
}
