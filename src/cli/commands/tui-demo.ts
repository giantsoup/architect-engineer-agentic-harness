import { Command } from "commander";

import {
  buildRunDossierPaths,
  DEFAULT_ARTIFACTS_ROOT_DIR,
  DEFAULT_RUNS_DIR,
} from "../../index.js";
import { createTuiRenderer } from "../../tui/app.js";

interface TuiDemoCommandOptions {
  runLabel: string;
  task?: string;
}

const DEFAULT_RUN_LABEL = "demo-run";

export function createTuiDemoCommand(): Command {
  return new Command("tui-demo")
    .description("Open the standalone TUI demo feed")
    .option("--task <markdown>", "Optional task label for the demo feed")
    .option(
      "--run-label <label>",
      "Label shown in the TUI header",
      DEFAULT_RUN_LABEL,
    )
    .action(async (options: TuiDemoCommandOptions) => {
      const controller = createTuiRenderer({
        paths: buildRunDossierPaths({
          artifactsRootDir: DEFAULT_ARTIFACTS_ROOT_DIR,
          projectRoot: process.cwd(),
          runId: options.runLabel,
          runsDir: DEFAULT_RUNS_DIR,
        }),
        ...(options.task === undefined ? {} : { task: options.task }),
      });

      controller.start();
      await controller.waitUntilStopped();
    });
}
