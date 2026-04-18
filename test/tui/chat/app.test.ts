import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentChatSession,
  AgentChatSessionSnapshot,
} from "../../../src/runtime/agent-chat-session.js";
import { createChatTuiController } from "../../../src/tui/chat/app.js";
import type {
  BlessedBox,
  BlessedKey,
  BlessedMouseData,
  BlessedScreen,
} from "../../../src/tui/neo-blessed.js";
import type { RunResult } from "../../../src/types/run.js";

const neoBlessedMocks = vi.hoisted(() => {
  const state = {
    boxes: [] as Array<
      BlessedBox & { content: string; hidden: boolean; label: string }
    >,
    screen: undefined as FakeScreen | undefined,
  };

  return {
    createBlessedBox: vi.fn(() => {
      const box = {
        content: "",
        height: 0,
        hidden: false,
        hide() {
          this.hidden = true;
        },
        label: "",
        left: 0,
        setContent(content: string) {
          this.content = content;
        },
        setLabel(label: string) {
          this.label = label;
        },
        show() {
          this.hidden = false;
        },
        top: 0,
        width: 0,
      };

      state.boxes.push(box);
      return box;
    }),
    createBlessedScreen: vi.fn(() => {
      if (state.screen === undefined) {
        throw new Error("Expected a fake screen to be installed.");
      }

      return state.screen;
    }),
    state,
  };
});

vi.mock("../../../src/tui/neo-blessed.js", () => ({
  createBlessedBox: neoBlessedMocks.createBlessedBox,
  createBlessedScreen: neoBlessedMocks.createBlessedScreen,
}));

describe("chat tui app", () => {
  afterEach(() => {
    neoBlessedMocks.state.boxes.length = 0;
    neoBlessedMocks.state.screen = undefined;
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("opens help on a bare question mark but preserves question marks in composer input", async () => {
    vi.useFakeTimers();
    const screen = createFakeScreen();
    neoBlessedMocks.state.screen = screen;
    const { session, submitUserMessage } = createFakeSession();
    const controller = createChatTuiController({
      errorOutput: { write: vi.fn() },
      input: {} as NodeJS.ReadStream,
      output: createFakeOutput() as NodeJS.WriteStream,
      session,
    });

    controller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);

    const composerBox = neoBlessedMocks.state.boxes[1];
    const helpBox = neoBlessedMocks.state.boxes[3];

    expect(helpBox?.hidden).toBe(true);

    screen.emitKeypress("?", { full: "?", sequence: "?" });
    await vi.advanceTimersByTimeAsync(20);

    expect(helpBox?.hidden).toBe(false);

    screen.emitKeypress("?", { full: "?", sequence: "?" });
    await vi.advanceTimersByTimeAsync(20);

    expect(helpBox?.hidden).toBe(true);

    screen.emitKeypress("w", { name: "w", sequence: "w" });
    screen.emitKeypress("h", { name: "h", sequence: "h" });
    screen.emitKeypress("y", { name: "y", sequence: "y" });
    screen.emitKeypress("?", { full: "?", sequence: "?" });
    await vi.advanceTimersByTimeAsync(20);

    expect(helpBox?.hidden).toBe(true);
    expect(composerBox?.content).toContain("why?");

    screen.emitKeypress("", { name: "enter" });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);

    expect(submitUserMessage).toHaveBeenCalledOnce();
    expect(submitUserMessage).toHaveBeenCalledWith("why?");

    const stoppedPromise = controller.waitUntilStopped();
    screen.emitKeypress("", { ctrl: true, full: "C-c", name: "c" });

    await expect(stoppedPromise).resolves.toEqual({
      status: "success",
      summary: "closed",
    });
  });

  it("uses a readable foreground color for chat panels in full-color terminals", async () => {
    vi.useFakeTimers();
    const originalNoColor = process.env.NO_COLOR;
    const originalForceColor = process.env.FORCE_COLOR;
    const originalTerm = process.env.TERM;
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    process.env.TERM = "xterm-256color";

    const screen = createFakeScreen();
    neoBlessedMocks.state.screen = screen;
    const { session } = createFakeSession();
    try {
      const controller = createChatTuiController({
        errorOutput: { write: vi.fn() },
        input: {} as NodeJS.ReadStream,
        output: createFakeOutput({
          colorDepth: 8,
          hasColors: true,
        }) as NodeJS.WriteStream,
        session,
      });

      controller.start();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20);

      const transcriptBox = neoBlessedMocks.state.boxes[0];
      const composerBox = neoBlessedMocks.state.boxes[1];
      const activityBox = neoBlessedMocks.state.boxes[2];
      const helpBox = neoBlessedMocks.state.boxes[3];

      expect(transcriptBox?.style).toMatchObject({ bg: "black", fg: "white" });
      expect(composerBox?.style).toMatchObject({ bg: "black", fg: "white" });
      expect(activityBox?.style).toMatchObject({ bg: "black", fg: "white" });
      expect(helpBox?.style).toMatchObject({ bg: "black", fg: "white" });
    } finally {
      restoreEnv("NO_COLOR", originalNoColor);
      restoreEnv("FORCE_COLOR", originalForceColor);
      restoreEnv("TERM", originalTerm);
    }
  });

  it("escapes blessed tags in transcript, activity, and composer content", async () => {
    vi.useFakeTimers();
    const originalNoColor = process.env.NO_COLOR;
    const originalForceColor = process.env.FORCE_COLOR;
    const originalTerm = process.env.TERM;
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    process.env.TERM = "xterm-256color";

    const screen = createFakeScreen();
    neoBlessedMocks.state.screen = screen;
    const { session } = createFakeSession({
      activity: {
        currentCommand: "echo {hello}",
        currentTool: "tool {inspect}",
        gitSummary: "Dirty on feat/{branch}",
        latestCheck: "lint {pending}",
        recent: [
          {
            level: "warn",
            text: "stderr: {warning}",
            timestamp: "2026-04-17T18:00:00.000Z",
          },
        ],
      },
      transcript: [
        {
          content: "show me {literal} braces",
          id: "message-1",
          role: "user",
          timestamp: "2026-04-17T18:00:00.000Z",
        },
      ],
    });

    try {
      const controller = createChatTuiController({
        errorOutput: { write: vi.fn() },
        input: {} as NodeJS.ReadStream,
        output: createFakeOutput({
          colorDepth: 8,
          hasColors: true,
        }) as NodeJS.WriteStream,
        session,
      });

      controller.start();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20);

      screen.emitKeypress("{", { name: "{" });
      screen.emitKeypress("d", { name: "d" });
      screen.emitKeypress("r", { name: "r" });
      screen.emitKeypress("a", { name: "a" });
      screen.emitKeypress("f", { name: "f" });
      screen.emitKeypress("t", { name: "t" });
      screen.emitKeypress("}", { name: "}" });
      await vi.advanceTimersByTimeAsync(20);

      const transcriptBox = neoBlessedMocks.state.boxes[0];
      const composerBox = neoBlessedMocks.state.boxes[1];
      const activityBox = neoBlessedMocks.state.boxes[2];

      expect(transcriptBox?.content).toContain("{open}literal{close}");
      expect(activityBox?.content).toContain("tool {open}inspect{close}");
      expect(activityBox?.content).toContain("stderr: {open}warning{close}");
      expect(composerBox?.content).toContain("{open}draft{close}");
    } finally {
      restoreEnv("NO_COLOR", originalNoColor);
      restoreEnv("FORCE_COLOR", originalForceColor);
      restoreEnv("TERM", originalTerm);
    }
  });

  it("does not exit on wheel, escape, or paging input and scrolls transcript content", async () => {
    vi.useFakeTimers();
    const originalNoColor = process.env.NO_COLOR;
    const originalForceColor = process.env.FORCE_COLOR;
    const originalTerm = process.env.TERM;
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    process.env.TERM = "xterm-256color";

    const screen = createFakeScreen();
    neoBlessedMocks.state.screen = screen;
    const transcript = Array.from({ length: 40 }, (_, index) => ({
      content: `message ${index + 1}`,
      id: `message-${index + 1}`,
      role: "user" as const,
      timestamp: "2026-04-17T18:00:00.000Z",
    }));
    const { close, session } = createFakeSession({ transcript });

    try {
      const controller = createChatTuiController({
        errorOutput: { write: vi.fn() },
        input: {} as NodeJS.ReadStream,
        output: createFakeOutput({
          colorDepth: 8,
          hasColors: true,
        }) as NodeJS.WriteStream,
        session,
      });

      controller.start();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20);

      const transcriptBox = neoBlessedMocks.state.boxes[0];
      expect(transcriptBox?.content).toContain("message 24");
      expect(transcriptBox?.content).toContain("message 40");
      expect(transcriptBox?.content).not.toContain("message 20");

      screen.emitMouse({ action: "wheelup", x: 4, y: 4 });
      screen.emitMouse({ action: "wheelup", x: 4, y: 4 });
      screen.emitMouse({ action: "wheelup", x: 4, y: 4 });
      screen.emitMouse({ action: "wheelup", x: 4, y: 4 });
      await vi.advanceTimersByTimeAsync(20);

      expect(close).not.toHaveBeenCalled();
      expect(transcriptBox?.content).toContain("message 20");
      expect(transcriptBox?.content).not.toContain("message 40");

      screen.emitKeypress("", { name: "backtab" });
      screen.emitKeypress("", { name: "escape" });
      screen.emitKeypress("", { name: "pageup" });
      await vi.advanceTimersByTimeAsync(20);

      expect(close).not.toHaveBeenCalled();
      expect(transcriptBox?.content).toContain("message 16");
      expect(transcriptBox?.content).not.toContain("message 40");

      const stoppedPromise = controller.waitUntilStopped();
      screen.emitKeypress("", { ctrl: true, full: "C-c", name: "c" });

      await expect(stoppedPromise).resolves.toEqual({
        status: "success",
        summary: "closed",
      });
    } finally {
      restoreEnv("NO_COLOR", originalNoColor);
      restoreEnv("FORCE_COLOR", originalForceColor);
      restoreEnv("TERM", originalTerm);
    }
  });
});

interface FakeScreen extends BlessedScreen {
  emitKeypress(character: string, key: BlessedKey): void;
  emitMouse(data: BlessedMouseData): void;
}

function createFakeScreen(): FakeScreen {
  const handlers: {
    mouse?: ((data: BlessedMouseData) => void) | undefined;
    keypress?: ((character: string, key: BlessedKey) => void) | undefined;
    resize?: (() => void) | undefined;
  } = {};

  return {
    destroy: vi.fn(),
    emitKeypress(character, key) {
      handlers.keypress?.(character, key);
    },
    emitMouse(data) {
      handlers.mouse?.(data);
    },
    height: 32,
    key() {},
    on(eventName, handler) {
      if (eventName === "keypress") {
        handlers.keypress = handler as (
          character: string,
          key: BlessedKey,
        ) => void;
        return;
      }

      if (eventName === "mouse") {
        handlers.mouse = handler as (data: BlessedMouseData) => void;
        return;
      }

      handlers.resize = handler as () => void;
    },
    render: vi.fn(),
    width: 120,
  };
}

function createFakeSession(overrides?: Partial<AgentChatSessionSnapshot>): {
  close: ReturnType<typeof vi.fn>;
  session: AgentChatSession;
  submitUserMessage: ReturnType<typeof vi.fn>;
} {
  const listeners = new Set<(snapshot: AgentChatSessionSnapshot) => void>();
  const snapshot: AgentChatSessionSnapshot = {
    activity: {
      currentCommand: overrides?.activity?.currentCommand,
      currentTool: overrides?.activity?.currentTool,
      gitSummary: overrides?.activity?.gitSummary ?? "Clean on main",
      latestCheck: overrides?.activity?.latestCheck,
      recent: overrides?.activity?.recent ?? [],
    },
    busy: overrides?.busy ?? false,
    closed: overrides?.closed ?? false,
    ...(overrides?.lastTurnOutcome === undefined
      ? {}
      : { lastTurnOutcome: overrides.lastTurnOutcome }),
    runId: overrides?.runId ?? "chat-run",
    transcript: overrides?.transcript ?? [],
    turnIndex: overrides?.turnIndex ?? 0,
  };
  const close = vi.fn(async (): Promise<RunResult> => {
    snapshot.closed = true;
    emitSnapshot();
    return {
      status: "success",
      summary: "closed",
    };
  });
  const submitUserMessage = vi.fn(async (message: string): Promise<void> => {
    snapshot.transcript = [
      ...snapshot.transcript,
      {
        content: message,
        id: `message-${snapshot.transcript.length + 1}`,
        role: "user",
        timestamp: "2026-04-17T18:00:00.000Z",
      },
    ];
    emitSnapshot();
  });
  const session = {
    cancelActiveTurn: vi.fn(),
    close,
    dossier: {
      paths: {
        runId: "chat-run",
      },
    },
    eventBus: {},
    getSnapshot: vi.fn(() => cloneSnapshot(snapshot)),
    start: vi.fn(async () => {
      emitSnapshot();
    }),
    submitUserMessage,
    subscribe: vi.fn((listener: (value: AgentChatSessionSnapshot) => void) => {
      listeners.add(listener);
      listener(cloneSnapshot(snapshot));
      return () => {
        listeners.delete(listener);
      };
    }),
  } as unknown as AgentChatSession;

  return { close, session, submitUserMessage };

  function emitSnapshot(): void {
    const next = cloneSnapshot(snapshot);

    for (const listener of listeners) {
      listener(next);
    }
  }
}

function cloneSnapshot(
  snapshot: AgentChatSessionSnapshot,
): AgentChatSessionSnapshot {
  return {
    activity: {
      ...snapshot.activity,
      recent: [...snapshot.activity.recent],
    },
    busy: snapshot.busy,
    closed: snapshot.closed,
    ...(snapshot.lastTurnOutcome === undefined
      ? {}
      : { lastTurnOutcome: snapshot.lastTurnOutcome }),
    runId: snapshot.runId,
    transcript: [...snapshot.transcript],
    turnIndex: snapshot.turnIndex,
  };
}

function createFakeOutput(options?: {
  colorDepth?: number;
  hasColors?: boolean;
}): Pick<NodeJS.WriteStream, "getColorDepth" | "hasColors" | "isTTY"> {
  return {
    getColorDepth() {
      return options?.colorDepth ?? 1;
    },
    hasColors() {
      return options?.hasColors ?? false;
    },
    isTTY: true,
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
