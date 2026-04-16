import type { BlessedBox } from "../neo-blessed.js";
import type { TuiRect } from "../layout.js";
import type { TuiState } from "../state.js";
import {
  formatThemeModeLabel,
  TUI_PANE_LABELS,
  type TuiTheme,
} from "../theme.js";

export function renderStatusBarWidget(options: {
  box: BlessedBox;
  rect: TuiRect;
  state: TuiState;
  theme: TuiTheme;
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
  options.box.style =
    options.theme.capabilities.colorMode === "none"
      ? undefined
      : {
          bg: options.theme.chromeBackground,
          fg: options.theme.chromeForeground,
        };
  options.box.setLabel("");
  options.box.setContent(
    truncateForStatusBar(
      buildStatusBarText(options, mode, maximized),
      options.rect.width,
    ),
  );
  options.box.show();
}

function buildStatusBarText(
  options: {
    rect: TuiRect;
    state: TuiState;
    theme: TuiTheme;
  },
  mode: string,
  maximized: string,
): string {
  const compact = options.rect.width < 96;

  return compact
    ? [
        `${options.state.runLabel} ${mode}`,
        `pane:${TUI_PANE_LABELS[options.state.focusPane]}`,
        `follow:${options.state.followMode ? "on" : "off"}`,
        `max:${maximized}`,
        `theme:${formatThemeModeLabel(options.theme)}`,
        options.state.statusText,
      ].join(" | ")
    : [
        `${options.state.runLabel} ${mode}`,
        `focus:${TUI_PANE_LABELS[options.state.focusPane]}`,
        `follow:${options.state.followMode ? "on" : "off"}`,
        `max:${maximized}`,
        `theme:${formatThemeModeLabel(options.theme)}`,
        options.state.statusText,
        "Tab/S-Tab focus  1-6 jump  arrows/PgUp/PgDn move  x max  f follow  r reset  ? help  q quit-ui",
      ].join(" | ");
}

function truncateForStatusBar(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  return width <= 3 ? value.slice(0, width) : `${value.slice(0, width - 3)}...`;
}
