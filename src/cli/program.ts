import path from "node:path";

import { Command } from "commander";

import packageJson from "../../package.json" with { type: "json" };

import { createChatCommand } from "./commands/chat.js";
import { createInitCommand } from "./commands/init.js";
import { createInspectCommand } from "./commands/inspect.js";
import { createRunCommand } from "./commands/run.js";
import { createStatusCommand } from "./commands/status.js";
import { createTuiDemoCommand } from "./commands/tui-demo.js";

const CLI_NAME = "architect-engineer-agentic-harness";
const CLI_DESCRIPTION =
  "CLI-first Architect-Engineer harness for autonomous repo work.";

interface CreateProgramOptions {
  argv?: readonly string[];
}

export function createProgram(options: CreateProgramOptions = {}): Command {
  const program = new Command();
  const programName = resolveProgramName(options.argv ?? process.argv);

  program.name(programName).description(CLI_DESCRIPTION);
  program.version(packageJson.version);
  program.showHelpAfterError();
  program.showSuggestionAfterError();

  program.addCommand(createInitCommand());
  program.addCommand(createChatCommand());
  program.addCommand(createRunCommand());
  program.addCommand(createStatusCommand());
  program.addCommand(createInspectCommand());
  program.addCommand(createTuiDemoCommand());

  return program;
}

function resolveProgramName(argv: readonly string[]): string {
  const executablePath = argv[1];

  if (
    typeof executablePath !== "string" ||
    executablePath.trim().length === 0
  ) {
    return CLI_NAME;
  }

  const executableName = path.basename(executablePath.trim());

  if (
    executableName.length === 0 ||
    /\.(?:[cm]?[jt]s)$/u.test(executableName)
  ) {
    return CLI_NAME;
  }

  return executableName;
}
