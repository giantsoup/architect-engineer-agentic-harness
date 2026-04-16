import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockedModules = vi.hoisted(() => ({
  buildRunDossierPaths: vi.fn(),
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

describe("tui fallback summary", () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    vi.clearAllMocks();
    process.exitCode = originalExitCode;
  });

  it("falls back cleanly without a TTY and still prints the concise completion summary", async () => {
    const { createRunCommand } = await import("../../src/cli/commands/run.js");
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });

    try {
      mockSuccessfulTaskRun();
      await parseRunCommand(createRunCommand(), [
        "--task",
        "Ship the fallback behavior",
        "--ui",
        "tui",
      ]);
    } finally {
      stderrSpy.mockRestore();
    }

    const output = stderrWrites.join("");

    expect(output).toContain(
      "TUI requested for 20260416T030000.000Z-fedcba, but an interactive TTY is unavailable.",
    );
    expect(output).toContain("Run success: Task completed.");
    expect(output).toContain(
      "Dossier: .agent-harness/runs/20260416T030000.000Z-fedcba",
    );
    expect(output).toContain(
      "Status command: architect-engineer-agentic-harness status 20260416T030000.000Z-fedcba",
    );
  });
});

function mockSuccessfulTaskRun(): void {
  const dossierPaths = {
    runDirRelativePath: ".agent-harness/runs/20260416T030000.000Z-fedcba",
    runId: "20260416T030000.000Z-fedcba",
  };

  mockedModules.loadHarnessConfig.mockResolvedValue({
    config: {
      artifacts: {
        rootDir: ".agent-harness",
        runsDir: ".agent-harness/runs",
      },
      project: {
        executionTarget: "host",
      },
    },
    projectRoot: "/tmp/project",
    resolvedProject: {
      adapter: "generic",
    },
  });
  mockedModules.createRunId.mockReturnValue(dossierPaths.runId);
  mockedModules.buildRunDossierPaths.mockReturnValue(dossierPaths);
  mockedModules.executeArchitectEngineerRun.mockResolvedValue({
    dossier: { paths: dossierPaths },
    result: {
      status: "success",
      summary: "Task completed.",
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
  mockedModules.readRunInspection.mockResolvedValue({
    activeRole: "system",
    artifacts: {
      checks: {
        key: "checks",
        relativePath:
          ".agent-harness/runs/20260416T030000.000Z-fedcba/checks.json",
      },
      commandLog: {
        key: "commandLog",
        relativePath:
          ".agent-harness/runs/20260416T030000.000Z-fedcba/command-log.jsonl",
      },
      events: {
        key: "events",
        relativePath:
          ".agent-harness/runs/20260416T030000.000Z-fedcba/events.jsonl",
      },
      finalReport: {
        key: "finalReport",
        relativePath:
          ".agent-harness/runs/20260416T030000.000Z-fedcba/final-report.md",
      },
      result: {
        key: "result",
        relativePath:
          ".agent-harness/runs/20260416T030000.000Z-fedcba/result.json",
      },
    },
    commandStatus: "Required check passed (exit 0): npm test",
    createdAt: "2026-04-16T03:00:00.000Z",
    currentObjective: "Ship the fallback behavior",
    elapsedMs: 5_000,
    latestDecision: "Task completed.",
    manifest: {} as never,
    phase: "Completed",
    primaryArtifacts: [
      {
        key: "finalReport",
        relativePath:
          ".agent-harness/runs/20260416T030000.000Z-fedcba/final-report.md",
      },
      {
        key: "result",
        relativePath:
          ".agent-harness/runs/20260416T030000.000Z-fedcba/result.json",
      },
    ],
    runDirAbsolutePath:
      "/tmp/project/.agent-harness/runs/20260416T030000.000Z-fedcba",
    runDirRelativePath: ".agent-harness/runs/20260416T030000.000Z-fedcba",
    runId: "20260416T030000.000Z-fedcba",
    status: "success",
    summary: "Task completed.",
    updatedAt: "2026-04-16T03:00:05.000Z",
  });
}

async function parseRunCommand(command: Command, args: string[]) {
  process.exitCode = 0;
  await command.parseAsync(args, { from: "user" });
}
