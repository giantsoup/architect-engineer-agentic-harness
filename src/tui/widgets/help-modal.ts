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
      "Role Dashboard",
      "",
      "Tab / Shift-Tab : move focus in wide mode or swap roles in narrow mode",
      "Up / Down : scroll the focused role panel",
      "PgUp / PgDn : scroll faster within the focused role panel",
      "f : toggle Engineer execution-log follow mode",
      ...(!options.state.demoMode && options.state.runActive
        ? ["s : gracefully stop the current run and keep the TUI open"]
        : []),
      "r : reset scroll state and close help",
      "? : toggle this help modal",
      "q / Ctrl-C : close the TUI shell without cancelling the run",
      "",
      "Layout",
      "",
      `Theme: ${formatThemeModeLabel(options.theme)}`,
      "Wide terminals keep Architect context beside Engineer execution.",
      "Narrow terminals show one role at a time with explicit Tab switching.",
      "Sections stay explicit when data is not available yet; they do not collapse to blank space.",
      "If the TUI fails, the shell tears down cleanly and the run continues.",
    ].join("\n"),
  );

  if (options.state.helpOpen) {
    options.box.show();
  } else {
    options.box.hide();
  }
}
