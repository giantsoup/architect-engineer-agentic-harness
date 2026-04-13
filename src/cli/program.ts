import { Command } from "commander";

import packageJson from "../../package.json" with { type: "json" };

import { createInitCommand } from "./commands/init.js";
import { createInspectCommand } from "./commands/inspect.js";
import { createRunCommand } from "./commands/run.js";
import { createStatusCommand } from "./commands/status.js";

const CLI_NAME = "architect-engineer-agentic-harness";
const CLI_DESCRIPTION =
  "CLI-first Architect-Engineer harness for autonomous repo work.";

export function createProgram(): Command {
  const program = new Command();

  program.name(CLI_NAME).description(CLI_DESCRIPTION);
  program.version(packageJson.version);
  program.showHelpAfterError();
  program.showSuggestionAfterError();

  program.addCommand(createInitCommand());
  program.addCommand(createRunCommand());
  program.addCommand(createStatusCommand());
  program.addCommand(createInspectCommand());

  return program;
}
