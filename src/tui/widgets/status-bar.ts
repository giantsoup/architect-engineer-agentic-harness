import type { BlessedBox } from "../neo-blessed.js";
import type { TuiLayout, TuiRect } from "../layout.js";
import type { TuiState } from "../state.js";
import type { TuiTheme } from "../theme.js";

export function renderStatusBarWidget(options: {
  box: BlessedBox;
  layout: TuiLayout;
  rect: TuiRect;
  state: TuiState;
  theme: TuiTheme;
}): void {
  const parts = [
    options.layout.mode === "narrow"
      ? "Tab switch role"
      : "Tab switch role/panel",
    ...(!options.state.demoMode && options.state.runActive
      ? [options.state.runStopRequested ? "Stopping run" : "s stop run"]
      : []),
    options.state.helpOpen ? "? close help" : "? help",
    "q quit",
  ];

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
    formatFooterContent(parts, options.state.statusText, options.rect.width),
  );
  options.box.show();
}

function formatFooterContent(
  parts: readonly string[],
  statusText: string,
  width: number,
): string {
  const trimmedStatus = statusText.trim();
  const base = parts.join(" | ");

  if (trimmedStatus.length === 0) {
    return truncateLine(base, width);
  }

  const fullLine = `${base} | ${trimmedStatus}`;

  if (fullLine.length <= width) {
    return fullLine;
  }

  const statusWidth = width - base.length - 3;

  if (statusWidth >= 8) {
    return `${base} | ${truncateLine(trimmedStatus, statusWidth)}`;
  }

  return truncateLine(base, width);
}

function truncateLine(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  return width <= 3 ? value.slice(0, width) : `${value.slice(0, width - 3)}...`;
}
