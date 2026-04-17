import type { BlessedBox } from "../neo-blessed.js";
import type { TuiRect } from "../layout.js";
import type { TuiRoleId, TuiState } from "../state.js";
import { TUI_ROLE_LABELS, type TuiTheme } from "../theme.js";

const MAX_CARD_ROWS = 4;

export function renderRolePanelWidget(options: {
  box: BlessedBox;
  rect: TuiRect;
  role: TuiRoleId;
  state: TuiState;
  theme: TuiTheme;
}): void {
  const isFocused = options.state.focusRole === options.role;
  const contentHeight = Math.max(1, options.rect.height - 2);
  const contentWidth = Math.max(1, options.rect.width - 2);
  const lines = options.state.cards[options.role].lines
    .slice(0, Math.min(contentHeight, MAX_CARD_ROWS))
    .map((line) => escapeTagText(truncateLine(line, contentWidth)));

  options.box.top = options.rect.top;
  options.box.left = options.rect.left;
  options.box.width = options.rect.width;
  options.box.height = options.rect.height;
  options.box.setLabel(
    `${isFocused ? `[${options.theme.focusMarker}]` : "[ ]"} ${TUI_ROLE_LABELS[options.role]}`,
  );
  options.box.setContent(lines.join("\n"));
  if (options.theme.capabilities.colorMode !== "none") {
    options.box.style = isFocused
      ? {
          border: { fg: options.theme.accentColor },
          fg: options.theme.mutedColor,
        }
      : {
          border: { fg: options.theme.mutedColor },
          fg: options.theme.mutedColor,
        };
  }
  options.box.show();
}

export function hideRolePanelWidget(box: BlessedBox): void {
  box.hide();
}

function truncateLine(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  return width <= 3 ? value.slice(0, width) : `${value.slice(0, width - 3)}...`;
}

function escapeTagText(value: string): string {
  return value.replace(/[{}]/gu, (character) =>
    character === "{" ? "{open}" : "{close}",
  );
}
