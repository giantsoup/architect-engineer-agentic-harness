import path from "node:path";

import { Command } from "commander";

import { loadHarnessConfig } from "../../config/load-config.js";
import { createAgentChatSession } from "../../runtime/agent-chat-session.js";
import { createChatTuiController } from "../../tui/chat/app.js";

interface ChatCommandOptions {
  projectRoot?: string;
}

export function createChatCommand(): Command {
  return new Command("chat")
    .description("Open the single-model interactive chat TUI")
    .option(
      "--project-root <directory>",
      "Repository root for the chat session",
    )
    .action(async (options: ChatCommandOptions) => {
      if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        throw new Error(
          "The `blueprint chat` TUI requires an interactive TTY on stdin and stdout. For scripted use, run `blueprint run --task ...` instead.",
        );
      }

      const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
      const loadedConfig = await loadHarnessConfig({ projectRoot });
      const session = await createAgentChatSession({ loadedConfig });
      const tui = createChatTuiController({ session });

      tui.start();
      const result = await tui.waitUntilStopped();

      process.exitCode = result.status === "success" ? 0 : 1;
    });
}
