import type { TuiAction, TuiState } from "./state.js";

export interface TuiKeyboardKey {
  ctrl?: boolean | undefined;
  full?: string | undefined;
  name?: string | undefined;
  sequence?: string | undefined;
  shift?: boolean | undefined;
}

export type TuiKeyboardCommand =
  | { action: TuiAction; type: "dispatch" }
  | { type: "none" }
  | { type: "quit" }
  | { type: "stop-run" };

export function resolveTuiKeyboardCommand(
  state: Pick<TuiState, "demoMode" | "runActive" | "runStopRequested">,
  key: TuiKeyboardKey,
): TuiKeyboardCommand {
  const full = key.full ?? key.sequence ?? key.name ?? "";
  const isHelpKey =
    full === "?" ||
    full === "S-/" ||
    key.sequence === "?" ||
    (key.name === "/" && key.shift);

  if (full === "C-c" || (key.ctrl && key.name === "c") || key.name === "q") {
    return { type: "quit" };
  }

  if (
    full === "S-tab" ||
    key.name === "backtab" ||
    (key.name === "tab" && key.shift)
  ) {
    return {
      action: { type: "focus.previous" },
      type: "dispatch",
    };
  }

  if (key.name === "tab") {
    return {
      action: { type: "focus.next" },
      type: "dispatch",
    };
  }

  switch (key.name) {
    case "s":
      if (!state.demoMode && state.runActive && !state.runStopRequested) {
        return { type: "stop-run" };
      }
      break;
    default:
      break;
  }

  if (isHelpKey) {
    return {
      action: { type: "help.toggle" },
      type: "dispatch",
    };
  }

  return { type: "none" };
}
