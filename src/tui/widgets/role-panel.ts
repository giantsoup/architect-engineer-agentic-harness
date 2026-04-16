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
    role: options.role,
    state: options.state,
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
  role: TuiRoleId;
  state: TuiState;
}): readonly string[] {
  const sections = ROLE_SECTION_ORDER[options.role];
  const weights = ROLE_SECTION_WEIGHTS[options.role];
  const contentBudgets = allocateSectionBudgets(options.contentHeight, weights);
  const blocks = sections.map((section, index) =>
    buildSectionBlock({
      lines: getSectionLines(options.state, section),
      maxLines: contentBudgets[index] ?? 1,
      role: options.role,
      section,
      state: options.state,
    }),
  );

  const lines = blocks.flatMap((block, index) =>
    index === blocks.length - 1 ? block : [...block, ""],
  );

  return lines.slice(0, options.contentHeight);
}

function buildSectionBlock(options: {
  lines: readonly string[];
  maxLines: number;
  role: TuiRoleId;
  section: TuiSectionId;
  state: TuiState;
}): readonly string[] {
  const excerpt = excerptSectionLines(options);

  return [
    SECTION_LABELS[options.section],
    ...excerpt.map((line) => `  ${line}`),
  ];
}

function excerptSectionLines(options: {
  lines: readonly string[];
  maxLines: number;
  role: TuiRoleId;
  section: TuiSectionId;
  state: TuiState;
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
