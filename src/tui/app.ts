import type { RunDossierPaths } from "../artifacts/paths.js";
import { createTuiDemoFeed, type TuiDemoFeed } from "./demo.js";
import { resolveTuiKeyboardCommand } from "./keyboard.js";
import { computeTuiLayout } from "./layout.js";
import {
  createBlessedBox,
  createBlessedScreen,
  type BlessedBox,
  type BlessedKey,
  type BlessedScreen,
} from "./neo-blessed.js";
import {
  createRenderScheduler,
  type RenderScheduler,
} from "./render-scheduler.js";
import {
  createInitialTuiState,
  createTuiStore,
  TUI_PANE_ORDER,
  type TuiStore,
} from "./state.js";
import { renderHelpModalWidget } from "./widgets/help-modal.js";
import { hidePaneWidget, renderPaneWidget } from "./widgets/pane.js";
import { renderStatusBarWidget } from "./widgets/status-bar.js";

export interface TuiController {
  start(): void;
  stop(): Promise<void>;
}

export interface CreateTuiRendererOptions {
  input?: NodeJS.ReadStream | undefined;
  output?: NodeJS.WriteStream | undefined;
  paths: Pick<RunDossierPaths, "runDirRelativePath" | "runId">;
  task?: string | undefined;
}

export interface CreateTuiAppOptions {
  demoFeed?: TuiDemoFeed | undefined;
  runLabel: string;
  scheduler?: RenderScheduler | undefined;
  screen: BlessedScreen;
  store?: TuiStore | undefined;
  task?: string | undefined;
}

export function createTuiRenderer(
  options: CreateTuiRendererOptions,
): TuiController {
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;

  if (output.isTTY !== true || input.isTTY !== true) {
    return {
      start() {
        process.stderr.write(
          `TUI requested for ${options.paths.runId}, but an interactive TTY is unavailable. Continuing without the TUI shell.\n`,
        );
      },
      async stop() {},
    };
  }

  const screen = createBlessedScreen({
    autoPadding: false,
    fullUnicode: true,
    input,
    output,
    smartCSR: true,
    title: `architect-engineer-agentic-harness ${options.paths.runId}`,
  });

  return createTuiApp({
    runLabel: options.paths.runId,
    screen,
    task: options.task,
  });
}

export function createTuiApp(options: CreateTuiAppOptions): TuiController {
  const store =
    options.store ??
    createTuiStore(
      createInitialTuiState({
        demoMode: true,
        runLabel: options.runLabel,
        task: options.task,
      }),
    );
  const scheduler =
    options.scheduler ??
    createRenderScheduler({
      render: () => {
        renderScreen();
      },
    });
  const demoFeed =
    options.demoFeed ??
    createTuiDemoFeed({
      store,
      task: options.task,
    });
  const paneBoxes = Object.fromEntries(
    TUI_PANE_ORDER.map((pane) => [
      pane,
      createBlessedBox({
        border: "line",
        hidden: true,
        label: "",
        parent: options.screen,
      }),
    ]),
  ) as Record<(typeof TUI_PANE_ORDER)[number], BlessedBox>;
  const statusBarBox = createBlessedBox({
    height: 1,
    label: "",
    parent: options.screen,
  });
  const helpModalBox = createBlessedBox({
    border: "line",
    hidden: true,
    label: "Help",
    parent: options.screen,
  });
  let started = false;
  let stopped = false;
  const unsubscribe = store.subscribe(() => {
    scheduler.markDirty();
  });

  options.screen.on("resize", () => {
    scheduler.markDirty();
  });
  options.screen.key(
    [
      "tab",
      "S-tab",
      "backtab",
      "left",
      "right",
      "up",
      "down",
      "pageup",
      "pagedown",
      "x",
      "f",
      "r",
      "?",
      "S-/",
      "q",
      "C-c",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ],
    (_character: string, key: BlessedKey) => {
      const command = resolveTuiKeyboardCommand(store.getState(), key);

      if (command.type === "dispatch") {
        store.dispatch(command.action);
        return;
      }

      if (command.type === "quit") {
        void stop();
      }
    },
  );

  const renderScreen = () => {
    const state = store.getState();
    const layout = computeTuiLayout({
      height: options.screen.height,
      state,
      width: options.screen.width,
    });

    for (const pane of TUI_PANE_ORDER) {
      const paneLayout = layout.panes[pane];
      const paneBox = paneBoxes[pane];

      if (paneLayout.visible) {
        renderPaneWidget({
          box: paneBox,
          pane,
          rect: paneLayout.rect,
          state,
        });
      } else {
        hidePaneWidget(paneBox);
      }
    }

    renderStatusBarWidget({
      box: statusBarBox,
      rect: layout.statusBar,
      state,
    });
    renderHelpModalWidget({
      box: helpModalBox,
      rect: layout.helpModal,
      state,
    });
    options.screen.render();
  };

  const stop = async () => {
    if (stopped) {
      return;
    }

    stopped = true;
    demoFeed.stop();
    unsubscribe();
    scheduler.destroy();
    options.screen.destroy();
  };

  return {
    start() {
      if (started || stopped) {
        return;
      }

      started = true;
      demoFeed.start();
      scheduler.markDirty();
      scheduler.flush();
    },
    stop,
  };
}
