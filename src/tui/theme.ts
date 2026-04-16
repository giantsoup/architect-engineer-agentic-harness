import type { TuiPaneId, TuiQueueItemStatus } from "./state.js";

export const TUI_PANE_LABELS: Record<TuiPaneId, string> = {
  architect: "Architect",
  diff: "Diff",
  engineer: "Engineer",
  log: "Log",
  tasks: "Tasks / Queue",
  tests: "Tests",
};

export interface TuiTerminalCapabilities {
  colorMode: "ansi16" | "full" | "none";
  unicode: boolean;
}

export interface TuiTheme {
  accentColor?: string | undefined;
  capabilities: TuiTerminalCapabilities;
  chromeBackground?: string | undefined;
  chromeForeground?: string | undefined;
  focusMarker: string;
  helpBorderColor?: string | undefined;
  mutedColor?: string | undefined;
}

export interface DetectTuiTerminalCapabilitiesOptions {
  env?: NodeJS.ProcessEnv | undefined;
  output?:
    | Pick<NodeJS.WriteStream, "getColorDepth" | "hasColors" | "isTTY">
    | undefined;
  platform?: NodeJS.Platform | undefined;
}

export function detectTuiTerminalCapabilities(
  options: DetectTuiTerminalCapabilitiesOptions = {},
): TuiTerminalCapabilities {
  const env = options.env ?? process.env;
  const output = options.output;
  const platform = options.platform ?? process.platform;
  const noColorRequested =
    env.NO_COLOR !== undefined ||
    env.FORCE_COLOR === "0" ||
    env.TERM === "dumb";
  let colorMode: TuiTerminalCapabilities["colorMode"] = "full";

  if (
    noColorRequested ||
    output?.isTTY !== true ||
    output?.hasColors?.() === false
  ) {
    colorMode = "none";
  } else {
    const colorDepth = output?.getColorDepth?.(env) ?? 8;

    colorMode = colorDepth >= 8 ? "full" : colorDepth >= 4 ? "ansi16" : "none";
  }

  const locale =
    `${env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? ""}`.toLowerCase();
  const unicodeOptOut = env.AEAH_TUI_ASCII === "1";
  const unicodeFriendlyWindowsTerminal =
    env.WT_SESSION !== undefined ||
    env.TERM_PROGRAM === "vscode" ||
    env.ConEmuANSI === "ON" ||
    (env.TERM ?? "").toLowerCase().includes("xterm");
  const unicode =
    !unicodeOptOut &&
    (platform !== "win32"
      ? locale.length === 0 ||
        locale.includes("utf-8") ||
        locale.includes("utf8")
      : unicodeFriendlyWindowsTerminal);

  return {
    colorMode,
    unicode,
  };
}

export function createTuiTheme(
  capabilities: TuiTerminalCapabilities,
): TuiTheme {
  switch (capabilities.colorMode) {
    case "none":
      return {
        capabilities,
        focusMarker: "*",
      };
    case "ansi16":
      return {
        accentColor: "cyan",
        capabilities,
        chromeBackground: "blue",
        chromeForeground: "white",
        focusMarker: "*",
        helpBorderColor: "yellow",
        mutedColor: "white",
      };
    case "full":
      return {
        accentColor: "cyan",
        capabilities,
        chromeBackground: "white",
        chromeForeground: "black",
        focusMarker: "*",
        helpBorderColor: "yellow",
        mutedColor: "white",
      };
  }
}

export function formatQueueStatusLabel(status: TuiQueueItemStatus): string {
  switch (status) {
    case "active":
      return "ACTIVE";
    case "blocked":
      return "BLOCKED";
    case "done":
      return "DONE";
    case "pending":
      return "PENDING";
  }
}

export function formatThemeModeLabel(theme: TuiTheme): string {
  const colorLabel =
    theme.capabilities.colorMode === "none"
      ? "mono"
      : theme.capabilities.colorMode === "ansi16"
        ? "16c"
        : "color";

  return `${colorLabel}/${theme.capabilities.unicode ? "unicode" : "ascii"}`;
}
