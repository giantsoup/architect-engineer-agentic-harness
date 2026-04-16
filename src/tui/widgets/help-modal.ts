import type { BlessedBox } from "../neo-blessed.js";
import type { TuiRect } from "../layout.js";
import type { TuiState } from "../state.js";
import { formatThemeModeLabel, type TuiTheme } from "../theme.js";

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
      "Keyboard",
      "",
      "Tab / Shift-Tab : cycle focus",
      "1-6 : jump directly to a pane",
      "Left / Right : cycle focus",
      "Up / Down : move queue selection or scroll the focused pane",
      "PgUp / PgDn : move faster in the focused pane",
      "x : maximize or restore the focused pane",
      "f : toggle log follow mode",
      "r : reset maximize/help/scroll state",
      "? : toggle this help modal",
      "q / Ctrl-C : close the TUI shell without cancelling the run",
      "",
      "Fallback modes",
      "",
      `Theme: ${formatThemeModeLabel(options.theme)}`,
      "Narrow terminals switch to a single focused-pane layout.",
      "Older log, diff, and command-output lines are hidden once buffers hit their limits.",
      "On TUI failures the shell is torn down and the run continues with dossier writes intact.",
    ].join("\n"),
  );

  if (options.state.helpOpen) {
    options.box.show();
  } else {
    options.box.hide();
  }
}
