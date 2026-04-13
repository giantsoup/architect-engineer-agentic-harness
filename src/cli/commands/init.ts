import { Command } from "commander";

import { createPlaceholderAction } from "../placeholder.js";

export function createInitCommand(): Command {
  return new Command("init")
    .description("Bootstrap repo-local harness config and artifact directories")
    .action(
      createPlaceholderAction({
        commandName: "init",
        followUp:
          "Milestone 1 will add TOML config generation and artifact bootstrap.",
        milestone: "Milestone 1",
      }),
    );
}
