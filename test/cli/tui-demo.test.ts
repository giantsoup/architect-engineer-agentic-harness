import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockedModules = vi.hoisted(() => ({
  buildRunDossierPaths: vi.fn(),
  createTuiRenderer: vi.fn(),
}));

vi.mock("../../src/index.js", () => ({
  DEFAULT_ARTIFACTS_ROOT_DIR: ".agent-harness",
  DEFAULT_RUNS_DIR: ".agent-harness/runs",
  buildRunDossierPaths: mockedModules.buildRunDossierPaths,
}));

vi.mock("../../src/tui/app.js", () => ({
  createTuiRenderer: mockedModules.createTuiRenderer,
}));

describe("CLI tui demo", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("launches the standalone TUI demo with default labels", async () => {
    const { createTuiDemoCommand } = await import(
      "../../src/cli/commands/tui-demo.js"
    );
    const controller = {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      waitUntilStopped: vi.fn().mockResolvedValue(undefined),
    };

    mockedModules.buildRunDossierPaths.mockReturnValue({
      runId: "demo-run",
    });
    mockedModules.createTuiRenderer.mockReturnValue(controller);

    await parseCommand(createTuiDemoCommand(), []);

    expect(mockedModules.buildRunDossierPaths).toHaveBeenCalledWith({
      artifactsRootDir: ".agent-harness",
      projectRoot: process.cwd(),
      runId: "demo-run",
      runsDir: ".agent-harness/runs",
    });
    expect(mockedModules.createTuiRenderer).toHaveBeenCalledWith({
      paths: {
        runId: "demo-run",
      },
    });
    expect(controller.start).toHaveBeenCalledOnce();
    expect(controller.waitUntilStopped).toHaveBeenCalledOnce();
  });

  it("passes through custom task and run labels", async () => {
    const { createTuiDemoCommand } = await import(
      "../../src/cli/commands/tui-demo.js"
    );
    const controller = {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      waitUntilStopped: vi.fn().mockResolvedValue(undefined),
    };

    mockedModules.buildRunDossierPaths.mockReturnValue({
      runId: "preview-shell",
    });
    mockedModules.createTuiRenderer.mockReturnValue(controller);

    await parseCommand(createTuiDemoCommand(), [
      "--run-label",
      "preview-shell",
      "--task",
      "Inspect the updated role cards.",
    ]);

    expect(mockedModules.buildRunDossierPaths).toHaveBeenCalledWith({
      artifactsRootDir: ".agent-harness",
      projectRoot: process.cwd(),
      runId: "preview-shell",
      runsDir: ".agent-harness/runs",
    });
    expect(mockedModules.createTuiRenderer).toHaveBeenCalledWith({
      paths: {
        runId: "preview-shell",
      },
      task: "Inspect the updated role cards.",
    });
  });
});

async function parseCommand(command: Command, args: string[]) {
  await command.parseAsync(args, { from: "user" });
}
