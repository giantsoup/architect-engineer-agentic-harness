import type { BlessedBox } from "../neo-blessed.js";
import type { TuiRect } from "../layout.js";
import type {
  TuiQueueItem,
  TuiRoleId,
  TuiSectionId,
  TuiState,
} from "../state.js";
import {
  formatQueueStatusLabel,
  TUI_ROLE_LABELS,
  type TuiTheme,
} from "../theme.js";

const SECTION_LABELS: Record<TuiSectionId, string> = {
  activeCommand: "Active Command",
  currentGoal: "Current Goal",
  executionLog: "Execution Log",
  reasoningHistory: "Reasoning History",
  taskQueue: "Task Queue",
  testsChecks: "Tests / Checks",
};

const ROLE_SECTION_ORDER: Record<TuiRoleId, readonly TuiSectionId[]> = {
  architect: ["currentGoal", "reasoningHistory", "taskQueue"],
  engineer: ["executionLog", "activeCommand", "testsChecks"],
};

const ROLE_SECTION_WEIGHTS: Record<TuiRoleId, readonly number[]> = {
  architect: [6, 5, 8],
  engineer: [8, 5, 6],
};

export function renderRolePanelWidget(options: {
  box: BlessedBox;
  rect: TuiRect;
  role: TuiRoleId;
  state: TuiState;
  theme: TuiTheme;
}): void {
  const isFocused = options.state.focusRole === options.role;
  const contentHeight = Math.max(1, options.rect.height - 2);
  const content = buildRolePanelLines({
    contentHeight,
    contentWidth: Math.max(1, options.rect.width - 2),
    role: options.role,
    state: options.state,
    theme: options.theme,
  });

  options.box.top = options.rect.top;
  options.box.left = options.rect.left;
  options.box.width = options.rect.width;
  options.box.height = options.rect.height;
  options.box.setLabel(
    `${isFocused ? `[${options.theme.focusMarker}]` : "[ ]"} ${TUI_ROLE_LABELS[options.role]}`,
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

export function hideRolePanelWidget(box: BlessedBox): void {
  box.hide();
}

function buildRolePanelLines(options: {
  contentHeight: number;
  contentWidth: number;
  role: TuiRoleId;
  state: TuiState;
  theme: TuiTheme;
}): readonly string[] {
  const sections = ROLE_SECTION_ORDER[options.role];
  const weights = ROLE_SECTION_WEIGHTS[options.role];
  const contentBudgets = allocateSectionBudgets(options.contentHeight, weights);
  const blocks = sections.map((section, index) =>
    buildSectionBlock({
      contentWidth: options.contentWidth,
      lines: getSectionLines(options.state, section),
      maxLines: contentBudgets[index] ?? 1,
      role: options.role,
      section,
      state: options.state,
      theme: options.theme,
    }),
  );

  const lines = blocks.flatMap((block, index) =>
    index === blocks.length - 1 ? block : [...block, ""],
  );

  return lines.slice(0, options.contentHeight);
}

function buildSectionBlock(options: {
  contentWidth: number;
  lines: readonly string[];
  maxLines: number;
  role: TuiRoleId;
  section: TuiSectionId;
  state: TuiState;
  theme: TuiTheme;
}): readonly string[] {
  const excerpt = excerptSectionLines(options);
  const wrappedExcerpt = excerpt.flatMap((line) =>
    wrapPanelLine(line, Math.max(1, options.contentWidth - 2)),
  );

  return [
    formatSectionHeading(SECTION_LABELS[options.section], options.theme),
    ...wrappedExcerpt.map((line) => `  ${escapeTagText(line)}`),
  ];
}

function excerptSectionLines(options: {
  lines: readonly string[];
  maxLines: number;
  role: TuiRoleId;
  section: TuiSectionId;
  state: TuiState;
  contentWidth: number;
  theme: TuiTheme;
}): readonly string[] {
  const lines =
    options.lines.length > 0
      ? options.lines
      : ["No content available for this section yet."];

  if (lines.length <= options.maxLines) {
    return lines;
  }

  switch (options.section) {
    case "taskQueue":
      return sliceScrollableLines(
        lines,
        options.maxLines,
        options.state.roleScroll.architect,
      );
    case "executionLog":
      return sliceScrollableLines(
        lines,
        options.maxLines,
        options.state.roleScroll.engineer,
        options.state.followMode,
      );
    default:
      return sliceHeadWithOverflowNotice(lines, options.maxLines);
  }
}

function getSectionLines(
  state: TuiState,
  section: TuiSectionId,
): readonly string[] {
  switch (section) {
    case "taskQueue":
      return formatQueueLines(state.queueItems);
    default:
      return state.sections[section].lines;
  }
}

function formatQueueLines(
  queueItems: readonly TuiQueueItem[],
): readonly string[] {
  if (queueItems.length === 0) {
    return [
      "Awaiting an engineer brief or live execution order.",
      "This section stays explicit so the dashboard never degrades into blank space.",
    ];
  }

  return queueItems.map((item) => {
    const detail = item.detail === undefined ? "" : ` - ${item.detail}`;

    return `[${formatQueueStatusLabel(item.status)}] ${item.title}${detail}`;
  });
}

function allocateSectionBudgets(
  contentHeight: number,
  weights: readonly number[],
): number[] {
  const overhead = weights.length + Math.max(0, weights.length - 1);
  const contentBudget = Math.max(weights.length, contentHeight - overhead);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const allocations = weights.map((weight) =>
    Math.max(1, Math.floor((contentBudget * weight) / totalWeight)),
  );
  let assigned = allocations.reduce((sum, count) => sum + count, 0);
  let index = 0;

  while (assigned < contentBudget) {
    allocations[index % allocations.length] =
      (allocations[index % allocations.length] ?? 1) + 1;
    assigned += 1;
    index += 1;
  }

  while (assigned > contentBudget) {
    const target = index % allocations.length;

    if ((allocations[target] ?? 1) > 1) {
      allocations[target] = (allocations[target] ?? 1) - 1;
      assigned -= 1;
    }
    index += 1;
  }

  return allocations;
}

function sliceScrollableLines(
  lines: readonly string[],
  maxLines: number,
  scrollOffset: number,
  follow = false,
): readonly string[] {
  const maxStart = Math.max(0, lines.length - maxLines);
  const start = follow ? maxStart : Math.min(scrollOffset, maxStart);

  return lines.slice(start, start + maxLines);
}

function sliceHeadWithOverflowNotice(
  lines: readonly string[],
  maxLines: number,
): readonly string[] {
  if (maxLines <= 1) {
    return [lines[0] ?? ""];
  }

  const visibleLines = lines.slice(0, maxLines - 1);
  const hiddenCount = Math.max(0, lines.length - visibleLines.length);

  return hiddenCount === 0
    ? visibleLines
    : [...visibleLines, `(${hiddenCount} more lines hidden)`];
}

function formatSectionHeading(label: string, theme: TuiTheme): string {
  const heading = label.toUpperCase();

  if (
    theme.capabilities.colorMode === "none" ||
    theme.accentColor === undefined
  ) {
    return heading;
  }

  return `{bold}{${theme.accentColor}-fg}${heading}{/${theme.accentColor}-fg}{/bold}`;
}

function wrapPanelLine(line: string, maxWidth: number): string[] {
  if (line.length === 0 || line.length <= maxWidth || maxWidth <= 1) {
    return [line];
  }

  const prefixEnd = resolveWrapPrefixEnd(line, maxWidth);
  const prefix = line.slice(0, prefixEnd);
  const continuationPrefix = " ".repeat(prefixEnd);
  const content = line.slice(prefixEnd).trimStart();

  if (content.length === 0) {
    return [line];
  }

  const words = content.split(/\s+/u);
  const wrapped: string[] = [];
  let currentPrefix = prefix;
  let currentLine = currentPrefix;

  for (const word of words) {
    const separator = currentLine.length === currentPrefix.length ? "" : " ";
    const candidate = `${currentLine}${separator}${word}`;

    if (candidate.length <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    if (currentLine.length > currentPrefix.length) {
      wrapped.push(currentLine);
      currentPrefix = continuationPrefix;
      currentLine = `${currentPrefix}${word}`;
      continue;
    }

    wrapped.push(candidate.slice(0, maxWidth));
    currentPrefix = continuationPrefix;
    currentLine = `${currentPrefix}${candidate.slice(maxWidth).trimStart()}`;
  }

  if (currentLine.length > 0) {
    wrapped.push(currentLine);
  }

  return wrapped;
}

function resolveWrapPrefixEnd(line: string, maxWidth: number): number {
  const leadingWhitespace = line.match(/^\s*/u)?.[0].length ?? 0;
  const separatorMatches = [...line.matchAll(/ {2,}/gu)];
  const lastSeparator = separatorMatches.at(-1);

  if (lastSeparator?.index === undefined) {
    return leadingWhitespace;
  }

  return Math.min(
    maxWidth - 1,
    Math.max(leadingWhitespace, lastSeparator.index + lastSeparator[0].length),
  );
}

function escapeTagText(value: string): string {
  return value.replace(/[{}]/gu, (character) =>
    character === "{" ? "{open}" : "{close}",
  );
}
