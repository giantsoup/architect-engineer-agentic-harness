import type { BlessedBox } from "../neo-blessed.js";
import type { TuiRect } from "../layout.js";
import type { TuiState } from "../state.js";
import type { TuiTheme } from "../theme.js";

export function renderHelpModalWidget(options: {
  box: BlessedBox;
  rect: TuiRect;
  state: TuiState;
  theme: TuiTheme;
}): void {
  options.box.top = options.rect.top;
  options.box.left = options.rect.left;
  options.box.width = options.rect.width;
  options.box.height = options.rect.height;
  options.box.setLabel("Help");
  if (options.theme.capabilities.colorMode !== "none") {
    options.box.style = {
      border: { fg: options.theme.helpBorderColor },
      fg: options.theme.mutedColor,
    };
  }
  options.box.setContent(
    [
      "Current-State Dashboard",
      "",
      "The TUI shows the current task, state, latest activity, and current or last execution result for each role.",
      ...(!options.state.demoMode && options.state.runActive
        ? ["s : gracefully stop the current run and keep the TUI open"]
        : []),
      "Tab / Shift-Tab : move focus in wide mode or swap roles in narrow mode",
      "? : toggle this help modal",
      "q / Ctrl-C : close the TUI shell without cancelling the run",
      "",
      "Layout",
      "",
      "Wide terminals keep Architect beside Engineer with compact cards.",
      "Narrow terminals show one role at a time with explicit Tab switching.",
      "Empty states stay explicit instead of collapsing to blank space.",
      "History stays in the dossier; the TUI only surfaces current state.",
      "If the TUI fails, the shell tears down cleanly and the run continues.",
    ].join("\n"),
  );

  if (options.state.helpOpen) {
    options.box.show();
  } else {
    options.box.hide();
  }
}
