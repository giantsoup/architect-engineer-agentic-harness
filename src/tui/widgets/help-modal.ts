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
      "Dashboard MVP",
      "",
      "Tab / Shift-Tab : switch Architect and Engineer focus",
      "Up / Down : scroll the focused role section",
      "PgUp / PgDn : scroll faster within the focused role section",
      "f : toggle execution-log follow mode",
      "r : reset help and scroll state",
      "? : toggle this help modal",
      "q / Ctrl-C : close the TUI shell without cancelling the run",
      "",
      "Layout",
      "",
      `Theme: ${formatThemeModeLabel(options.theme)}`,
      "Wide terminals render two primary panels: Architect and Engineer.",
      "Narrow terminals switch to a one-role-at-a-time dashboard with Tab to swap roles.",
      "Execution log and task queue placeholders stay explicit until full section wiring lands.",
      "On TUI failures the shell is torn down and the run continues with dossier writes intact.",
    ].join("\n"),
  );

  if (options.state.helpOpen) {
    options.box.show();
  } else {
    options.box.hide();
  }
}
