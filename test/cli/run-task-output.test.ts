import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockedModules = vi.hoisted(() => ({
  buildRunDossierPaths: vi.fn(),
  createLiveConsoleRenderer: vi.fn(),
  createProjectCommandRunner: vi.fn(),
  createRunId: vi.fn(),
  executeArchitectEngineerRun: vi.fn(),
  initializeRunDossier: vi.fn(),
  loadHarnessConfig: vi.fn(),
  readRunInspection: vi.fn(),
}));

vi.mock("../../src/index.js", () => ({
  buildRunDossierPaths: mockedModules.buildRunDossierPaths,
  createProjectCommandRunner: mockedModules.createProjectCommandRunner,
  createRunId: mockedModules.createRunId,
  executeArchitectEngineerRun: mockedModules.executeArchitectEngineerRun,
  initializeRunDossier: mockedModules.initializeRunDossier,
  loadHarnessConfig: mockedModules.loadHarnessConfig,
}));

vi.mock("../../src/runtime/run-history.js", () => ({
  readRunInspection: mockedModules.readRunInspection,
}));

vi.mock("../../src/ui/live-console.js", () => ({
  createLiveConsoleRenderer: mockedModules.createLiveConsoleRenderer,
}));

describe("CLI run task-mode summaries", () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    vi.clearAllMocks();
    process.exitCode = originalExitCode;
  });

  it("prints a concise successful manager summary with the dossier path", async () => {
    const { createRunCommand } = await import("../../src/cli/commands/run.js");
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrWrites.push(String(chunk));
        return true;
      });
    const liveConsole = {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const dossierPaths = {
      runDirRelativePath: ".agent-harness/runs/20260414T120000.000Z-abc123",
      runId: "20260414T120000.000Z-abc123",
    };

    mockedModules.loadHarnessConfig.mockResolvedValue(createLoadedConfigStub());
    mockedModules.createRunId.mockReturnValue("20260414T120000.000Z-abc123");
    mockedModules.buildRunDossierPaths.mockReturnValue(dossierPaths);
    mockedModules.createLiveConsoleRenderer.mockReturnValue(liveConsole);
    mockedModules.executeArchitectEngineerRun.mockResolvedValue({
      dossier: { paths: dossierPaths },
      result: {
        status: "success",
        summary: "Manager-level CLI UX shipped.",
      },
      state: {
        engineerExecution: {
          toolSummary: {
            mcpServers: {
              unavailable: [],
            },
          },
        },
      },
    });
    mockedModules.readRunInspection.mockResolvedValue(
      createInspection({
        phase: "Completed",
        primaryArtifacts: [
          {
            key: "finalReport",
            relativePath:
              ".agent-harness/runs/20260414T120000.000Z-abc123/final-report.md",
          },
          {
            key: "result",
            relativePath:
              ".agent-harness/runs/20260414T120000.000Z-abc123/result.json",
          },
        ],
        status: "success",
        summary: "Manager-level CLI UX shipped.",
      }),
    );

    try {
      await parseRunCommand(createRunCommand(), [
        "--task",
        "Ship Milestone 11",
      ]);
    } finally {
      stderrSpy.mockRestore();
    }

    const output = stderrWrites.join("");

    expect(liveConsole.start).toHaveBeenCalledOnce();
    expect(liveConsole.stop).toHaveBeenCalledOnce();
    expect(output).toContain("Run success: Manager-level CLI UX shipped.");
    expect(output).toContain(
      "Dossier: .agent-harness/runs/20260414T120000.000Z-abc123",
    );
    expect(output).toContain("final report");
    expect(output).toContain("result JSON");
    expect(output).not.toContain("cli stdout");
    expect(output.split("\n").length).toBeLessThan(16);
    expect(process.exitCode).toBe(0);
  });

  it("points failed runs to failure artifacts first", async () => {
    const { createRunCommand } = await import("../../src/cli/commands/run.js");
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrWrites.push(String(chunk));
        return true;
      });
    const liveConsole = {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const dossierPaths = {
      runDirRelativePath: ".agent-harness/runs/20260414T120000.000Z-abc124",
      runId: "20260414T120000.000Z-abc124",
    };

    mockedModules.loadHarnessConfig.mockResolvedValue(createLoadedConfigStub());
    mockedModules.createRunId.mockReturnValue("20260414T120000.000Z-abc124");
    mockedModules.buildRunDossierPaths.mockReturnValue(dossierPaths);
    mockedModules.createLiveConsoleRenderer.mockReturnValue(liveConsole);
    mockedModules.executeArchitectEngineerRun.mockResolvedValue({
      dossier: { paths: dossierPaths },
      result: {
        status: "failed",
        summary: "Tests still failing.",
      },
      state: {
        engineerExecution: {
          toolSummary: {
            mcpServers: {
              unavailable: [],
            },
          },
        },
      },
    });
    mockedModules.readRunInspection.mockResolvedValue(
      createInspection({
        phase: "Failed",
        primaryArtifacts: [
          {
            key: "failureNotes",
            relativePath:
              ".agent-harness/runs/20260414T120000.000Z-abc124/failure-notes.md",
          },
          {
            key: "finalReport",
            relativePath:
              ".agent-harness/runs/20260414T120000.000Z-abc124/final-report.md",
          },
          {
            key: "checks",
            relativePath:
              ".agent-harness/runs/20260414T120000.000Z-abc124/checks.json",
          },
        ],
        status: "failed",
        stopReason: "engineer-blocked",
        summary: "Tests still failing.",
      }),
    );

    try {
      await parseRunCommand(createRunCommand(), [
        "--task",
        "Ship Milestone 11",
      ]);
    } finally {
      stderrSpy.mockRestore();
    }

    const output = stderrWrites.join("");

    expect(output).toContain("Run failed: Tests still failing.");
    expect(output).toContain("Stop reason: engineer-blocked");
    expect(output).toContain("failure notes");
    expect(output).toContain("checks");
    expect(output).toContain(
      ".agent-harness/runs/20260414T120000.000Z-abc124/failure-notes.md",
    );
    expect(process.exitCode).toBe(1);
  });
});

async function parseRunCommand(
  command: Command,
  args: string[],
): Promise<void> {
  process.exitCode = 0;
  await command.parseAsync(args, { from: "user" });
}

function createLoadedConfigStub() {
  return {
    config: {
      artifacts: {
        rootDir: ".agent-harness",
        runsDir: ".agent-harness/runs",
      },
    },
    projectRoot: "/tmp/project",
  } as never;
}

function createInspection(overrides: {
  phase: string;
  primaryArtifacts: Array<{ key: string; relativePath: string }>;
  status: "failed" | "success";
  stopReason?: string;
  summary: string;
}) {
  return {
    activeRole: "system",
    artifacts: {} as never,
    commandStatus: "Required check passed: npm test",
    createdAt: "2026-04-14T12:00:00.000Z",
    currentObjective: overrides.summary,
    elapsedMs: 30_000,
    latestDecision: overrides.summary,
    manifest: {} as never,
    phase: overrides.phase,
    primaryArtifacts: overrides.primaryArtifacts.map((artifact) => ({
      absolutePath: `/tmp/project/${artifact.relativePath}`,
      exists: true,
      fileName: artifact.relativePath.split("/").at(-1)!,
      key: artifact.key,
      kind:
        artifact.key === "checks" || artifact.key === "result"
          ? "json"
          : "markdown",
      relativePath: artifact.relativePath,
      written: true,
    })),
    result: {
      status: overrides.status,
      summary: overrides.summary,
    },
    runDirAbsolutePath:
      "/tmp/project/.agent-harness/runs/20260414T120000.000Z-abc123",
    runDirRelativePath:
      overrides.primaryArtifacts[0]?.relativePath
        .split("/")
        .slice(0, 3)
        .join("/") ?? ".agent-harness/runs/20260414T120000.000Z-abc123",
    runId:
      overrides.primaryArtifacts[0]?.relativePath.split("/")[2] ??
      "20260414T120000.000Z-abc123",
    status: overrides.status,
    ...(overrides.stopReason === undefined
      ? {}
      : { stopReason: overrides.stopReason }),
    summary: overrides.summary,
    updatedAt: "2026-04-14T12:00:30.000Z",
  };
}
