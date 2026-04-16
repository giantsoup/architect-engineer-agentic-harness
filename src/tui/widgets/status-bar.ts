import type { BlessedBox } from "../neo-blessed.js";
import type { TuiLayout, TuiRect } from "../layout.js";
import type { TuiState } from "../state.js";
import { TUI_ROLE_LABELS, type TuiTheme } from "../theme.js";

export function renderStatusBarWidget(options: {
  box: BlessedBox;
  layout: TuiLayout;
  rect: TuiRect;
  state: TuiState;
  theme: TuiTheme;
}): void {
  const lead =
    options.layout.mode === "narrow"
      ? `Showing ${TUI_ROLE_LABELS[options.state.focusRole]}`
      : `Focus ${TUI_ROLE_LABELS[options.state.focusRole]}`;
  const parts = [
    lead,
    options.layout.mode === "narrow" ? "Tab switch role" : "Tab switch panel",
    "Scroll",
    ...(options.state.focusRole === "engineer"
      ? [`f follow:${options.state.followMode ? "on" : "off"}`]
      : []),
    ...(!options.state.demoMode && options.state.runActive
      ? [options.state.runStopRequested ? "Stopping run" : "s stop run"]
      : []),
    options.state.helpOpen ? "? close help" : "? help",
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
  const compactBase = parts.filter((part) => part !== "Scroll").join(" | ");

  if (trimmedStatus.length === 0) {
    return fitBaseLine(base, compactBase, width);
  }

  const fullLine = `${base} | ${trimmedStatus}`;

  if (fullLine.length <= width) {
    return fullLine;
  }

  const statusWidth = width - base.length - 3;

  if (statusWidth >= 8) {
    return `${base} | ${truncateLine(trimmedStatus, statusWidth)}`;
  }

  const compactStatusWidth = width - compactBase.length - 3;

  if (
    compactBase !== base &&
    compactStatusWidth >= 8 &&
    compactBase.length + 3 < width
  ) {
    return `${compactBase} | ${truncateLine(trimmedStatus, compactStatusWidth)}`;
  }

  return fitBaseLine(base, compactBase, width);
}

function fitBaseLine(base: string, compactBase: string, width: number): string {
  if (base.length <= width) {
    return base;
  }

  if (compactBase.length <= width) {
    return compactBase;
  }

  return truncateLine(compactBase, width);
}

function truncateLine(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  return width <= 3 ? value.slice(0, width) : `${value.slice(0, width - 3)}...`;
}
