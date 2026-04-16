import type { BlessedBox } from "../neo-blessed.js";
import type { TuiRect } from "../layout.js";
import type { TuiState } from "../state.js";
import { TUI_PANE_LABELS } from "../theme.js";

export function renderStatusBarWidget(options: {
  box: BlessedBox;
  rect: TuiRect;
  state: TuiState;
}): void {
  const mode = options.state.demoMode ? "DEMO" : "LIVE";
  const maximized =
    options.state.maximizedPane === null
      ? "off"
      : TUI_PANE_LABELS[options.state.maximizedPane];

  options.box.top = options.rect.top;
  options.box.left = options.rect.left;
  options.box.width = options.rect.width;
  options.box.height = options.rect.height;
  options.box.style = {
    bg: "white",
    fg: "black",
  };
  options.box.setLabel("");
  options.box.setContent(
    [
      `${options.state.runLabel} ${mode}`,
      `focus:${TUI_PANE_LABELS[options.state.focusPane]}`,
      `follow:${options.state.followMode ? "on" : "off"}`,
      `max:${maximized}`,
      options.state.statusText,
      "Tab/S-Tab focus  1-6 jump  arrows/PgUp/PgDn move  x max  f follow  r reset  ? help  q quit-ui",
    ].join(" | "),
  );
  options.box.show();
}
