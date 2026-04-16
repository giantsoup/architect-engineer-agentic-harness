import type { BlessedBox } from "../neo-blessed.js";
import type { TuiRect } from "../layout.js";
import type {
  TuiLogEntry,
  TuiPaneId,
  TuiQueueItem,
  TuiState,
} from "../state.js";
import {
  formatQueueStatusLabel,
  TUI_PANE_LABELS,
  type TuiTheme,
} from "../theme.js";

export function renderPaneWidget(options: {
  box: BlessedBox;
  pane: TuiPaneId;
  rect: TuiRect;
  state: TuiState;
  theme: TuiTheme;
}): void {
  const isFocused = options.state.focusPane === options.pane;
  const isMaximized = options.state.maximizedPane === options.pane;
  const contentHeight = Math.max(1, options.rect.height - 2);
  const lines = getPaneLines(options.state, options.pane);
  const content = sliceLinesForPane({
    contentHeight,
    followMode: options.state.followMode,
    lines,
    pane: options.pane,
    queueItems: options.state.queueItems,
    queueSelection: options.state.queueSelection,
    scrollOffset: options.state.paneScroll[options.pane],
  });

  options.box.top = options.rect.top;
  options.box.left = options.rect.left;
  options.box.width = options.rect.width;
  options.box.height = options.rect.height;
  options.box.setLabel(
    `${isFocused ? `[${options.theme.focusMarker}]` : "[ ]"} [${paneShortcut(options.pane)}] ${TUI_PANE_LABELS[options.pane]}${isMaximized ? " [MAX]" : ""}`,
  );
  options.box.setContent(content.join("\n"));
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

export function hidePaneWidget(box: BlessedBox): void {
  box.hide();
}

function getPaneLines(state: TuiState, pane: TuiPaneId): readonly string[] {
  switch (pane) {
    case "log":
      return formatLogLines(state.log.entries, state.log.dropped);
    case "tasks":
      return formatQueueLines(state.queueItems, state.queueSelection);
    default:
      return state.panes[pane].lines;
  }
}

function formatQueueLines(
  queueItems: readonly TuiQueueItem[],
  queueSelection: number,
): readonly string[] {
  return queueItems.map((item, index) => {
    const selected = index === queueSelection ? ">" : " ";
    const detail = item.detail === undefined ? "" : ` - ${item.detail}`;

    return `${selected} [${formatQueueStatusLabel(item.status)}] ${item.title}${detail}`;
  });
}

function formatLogLines(
  entries: readonly TuiLogEntry[],
  dropped: number,
): readonly string[] {
  const lines =
    dropped > 0
      ? [`(${dropped} older log entries dropped to keep the buffer bounded)`]
      : [];

  return [
    ...lines,
    ...entries.map(
      (entry) =>
        `${formatClock(entry.timestamp)} ${entry.source.padEnd(9, " ")} ${entry.level.toUpperCase()} ${entry.summary}`,
    ),
  ];
}

function sliceLinesForPane(options: {
  contentHeight: number;
  followMode: boolean;
  lines: readonly string[];
  pane: TuiPaneId;
  queueItems: readonly TuiQueueItem[];
  queueSelection: number;
  scrollOffset: number;
}): readonly string[] {
  if (options.lines.length <= options.contentHeight) {
    return options.lines;
  }

  if (options.pane === "tasks") {
    const start = Math.max(
      0,
      Math.min(
        options.queueSelection,
        options.queueItems.length - options.contentHeight,
      ),
    );

    return options.lines.slice(start, start + options.contentHeight);
  }

  const maxStart = Math.max(0, options.lines.length - options.contentHeight);
  const start =
    options.pane === "log" && options.followMode
      ? maxStart
      : Math.min(options.scrollOffset, maxStart);

  return options.lines.slice(start, start + options.contentHeight);
}

function paneShortcut(pane: TuiPaneId): number {
  switch (pane) {
    case "architect":
      return 1;
    case "engineer":
      return 2;
    case "tasks":
      return 3;
    case "log":
      return 4;
    case "diff":
      return 5;
    case "tests":
      return 6;
  }
}

function formatClock(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString().slice(11, 19);
}
