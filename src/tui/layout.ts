import type { TuiPaneId, TuiState } from "./state.js";

export interface TuiRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface TuiPaneLayout {
  pane: TuiPaneId;
  rect: TuiRect;
  visible: boolean;
}

export interface TuiLayout {
  helpModal: TuiRect;
  mode: "maximized" | "stacked" | "wide";
  panes: Record<TuiPaneId, TuiPaneLayout>;
  statusBar: TuiRect;
}

export interface ComputeTuiLayoutOptions {
  height: number;
  state: Pick<TuiState, "maximizedPane">;
  width: number;
}

const WIDE_LAYOUT_ORDER: readonly TuiPaneId[][] = [
  ["architect", "engineer"],
  ["tasks", "log"],
  ["diff", "tests"],
];

export function computeTuiLayout(options: ComputeTuiLayoutOptions): TuiLayout {
  const width = Math.max(40, options.width);
  const height = Math.max(8, options.height);
  const statusBar: TuiRect = {
    height: 1,
    left: 0,
    top: height - 1,
    width,
  };
  const paneAreaHeight = Math.max(1, height - statusBar.height);

  if (options.state.maximizedPane !== null) {
    return {
      helpModal: createHelpModalRect(width, height),
      mode: "maximized",
      panes: createMaximizedPaneLayout(
        width,
        paneAreaHeight,
        options.state.maximizedPane,
      ),
      statusBar,
    };
  }

  if (width >= 120) {
    return {
      helpModal: createHelpModalRect(width, height),
      mode: "wide",
      panes: createWidePaneLayout(width, paneAreaHeight),
      statusBar,
    };
  }

  return {
    helpModal: createHelpModalRect(width, height),
    mode: "stacked",
    panes: createStackedPaneLayout(width, paneAreaHeight),
    statusBar,
  };
}

function createWidePaneLayout(
  width: number,
  paneAreaHeight: number,
): Record<TuiPaneId, TuiPaneLayout> {
  const columnWidths = splitDimension(width, 2);
  const rowHeights = splitDimension(paneAreaHeight, 3);
  const panes = createHiddenPaneLayouts(width, paneAreaHeight);
  let currentTop = 0;

  for (let rowIndex = 0; rowIndex < WIDE_LAYOUT_ORDER.length; rowIndex += 1) {
    const row = WIDE_LAYOUT_ORDER[rowIndex]!;
    const rowHeight = rowHeights[rowIndex]!;
    let currentLeft = 0;

    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      const pane = row[columnIndex]!;
      const columnWidth = columnWidths[columnIndex]!;

      panes[pane] = {
        pane,
        rect: {
          height: rowHeight,
          left: currentLeft,
          top: currentTop,
          width: columnWidth,
        },
        visible: true,
      };
      currentLeft += columnWidth;
    }

    currentTop += rowHeight;
  }

  return panes;
}

function createStackedPaneLayout(
  width: number,
  paneAreaHeight: number,
): Record<TuiPaneId, TuiPaneLayout> {
  const rowHeights = splitDimension(paneAreaHeight, 6);
  const panes = createHiddenPaneLayouts(width, paneAreaHeight);
  let currentTop = 0;

  for (let index = 0; index < rowHeights.length; index += 1) {
    const pane = WIDE_LAYOUT_ORDER.flat()[index]!;
    const rowHeight = rowHeights[index]!;

    panes[pane] = {
      pane,
      rect: {
        height: rowHeight,
        left: 0,
        top: currentTop,
        width,
      },
      visible: true,
    };
    currentTop += rowHeight;
  }

  return panes;
}

function createMaximizedPaneLayout(
  width: number,
  paneAreaHeight: number,
  maximizedPane: TuiPaneId,
): Record<TuiPaneId, TuiPaneLayout> {
  const panes = createHiddenPaneLayouts(width, paneAreaHeight);

  panes[maximizedPane] = {
    pane: maximizedPane,
    rect: {
      height: paneAreaHeight,
      left: 0,
      top: 0,
      width,
    },
    visible: true,
  };

  return panes;
}

function createHiddenPaneLayouts(
  width: number,
  paneAreaHeight: number,
): Record<TuiPaneId, TuiPaneLayout> {
  return {
    architect: createHiddenPaneLayout("architect", width, paneAreaHeight),
    diff: createHiddenPaneLayout("diff", width, paneAreaHeight),
    engineer: createHiddenPaneLayout("engineer", width, paneAreaHeight),
    log: createHiddenPaneLayout("log", width, paneAreaHeight),
    tasks: createHiddenPaneLayout("tasks", width, paneAreaHeight),
    tests: createHiddenPaneLayout("tests", width, paneAreaHeight),
  };
}

function createHiddenPaneLayout(
  pane: TuiPaneId,
  width: number,
  paneAreaHeight: number,
): TuiPaneLayout {
  return {
    pane,
    rect: {
      height: paneAreaHeight,
      left: 0,
      top: 0,
      width,
    },
    visible: false,
  };
}

function createHelpModalRect(width: number, height: number): TuiRect {
  const modalWidth = Math.min(
    width - 4,
    Math.max(48, Math.floor(width * 0.72)),
  );
  const modalHeight = Math.min(
    height - 2,
    Math.max(10, Math.floor(height * 0.6)),
  );

  return {
    height: modalHeight,
    left: Math.max(0, Math.floor((width - modalWidth) / 2)),
    top: Math.max(0, Math.floor((height - modalHeight) / 2)),
    width: modalWidth,
  };
}

function splitDimension(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const remainder = total % parts;
  const sizes = Array.from({ length: parts }, () => base);

  for (let index = 0; index < remainder; index += 1) {
    sizes[index] = (sizes[index] ?? 0) + 1;
  }

  return sizes;
}
