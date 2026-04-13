import { Command } from "commander";

import { createPlaceholderAction } from "../placeholder.js";

export function createStatusCommand(): Command {
  return new Command("status")
    .description("Inspect bootstrap and run status for the current project")
    .action(
      createPlaceholderAction({
        commandName: "status",
        followUp:
          "Later milestones will use this command to inspect repo-local run state.",
        milestone: "Milestone 2+",
      }),
    );
}
