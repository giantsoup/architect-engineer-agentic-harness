import type { BlessedBox } from "../neo-blessed.js";
import type { TuiRect } from "../layout.js";
import type { TuiState } from "../state.js";
import { TUI_ROLE_LABELS, type TuiTheme } from "../theme.js";

export function renderHeaderWidget(options: {
  box: BlessedBox;
  rect: TuiRect;
  state: TuiState;
  theme: TuiTheme;
}): void {
  const runMode = options.state.demoMode ? "demo" : "live";
  const activeRole =
    options.state.activeRole === "system"
      ? "System"
      : TUI_ROLE_LABELS[options.state.activeRole];

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
      `Run ${options.state.runLabel} | ${runMode} | ${options.state.phaseText} | ${activeRole}`,
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
