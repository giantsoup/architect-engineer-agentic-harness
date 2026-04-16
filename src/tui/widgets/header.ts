import type { BlessedBox } from "../neo-blessed.js";
import type { TuiLayout, TuiRect } from "../layout.js";
import type { TuiState } from "../state.js";
import {
  formatThemeModeLabel,
  TUI_ROLE_LABELS,
  type TuiTheme,
} from "../theme.js";

export function renderHeaderWidget(options: {
  box: BlessedBox;
  layout: TuiLayout;
  rect: TuiRect;
  state: TuiState;
  theme: TuiTheme;
}): void {
  const mode = options.state.demoMode ? "DEMO" : "LIVE";
  const narrowRole =
    options.layout.mode === "narrow"
      ? ` | showing:${TUI_ROLE_LABELS[options.state.focusRole]}`
      : "";

  options.box.top = options.rect.top;
  options.box.left = options.rect.left;
  options.box.width = options.rect.width;
  options.box.height = options.rect.height;
  if (options.theme.capabilities.colorMode !== "none") {
    options.box.style = {
      fg: options.theme.mutedColor,
    };
  }
  options.box.setContent(
    truncateLine(
      `${options.state.runLabel} ${mode} | ${options.layout.mode} dashboard${narrowRole} | theme:${formatThemeModeLabel(options.theme)}`,
      options.rect.width,
    ),
  );
  options.box.show();
}

function truncateLine(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  return width <= 3 ? value.slice(0, width) : `${value.slice(0, width - 3)}...`;
}
