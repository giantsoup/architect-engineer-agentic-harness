import { Command } from "commander";

import { createPlaceholderAction } from "../placeholder.js";

export function createInspectCommand(): Command {
  return new Command("inspect")
    .description("Inspect harness metadata, assets, and generated artifacts")
    .action(
      createPlaceholderAction({
        commandName: "inspect",
        followUp:
          "Later milestones will use this command for prompt, schema, and artifact inspection.",
        milestone: "Milestone 2+",
      }),
    );
}
