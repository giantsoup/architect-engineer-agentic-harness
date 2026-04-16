import type { BlessedBox } from "../neo-blessed.js";
import type { TuiRect } from "../layout.js";
import type { TuiState } from "../state.js";

export function renderHelpModalWidget(options: {
  box: BlessedBox;
  rect: TuiRect;
  state: TuiState;
}): void {
  options.box.top = options.rect.top;
  options.box.left = options.rect.left;
  options.box.width = options.rect.width;
  options.box.height = options.rect.height;
  options.box.setLabel("Help");
  options.box.style = {
    border: { fg: "yellow" },
    fg: "white",
  };
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
      "q : close the TUI shell without cancelling the run",
      "",
      "This milestone intentionally uses a synthetic demo feed.",
    ].join("\n"),
  );

  if (options.state.helpOpen) {
    options.box.show();
  } else {
    options.box.hide();
  }
}
