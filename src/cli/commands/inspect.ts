import { Command } from "commander";

import { loadHarnessConfig } from "../../index.js";
import {
  readRunInspection,
  resolveRunDossierPaths,
} from "../../runtime/run-history.js";
import { renderInspectSummary } from "../../ui/summary-renderer.js";

export function createInspectCommand(): Command {
  return new Command("inspect")
    .description(
      "List artifact paths for the latest run or a specific run by ID",
    )
    .argument("[run-id]", "Run ID to inspect; defaults to the latest run")
    .action(async (runId?: string) => {
      const loadedConfig = await loadHarnessConfig({
        projectRoot: process.cwd(),
      });
      const dossierPaths = await resolveRunDossierPaths(loadedConfig, runId);
      const inspection = await readRunInspection(dossierPaths);

      process.stdout.write(renderInspectSummary(inspection));
    });
}
