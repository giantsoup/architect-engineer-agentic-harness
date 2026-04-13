import { Command } from "commander";

import { createPlaceholderAction } from "../placeholder.js";

export function createRunCommand(): Command {
  return new Command("run")
    .description("Execute a harness task against the current project")
    .action(
      createPlaceholderAction({
        commandName: "run",
        followUp:
          "Later milestones will add dossier creation, model orchestration, and checks.",
        milestone: "Milestone 2+",
      }),
    );
}
