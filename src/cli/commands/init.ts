import { Command } from "commander";

import {
  formatInitializeProjectSummary,
  initializeProject,
} from "../../config/init-project.js";

export function createInitCommand(): Command {
  return new Command("init")
    .description("Bootstrap repo-local harness config and artifact directories")
    .action(async () => {
      const result = await initializeProject(process.cwd());
      console.log(formatInitializeProjectSummary(result));
    });
}
