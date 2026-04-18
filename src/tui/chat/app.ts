import type { RunResult } from "../../types/run.js";
import type {
  AgentChatSession,
  AgentChatSessionSnapshot,
} from "../../runtime/agent-chat-session.js";
import {
  createBlessedBox,
  createBlessedScreen,
  type BlessedKey,
  type BlessedMouseData,
  type BlessedScreen,
} from "../neo-blessed.js";
import { createRenderScheduler } from "../render-scheduler.js";
import {
  createTuiTheme,
  detectTuiTerminalCapabilities,
  type TuiTheme,
} from "../theme.js";

type FocusTarget = "activity" | "composer" | "transcript";

interface ChatLayoutMetrics {
  mainWidth: number;
  screenHeight: number;
  transcriptHeight: number;
}

export interface CreateChatTuiOptions {
  errorOutput?: Pick<NodeJS.WriteStream, "write"> | undefined;
  input?: NodeJS.ReadStream | undefined;
  output?: NodeJS.WriteStream | undefined;
  session: AgentChatSession;
}

export interface ChatTuiController {
  start(): void;
  waitUntilStopped(): Promise<RunResult>;
}

export function createChatTuiController(
  options: CreateChatTuiOptions,
): ChatTuiController {
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  const capabilities = detectTuiTerminalCapabilities({ output });
  const theme = createTuiTheme(capabilities);
  const screen = createBlessedScreen({
    autoPadding: false,
    fullUnicode: capabilities.unicode,
    input,
    output,
    smartCSR: true,
    title: `blueprint chat ${options.session.dossier.paths.runId}`,
  });

  return createChatTuiApp({
    errorOutput: options.errorOutput ?? process.stderr,
    screen,
    session: options.session,
    theme,
  });
}

function createChatTuiApp(options: {
  errorOutput: Pick<NodeJS.WriteStream, "write">;
  screen: BlessedScreen;
  session: AgentChatSession;
  theme: TuiTheme;
}): ChatTuiController {
  const transcriptBox = createBlessedBox({
    border: "line",
    parent: options.screen,
    tags: true,
  });
  const composerBox = createBlessedBox({
    border: "line",
    parent: options.screen,
    tags: true,
  });
  const activityBox = createBlessedBox({
    border: "line",
    parent: options.screen,
    tags: true,
  });
  const helpBox = createBlessedBox({
    border: "line",
    hidden: true,
    parent: options.screen,
    tags: true,
  });
  let composer = "";
  let focus: FocusTarget = "composer";
  let helpOpen = false;
  let started = false;
  let stopped = false;
  let transcriptOffset = 0;
  let activityOffset = 0;
  let latestLayout: ChatLayoutMetrics | undefined;
  let resolveStopped: ((result: RunResult) => void) | undefined;
  let rejectStopped: ((error: unknown) => void) | undefined;
  let latestSnapshot = options.session.getSnapshot();
  const scheduler = createRenderScheduler({
    onError(error) {
      reportFatalError("render failed", error);
    },
    render: () => {
      renderScreen();
    },
  });
  const stoppedPromise = new Promise<RunResult>((resolve, reject) => {
    resolveStopped = resolve;
    rejectStopped = reject;
  });
  const unsubscribe = options.session.subscribe((snapshot) => {
    latestSnapshot = snapshot;
    scheduler.markDirty();
  });

  options.screen.on("resize", () => {
    scheduler.markDirty();
  });
  options.screen.on("mouse", (data) => {
    try {
      if (handleMouse(data)) {
        scheduler.markDirty();
      }
    } catch (error) {
      reportFatalError("mouse handling failed", error);
    }
  });
  options.screen.on("keypress", (character, key) => {
    try {
      handleKeypress(character, key);
    } catch (error) {
      reportFatalError("keyboard handling failed", error);
    }
  });

  return {
    start() {
      if (started) {
        return;
      }

      started = true;

      options.session
        .start()
        .then(() => {
          scheduler.markDirty();
          scheduler.flush();
        })
        .catch((error) => {
          void teardown("failed", error);
        });
    },
    async waitUntilStopped(): Promise<RunResult> {
      return stoppedPromise;
    },
  };

  function handleKeypress(character: string, key: BlessedKey): void {
    if (handleScrollKey(key)) {
      scheduler.markDirty();
      return;
    }

    if (key.name === "tab") {
      focus = nextFocus(focus);
      scheduler.markDirty();
      return;
    }

    if (
      key.name === "backtab" ||
      key.full === "S-tab" ||
      (key.name === "tab" && key.shift)
    ) {
      focus = previousFocus(focus);
      scheduler.markDirty();
      return;
    }

    if (shouldToggleHelp({ character, composer, focus, helpOpen, key })) {
      helpOpen = !helpOpen;
      scheduler.markDirty();
      return;
    }

    if (helpOpen && (key.name === "escape" || key.name === "enter")) {
      helpOpen = false;
      scheduler.markDirty();
      return;
    }

    if (isCtrlC(key)) {
      if (latestSnapshot.busy) {
        options.session.cancelActiveTurn();
      } else {
        void teardown();
      }

      return;
    }

    if (focus !== "composer") {
      return;
    }

    if (key.name === "enter") {
      if (key.meta || key.full === "M-enter") {
        composer = `${composer}\n`;
      } else if (!latestSnapshot.busy) {
        void submitComposer();
      }

      scheduler.markDirty();
      return;
    }

    if (key.name === "backspace") {
      composer = composer.slice(0, -1);
      scheduler.markDirty();
      return;
    }

    if (key.name === "delete") {
      composer = "";
      scheduler.markDirty();
      return;
    }

    if (
      character.length === 1 &&
      !key.ctrl &&
      !key.meta &&
      key.name !== "return"
    ) {
      composer = `${composer}${character}`;
      scheduler.markDirty();
    }
  }

  function handleMouse(data: BlessedMouseData): boolean {
    if (helpOpen || latestLayout === undefined) {
      return false;
    }

    if (data.action === "wheelup") {
      return scrollPanel(resolveMouseScrollTarget(data, latestLayout), 1);
    }

    if (data.action === "wheeldown") {
      return scrollPanel(resolveMouseScrollTarget(data, latestLayout), -1);
    }

    return false;
  }

  function handleScrollKey(key: BlessedKey): boolean {
    if (focus === "composer" || helpOpen) {
      return false;
    }

    switch (key.name) {
      case "up":
        return scrollPanel(focus, 1);
      case "down":
        return scrollPanel(focus, -1);
      case "pageup":
        return scrollPanel(focus, getScrollStep(focus));
      case "pagedown":
        return scrollPanel(focus, -getScrollStep(focus));
      case "home":
        return scrollPanelToBoundary(focus, "oldest");
      case "end":
        return scrollPanelToBoundary(focus, "newest");
      default:
        return false;
    }
  }

  function scrollPanel(
    target: Extract<FocusTarget, "activity" | "transcript"> | undefined,
    delta: number,
  ): boolean {
    if (target === undefined || latestLayout === undefined) {
      return false;
    }

    if (target === "transcript") {
      const nextOffset = clampOffset(
        transcriptOffset + delta,
        0,
        getMaxTranscriptOffset(latestSnapshot, latestLayout),
      );
      if (nextOffset === transcriptOffset) {
        return false;
      }
      transcriptOffset = nextOffset;
      return true;
    }

    const nextOffset = clampOffset(
      activityOffset + delta,
      0,
      getMaxActivityOffset(latestSnapshot, latestLayout),
    );
    if (nextOffset === activityOffset) {
      return false;
    }
    activityOffset = nextOffset;
    return true;
  }

  function scrollPanelToBoundary(
    target: Extract<FocusTarget, "activity" | "transcript">,
    boundary: "newest" | "oldest",
  ): boolean {
    if (latestLayout === undefined) {
      return false;
    }

    const nextOffset =
      boundary === "oldest"
        ? target === "transcript"
          ? getMaxTranscriptOffset(latestSnapshot, latestLayout)
          : getMaxActivityOffset(latestSnapshot, latestLayout)
        : 0;

    if (target === "transcript") {
      if (nextOffset === transcriptOffset) {
        return false;
      }
      transcriptOffset = nextOffset;
      return true;
    }

    if (nextOffset === activityOffset) {
      return false;
    }
    activityOffset = nextOffset;
    return true;
  }

  async function submitComposer(): Promise<void> {
    const text = composer.trim();

    if (text.length === 0) {
      return;
    }

    if (text === "/help") {
      helpOpen = true;
      composer = "";
      return;
    }

    if (text === "/exit") {
      composer = "";
      await teardown();
      return;
    }

    if (text === "/cancel") {
      composer = "";
      options.session.cancelActiveTurn();
      return;
    }

    composer = "";
    scheduler.markDirty();
    try {
      await options.session.submitUserMessage(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.errorOutput.write(`${message}\n`);
    }
  }

  async function teardown(
    status?: RunResult["status"],
    cause?: unknown,
  ): Promise<void> {
    if (stopped) {
      return;
    }

    stopped = true;
    unsubscribe();
    scheduler.destroy();

    try {
      const result = await options.session.close(status);
      options.screen.destroy();
      resolveStopped?.(result);
    } catch (error) {
      options.screen.destroy();
      rejectStopped?.(cause ?? error);
    }
  }

  function reportFatalError(context: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    options.errorOutput.write(
      `Chat TUI disabled after ${context}. Terminal state was restored. ${message}\n`,
    );
    void teardown("failed", error);
  }

  function renderScreen(): void {
    const screenWidth = options.screen.width;
    const screenHeight = options.screen.height;
    const activityWidth = Math.max(28, Math.floor(screenWidth * 0.28));
    const mainWidth = Math.max(40, screenWidth - activityWidth);
    const composerHeight = Math.max(7, Math.floor(screenHeight * 0.24));
    const transcriptHeight = Math.max(8, screenHeight - composerHeight);
    latestLayout = {
      mainWidth,
      screenHeight,
      transcriptHeight,
    };
    transcriptOffset = clampOffset(
      transcriptOffset,
      0,
      getMaxTranscriptOffset(latestSnapshot, latestLayout),
    );
    activityOffset = clampOffset(
      activityOffset,
      0,
      getMaxActivityOffset(latestSnapshot, latestLayout),
    );

    transcriptBox.left = 0;
    transcriptBox.top = 0;
    transcriptBox.width = mainWidth;
    transcriptBox.height = transcriptHeight;
    transcriptBox.setLabel(
      ` ${focus === "transcript" ? "*" : " "} Transcript `,
    );
    transcriptBox.setContent(
      renderTranscript(
        latestSnapshot,
        options.theme,
        getTranscriptVisibleCount(transcriptHeight),
        transcriptOffset,
      ),
    );
    transcriptBox.style = getPanelStyle(options.theme, focus === "transcript");

    composerBox.left = 0;
    composerBox.top = transcriptHeight;
    composerBox.width = mainWidth;
    composerBox.height = composerHeight;
    composerBox.setLabel(` ${focus === "composer" ? "*" : " "} Composer `);
    composerBox.setContent(
      renderComposer(composer, latestSnapshot, options.theme),
    );
    composerBox.style = getPanelStyle(options.theme, focus === "composer");

    activityBox.left = mainWidth;
    activityBox.top = 0;
    activityBox.width = activityWidth;
    activityBox.height = screenHeight;
    activityBox.setLabel(` ${focus === "activity" ? "*" : " "} Activity `);
    activityBox.setContent(
      renderActivity(
        latestSnapshot,
        options.theme,
        getActivityVisibleLineCount(screenHeight),
        activityOffset,
      ),
    );
    activityBox.style = getPanelStyle(options.theme, focus === "activity");

    helpBox.left = Math.max(2, Math.floor(screenWidth * 0.18));
    helpBox.top = Math.max(1, Math.floor(screenHeight * 0.16));
    helpBox.width = Math.max(40, Math.floor(screenWidth * 0.64));
    helpBox.height = Math.max(12, Math.floor(screenHeight * 0.52));
    helpBox.setLabel(" Help ");
    helpBox.setContent(renderHelp(options.theme));
    helpBox.style = getPanelStyle(options.theme, false, {
      borderColor: options.theme.helpBorderColor ?? options.theme.accentColor,
    });
    if (helpOpen) {
      helpBox.show();
    } else {
      helpBox.hide();
    }

    options.screen.render();
  }
}

function renderTranscript(
  snapshot: AgentChatSessionSnapshot,
  theme: TuiTheme,
  visibleCount: number,
  offset: number,
): string {
  const visibleEntries = getVisibleTranscriptEntries(
    snapshot.transcript,
    visibleCount,
    offset,
  );

  if (visibleEntries.length === 0) {
    return [
      formatSectionHeading("No messages yet", theme),
      "Ask a repo question or request a change from the Composer panel.",
    ].join("\n");
  }

  return visibleEntries
    .map(
      (entry) =>
        `${formatRoleLabel(entry.role, theme)}\n${escapeTagText(entry.content.trim())}\n`,
    )
    .join("\n");
}

function renderComposer(
  composer: string,
  snapshot: AgentChatSessionSnapshot,
  theme: TuiTheme,
): string {
  const prompt =
    composer.length === 0
      ? "Type a repo question or request a change."
      : escapeTagText(composer);
  const hint =
    "Enter sends. Alt+Enter inserts a newline. /help shows shortcuts.";
  const status = snapshot.busy
    ? "Agent is working. Ctrl-C cancels the active turn."
    : "Ready. Enter sends your message.";

  return [
    prompt,
    "",
    formatSecondaryText(hint, theme),
    formatStatusLine(status, snapshot.busy ? "warn" : "ok", theme),
  ].join("\n");
}

function renderActivity(
  snapshot: AgentChatSessionSnapshot,
  theme: TuiTheme,
  visibleLineCount: number,
  offset: number,
): string {
  return getVisibleActivityLines(
    buildActivityLines(snapshot, theme),
    visibleLineCount,
    offset,
  ).join("\n");
}

function renderHelp(theme: TuiTheme): string {
  return [
    formatSectionHeading("Local commands", theme),
    "/help",
    "/exit",
    "/cancel",
    "",
    formatSectionHeading("Keybindings", theme),
    "Enter submits when idle.",
    "Alt+Enter inserts a newline.",
    "Ctrl-C cancels the active turn, or exits when idle.",
    "Tab moves focus across transcript, composer, and activity.",
  ].join("\n");
}

function getPanelTextColor(theme: TuiTheme): string | undefined {
  return theme.mutedColor ?? theme.chromeForeground;
}

function getPanelStyle(
  theme: TuiTheme,
  focused: boolean,
  options?: { borderColor?: string | undefined },
): {
  bg?: string | undefined;
  border: { fg?: string | undefined };
  fg?: string | undefined;
} {
  return {
    bg: theme.capabilities.colorMode === "none" ? undefined : "black",
    border: {
      fg:
        options?.borderColor ??
        (focused ? theme.accentColor : theme.mutedColor),
    },
    fg: getPanelTextColor(theme),
  };
}

function formatKeyValueLine(
  label: string,
  value: string,
  theme: TuiTheme,
): string {
  return `${formatSectionHeading(label, theme)} ${escapeTagText(value)}`;
}

function formatRoleLabel(role: string, theme: TuiTheme): string {
  const color =
    role === "assistant"
      ? "green"
      : role === "system"
        ? "yellow"
        : (theme.accentColor ?? "cyan");

  return applyColor(
    theme,
    `{bold}${escapeTagText(role.toUpperCase())}{/bold}`,
    color,
  );
}

function formatSecondaryText(text: string, theme: TuiTheme): string {
  return applyColor(theme, escapeTagText(text), theme.accentColor ?? "cyan");
}

function formatSectionHeading(text: string, theme: TuiTheme): string {
  return applyColor(
    theme,
    `{bold}${escapeTagText(text)}{/bold}`,
    theme.accentColor ?? "cyan",
  );
}

function formatStatusLine(
  text: string,
  tone: "ok" | "warn",
  theme: TuiTheme,
): string {
  const color = tone === "warn" ? "yellow" : "green";
  return applyColor(theme, escapeTagText(text), color);
}

function applyColor(theme: TuiTheme, text: string, color: string): string {
  if (theme.capabilities.colorMode === "none") {
    return text;
  }

  return `{${color}-fg}${text}{/${color}-fg}`;
}

function escapeTagText(value: string): string {
  return value.replace(/[{}]/gu, (character) =>
    character === "{" ? "{open}" : "{close}",
  );
}

function getVisibleTranscriptEntries(
  transcript: AgentChatSessionSnapshot["transcript"],
  visibleCount: number,
  offset: number,
): AgentChatSessionSnapshot["transcript"] {
  const clampedVisibleCount = Math.max(1, visibleCount);
  const endIndex = Math.max(0, transcript.length - offset);
  const startIndex = Math.max(0, endIndex - clampedVisibleCount);
  return transcript.slice(startIndex, endIndex);
}

function buildActivityLines(
  snapshot: AgentChatSessionSnapshot,
  theme: TuiTheme,
): string[] {
  const recentLines =
    snapshot.activity.recent.length === 0
      ? ["No activity yet."]
      : snapshot.activity.recent.map((entry) => {
          const prefix =
            entry.level === "error"
              ? "ERROR"
              : entry.level === "warn"
                ? "WARN"
                : "INFO";
          return `[${entry.timestamp.slice(11, 19)}] ${prefix} ${escapeTagText(entry.text)}`;
        });

  return [
    formatKeyValueLine("Run", snapshot.runId, theme),
    formatKeyValueLine("State", snapshot.busy ? "Working" : "Idle", theme),
    formatKeyValueLine("Tool", snapshot.activity.currentTool ?? "none", theme),
    formatKeyValueLine(
      "Command",
      snapshot.activity.currentCommand ?? "none",
      theme,
    ),
    formatKeyValueLine("Check", snapshot.activity.latestCheck ?? "none", theme),
    formatKeyValueLine("Git", snapshot.activity.gitSummary, theme),
    "",
    formatSectionHeading("Recent", theme),
    ...recentLines,
    "",
    formatSectionHeading("Keys", theme),
    "Enter send message",
    "Alt+Enter newline",
    "Ctrl-C cancel turn or exit",
    "Tab cycle focus",
    "? toggle help",
  ];
}

function getVisibleActivityLines(
  lines: readonly string[],
  visibleLineCount: number,
  offset: number,
): readonly string[] {
  const clampedVisibleLineCount = Math.max(1, visibleLineCount);
  const endIndex = Math.max(0, lines.length - offset);
  const startIndex = Math.max(0, endIndex - clampedVisibleLineCount);
  return lines.slice(startIndex, endIndex);
}

function resolveMouseScrollTarget(
  data: BlessedMouseData,
  layout: ChatLayoutMetrics,
): Extract<FocusTarget, "activity" | "transcript"> | undefined {
  if (data.x >= layout.mainWidth) {
    return "activity";
  }

  if (data.y < layout.transcriptHeight) {
    return "transcript";
  }

  return undefined;
}

function getTranscriptVisibleCount(transcriptHeight: number): number {
  return Math.max(4, transcriptHeight - 6);
}

function getActivityVisibleLineCount(screenHeight: number): number {
  return Math.max(6, screenHeight - 2);
}

function getScrollStep(
  target: Extract<FocusTarget, "activity" | "transcript">,
): number {
  return target === "transcript" ? 4 : 8;
}

function getMaxTranscriptOffset(
  snapshot: AgentChatSessionSnapshot,
  layout: ChatLayoutMetrics,
): number {
  return Math.max(
    0,
    snapshot.transcript.length -
      getTranscriptVisibleCount(layout.transcriptHeight),
  );
}

function getMaxActivityOffset(
  snapshot: AgentChatSessionSnapshot,
  layout: ChatLayoutMetrics,
): number {
  return Math.max(
    0,
    buildActivityLines(snapshot, MEASUREMENT_THEME).length -
      getActivityVisibleLineCount(layout.screenHeight),
  );
}

function clampOffset(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const MEASUREMENT_THEME: TuiTheme = {
  capabilities: {
    colorMode: "none",
    unicode: true,
  },
  focusMarker: "*",
};

function nextFocus(current: FocusTarget): FocusTarget {
  switch (current) {
    case "transcript":
      return "composer";
    case "composer":
      return "activity";
    case "activity":
      return "transcript";
  }
}

function previousFocus(current: FocusTarget): FocusTarget {
  switch (current) {
    case "transcript":
      return "activity";
    case "composer":
      return "transcript";
    case "activity":
      return "composer";
  }
}

function isCtrlC(key: BlessedKey): boolean {
  return key.full === "C-c" || (key.ctrl === true && key.name === "c");
}

function isHelpKey(character: string, key: BlessedKey): boolean {
  return (
    character === "?" ||
    key.full === "?" ||
    key.full === "S-/" ||
    (key.name === "/" && key.shift === true)
  );
}

function shouldToggleHelp(options: {
  character: string;
  composer: string;
  focus: FocusTarget;
  helpOpen: boolean;
  key: BlessedKey;
}): boolean {
  if (!isHelpKey(options.character, options.key)) {
    return false;
  }

  if (options.helpOpen || options.focus !== "composer") {
    return true;
  }

  return options.composer.length === 0;
}
