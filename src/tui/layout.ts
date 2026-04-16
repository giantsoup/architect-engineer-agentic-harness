import type { TuiRoleId, TuiState } from "./state.js";

export interface TuiRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface TuiRoleLayout {
  rect: TuiRect;
  role: TuiRoleId;
  visible: boolean;
}

export interface TuiLayout {
  footer: TuiRect;
  header: TuiRect;
  helpModal: TuiRect;
  mode: "narrow" | "wide";
  roles: Record<TuiRoleId, TuiRoleLayout>;
}

export interface ComputeTuiLayoutOptions {
  height: number;
  state: Pick<TuiState, "focusRole">;
  width: number;
}

const HEADER_HEIGHT = 1;
const FOOTER_HEIGHT = 1;
const MIN_WIDE_HEIGHT = 18;
const MIN_WIDE_WIDTH = 100;
const ARCHITECT_RATIO = 0.4;
const WIDE_PANEL_GAP = 2;

export function computeTuiLayout(options: ComputeTuiLayoutOptions): TuiLayout {
  const width = Math.max(1, options.width);
  const height = Math.max(3, options.height);
  const header: TuiRect = {
    height: HEADER_HEIGHT,
    left: 0,
    top: 0,
    width,
  };
  const footer: TuiRect = {
    height: FOOTER_HEIGHT,
    left: 0,
    top: height - FOOTER_HEIGHT,
    width,
  };
  const bodyTop = header.height;
  const bodyHeight = Math.max(1, height - header.height - footer.height);
  const mode =
    width >= MIN_WIDE_WIDTH && height >= MIN_WIDE_HEIGHT ? "wide" : "narrow";

  return {
    footer,
    header,
    helpModal: createHelpModalRect(width, height),
    mode,
    roles:
      mode === "wide"
        ? createWideRoleLayout(width, bodyTop, bodyHeight)
        : createNarrowRoleLayout(
            width,
            bodyTop,
            bodyHeight,
            options.state.focusRole,
          ),
  };
}

function createWideRoleLayout(
  width: number,
  top: number,
  height: number,
): Record<TuiRoleId, TuiRoleLayout> {
  const availableWidth = Math.max(2, width - WIDE_PANEL_GAP);
  const architectWidth = Math.max(
    1,
    Math.floor(availableWidth * ARCHITECT_RATIO),
  );
  const engineerWidth = Math.max(1, availableWidth - architectWidth);

  return {
    architect: {
      rect: {
        height,
        left: 0,
        top,
        width: architectWidth,
      },
      role: "architect",
      visible: true,
    },
    engineer: {
      rect: {
        height,
        left: architectWidth + WIDE_PANEL_GAP,
        top,
        width: engineerWidth,
      },
      role: "engineer",
      visible: true,
    },
  };
}

function createNarrowRoleLayout(
  width: number,
  top: number,
  height: number,
  focusRole: TuiRoleId,
): Record<TuiRoleId, TuiRoleLayout> {
  return {
    architect: createNarrowRole("architect", width, top, height, focusRole),
    engineer: createNarrowRole("engineer", width, top, height, focusRole),
  };
}

function createNarrowRole(
  role: TuiRoleId,
  width: number,
  top: number,
  height: number,
  focusRole: TuiRoleId,
): TuiRoleLayout {
  return {
    rect: {
      height,
      left: 0,
      top,
      width,
    },
    role,
    visible: focusRole === role,
  };
}

function createHelpModalRect(width: number, height: number): TuiRect {
  const modalWidth = Math.min(
    Math.max(1, width - 4),
    Math.max(18, Math.floor(width * 0.72)),
  );
  const modalHeight = Math.min(
    Math.max(1, height - 2),
    Math.max(8, Math.floor(height * 0.6)),
  );

  return {
    height: modalHeight,
    left: Math.max(0, Math.floor((width - modalWidth) / 2)),
    top: Math.max(0, Math.floor((height - modalHeight) / 2)),
    width: modalWidth,
  };
}
