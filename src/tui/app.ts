import type { RunDossierPaths } from "../artifacts/paths.js";
import type { HarnessEventBus } from "../runtime/harness-events.js";
import { createTuiDemoFeed, type TuiDemoFeed } from "./demo.js";
import { resolveTuiKeyboardCommand } from "./keyboard.js";
import { computeTuiLayout } from "./layout.js";
import { createTuiLiveDataSource } from "./live-data.js";
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
  TUI_ROLE_ORDER,
  type TuiStore,
} from "./state.js";
import {
  createTuiTheme,
  detectTuiTerminalCapabilities,
  type TuiTheme,
} from "./theme.js";
import { renderHeaderWidget } from "./widgets/header.js";
import { renderHelpModalWidget } from "./widgets/help-modal.js";
import {
  hideRolePanelWidget,
  renderRolePanelWidget,
} from "./widgets/role-panel.js";
import { renderStatusBarWidget } from "./widgets/status-bar.js";

export interface TuiController {
  start(): void;
  stop(): Promise<void>;
}

export interface TuiDataSource {
  forceRefresh?(): Promise<void> | void;
  start(): void;
  stop(): Promise<void> | void;
}

export interface CreateTuiRendererOptions {
  eventBus?: HarnessEventBus | undefined;
  input?: NodeJS.ReadStream | undefined;
  output?: NodeJS.WriteStream | undefined;
  paths: RunDossierPaths;
  task?: string | undefined;
}

export interface CreateTuiAppOptions {
  dataSource?: TuiDataSource | undefined;
  demoFeed?: TuiDemoFeed | undefined;
  errorOutput?: Pick<NodeJS.WriteStream, "write"> | undefined;
  runLabel: string;
  scheduler?: RenderScheduler | undefined;
  screen: BlessedScreen;
  store?: TuiStore | undefined;
  task?: string | undefined;
  theme?: TuiTheme | undefined;
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

  const capabilities = detectTuiTerminalCapabilities({
    output,
  });
  const theme = createTuiTheme(capabilities);
  let screen: BlessedScreen;

  try {
    screen = createBlessedScreen({
      autoPadding: false,
      fullUnicode: capabilities.unicode,
      input,
      output,
      smartCSR: true,
      title: `architect-engineer-agentic-harness ${options.paths.runId}`,
    });
  } catch (error) {
    return createTuiUnavailableController(
      options.paths.runId,
      formatTuiErrorMessage("screen initialization failed", error),
    );
  }

  const store = createTuiStore(
    createInitialTuiState({
      demoMode: options.eventBus === undefined,
      runLabel: options.paths.runId,
      task: options.task,
    }),
  );
  const dataSource =
    options.eventBus === undefined
      ? undefined
      : createTuiLiveDataSource({
          eventBus: options.eventBus,
          paths: options.paths,
          store,
          task: options.task,
        });

  return createTuiApp({
    ...(dataSource === undefined ? {} : { dataSource }),
    errorOutput: process.stderr,
    runLabel: options.paths.runId,
    screen,
    store,
    task: options.task,
    theme,
  });
}

export function createTuiApp(options: CreateTuiAppOptions): TuiController {
  const errorOutput = options.errorOutput ?? process.stderr;
  const store =
    options.store ??
    createTuiStore(
      createInitialTuiState({
        demoMode: true,
        runLabel: options.runLabel,
        task: options.task,
      }),
    );
  const theme =
    options.theme ??
    createTuiTheme(
      detectTuiTerminalCapabilities({
        output: process.stdout,
      }),
    );
  const scheduler =
    options.scheduler ??
    createRenderScheduler({
      onError(error) {
        reportFatalError("render failed", error);
      },
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
  const dataSource: TuiDataSource = options.dataSource ?? demoFeed;
  const roleBoxes = Object.fromEntries(
    TUI_ROLE_ORDER.map((role) => [
      role,
      createBlessedBox({
        border: "line",
        hidden: true,
        label: "",
        parent: options.screen,
      }),
    ]),
  ) as Record<(typeof TUI_ROLE_ORDER)[number], BlessedBox>;
  const headerBox = createBlessedBox({
    height: 1,
    parent: options.screen,
  });
  const statusBarBox = createBlessedBox({
    height: 1,
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
  let fatalErrorReported = false;
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
      "up",
      "down",
      "pageup",
      "pagedown",
      "f",
      "r",
      "?",
      "S-/",
      "q",
      "C-c",
    ],
    (_character: string, key: BlessedKey) => {
      try {
        const command = resolveTuiKeyboardCommand(store.getState(), key);

        if (command.type === "dispatch") {
          store.dispatch(command.action);

          if (command.action.type === "view.reset") {
            void dataSource.forceRefresh?.();
          }

          return;
        }

        if (command.type === "quit") {
          void stop();
        }
      } catch (error) {
        reportFatalError("keyboard handling failed", error);
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

    for (const role of TUI_ROLE_ORDER) {
      const roleLayout = layout.roles[role];
      const roleBox = roleBoxes[role];

      if (roleLayout.visible) {
        renderRolePanelWidget({
          box: roleBox,
          rect: roleLayout.rect,
          role,
          state,
          theme,
        });
      } else {
        hideRolePanelWidget(roleBox);
      }
    }

    renderHeaderWidget({
      box: headerBox,
      layout,
      rect: layout.header,
      state,
      theme,
    });
    renderStatusBarWidget({
      box: statusBarBox,
      layout,
      rect: layout.footer,
      state,
      theme,
    });
    renderHelpModalWidget({
      box: helpModalBox,
      rect: layout.helpModal,
      state,
      theme,
    });
    options.screen.render();
  };

  const stop = async () => {
    if (stopped) {
      return;
    }

    stopped = true;

    try {
      await dataSource.stop();
    } catch (error) {
      writeTuiDiagnostic(
        errorOutput,
        formatTuiErrorMessage("data source teardown failed", error),
      );
    }

    unsubscribe();
    scheduler.destroy();

    try {
      options.screen.destroy();
    } catch (error) {
      writeTuiDiagnostic(
        errorOutput,
        formatTuiErrorMessage("terminal restore failed", error),
      );
    }
  };

  const reportFatalError = (context: string, error: unknown) => {
    if (fatalErrorReported) {
      return;
    }

    fatalErrorReported = true;
    writeTuiDiagnostic(errorOutput, formatTuiErrorMessage(context, error));
    void stop();
  };

  return {
    start() {
      if (started || stopped) {
        return;
      }

      started = true;

      try {
        dataSource.start();
        scheduler.markDirty();
        scheduler.flush();
      } catch (error) {
        reportFatalError("startup failed", error);
      }
    },
    stop,
  };
}

function createTuiUnavailableController(
  runId: string,
  reason: string,
): TuiController {
  return {
    start() {
      process.stderr.write(
        `TUI requested for ${runId}, but the terminal UI could not start. ${reason}\n`,
      );
    },
    async stop() {},
  };
}

function formatTuiErrorMessage(context: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `TUI disabled after ${context}. Terminal state was restored. Cause: ${message}`;
}

function writeTuiDiagnostic(
  output: Pick<NodeJS.WriteStream, "write">,
  message: string,
): void {
  output.write(`${message}\n`);
}
