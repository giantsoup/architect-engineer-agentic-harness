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

describe("CLI run ui mode", () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    vi.clearAllMocks();
    process.exitCode = originalExitCode;
  });

  it("defaults task mode to the current live console path", async () => {
    const { createRunCommand } = await import("../../src/cli/commands/run.js");
    const liveConsole = {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const dossierPaths = {
      runDirRelativePath: ".agent-harness/runs/20260415T120000.000Z-abc123",
      runId: "20260415T120000.000Z-abc123",
    };

    mockSuccessfulTaskRun(liveConsole, dossierPaths);

    await parseRunCommand(createRunCommand(), ["--task", "Ship the change"]);

    expect(mockedModules.createLiveConsoleRenderer).toHaveBeenCalledOnce();
    expect(liveConsole.start).toHaveBeenCalledOnce();
    expect(liveConsole.stop).toHaveBeenCalledOnce();
  });

  it("keeps `plain` and `tui` on the placeholder path without invoking the live renderer", async () => {
    const { createRunCommand } = await import("../../src/cli/commands/run.js");
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const dossierPaths = {
      runDirRelativePath: ".agent-harness/runs/20260415T120000.000Z-abc124",
      runId: "20260415T120000.000Z-abc124",
    };

    mockSuccessfulTaskRun(
      {
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      dossierPaths,
    );

    try {
      await parseRunCommand(createRunCommand(), [
        "--task",
        "Ship the change",
        "--ui",
        "plain",
      ]);
      await parseRunCommand(createRunCommand(), [
        "--task",
        "Ship the change",
        "--ui",
        "tui",
      ]);
    } finally {
      stderrSpy.mockRestore();
    }

    expect(mockedModules.createLiveConsoleRenderer).not.toHaveBeenCalled();
    expect(mockedModules.executeArchitectEngineerRun).toHaveBeenCalledTimes(2);
  });
});

function mockSuccessfulTaskRun(
  liveConsole: { start: () => void; stop: () => Promise<void> },
  dossierPaths: { runDirRelativePath: string; runId: string },
): void {
  mockedModules.loadHarnessConfig.mockResolvedValue(createLoadedConfigStub());
  mockedModules.createRunId.mockReturnValue(dossierPaths.runId);
  mockedModules.buildRunDossierPaths.mockReturnValue(dossierPaths);
  mockedModules.createLiveConsoleRenderer.mockReturnValue(liveConsole);
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
    ...createInspection(),
    runDirRelativePath: dossierPaths.runDirRelativePath,
    runId: dossierPaths.runId,
  });
}

function createInspection() {
  return {
    activeRole: "architect",
    artifacts: {} as never,
    commandStatus: "No commands or checks recorded yet.",
    createdAt: "2026-04-15T12:00:00.000Z",
    currentObjective: "Ship the change",
    elapsedMs: 5_000,
    latestDecision: "Task completed.",
    manifest: {} as never,
    phase: "Completed",
    primaryArtifacts: [],
    runDirAbsolutePath:
      "/tmp/project/.agent-harness/runs/20260415T120000.000Z-abc123",
    runDirRelativePath: ".agent-harness/runs/20260415T120000.000Z-abc123",
    runId: "20260415T120000.000Z-abc123",
    status: "success",
    summary: "Task completed.",
    updatedAt: "2026-04-15T12:00:05.000Z",
  };
}

function createLoadedConfigStub() {
  return {
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
  } as never;
}

async function parseRunCommand(command: Command, args: string[]) {
  process.exitCode = 0;
  await command.parseAsync(args, { from: "user" });
}
