import type { RunDossierPaths } from "../artifacts/paths.js";
import { readRunInspection } from "../runtime/run-history.js";
import {
  renderLiveSnapshotBlock,
  renderLiveSnapshotLine,
} from "./summary-renderer.js";

export interface CreateLiveConsoleOptions {
  now?: () => Date;
  output?: Pick<NodeJS.WriteStream, "isTTY" | "write">;
  paths: RunDossierPaths;
  pollIntervalMs?: number;
}

export interface LiveConsoleRenderer {
  start(): void;
  stop(): Promise<void>;
}

export function createLiveConsoleRenderer(
  options: CreateLiveConsoleOptions,
): LiveConsoleRenderer {
  const now = options.now ?? (() => new Date());
  const output = options.output ?? process.stderr;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  let interval: NodeJS.Timeout | undefined;
  let lastRenderedKey = "";
  let renderedLineCount = 0;
  let refreshInFlight = false;

  const writePendingMessage = () => {
    writeRenderedText(
      output,
      output.isTTY === true
        ? [
            `Run ${options.paths.runId}  STARTING  00:00:00`,
            "Phase: Preparing",
            "Role: System",
            "Objective: Creating run dossier and preparing execution.",
            "Command/check: No commands or checks recorded yet.",
            "Decision: No high-level decision recorded yet.",
            `Dossier: ${options.paths.runDirRelativePath}`,
            "",
          ].join("\n")
        : `Starting run ${options.paths.runId}. Dossier: ${options.paths.runDirRelativePath}\n`,
      { isTTY: output.isTTY === true, renderedLineCount },
      (nextLineCount) => {
        renderedLineCount = nextLineCount;
      },
    );
  };

  const refresh = async () => {
    if (refreshInFlight) {
      return;
    }

    refreshInFlight = true;

    try {
      const inspection = await readRunInspection(options.paths, { now: now() });
      const nextRenderedText =
        output.isTTY === true
          ? renderLiveSnapshotBlock(inspection)
          : `${renderLiveSnapshotLine(inspection)}\n`;
      const renderKey = JSON.stringify({
        activeRole: inspection.activeRole,
        commandStatus: inspection.commandStatus,
        currentObjective: inspection.currentObjective,
        latestDecision: inspection.latestDecision,
        phase: inspection.phase,
        status: inspection.status,
      });

      if (renderKey === lastRenderedKey) {
        return;
      }

      lastRenderedKey = renderKey;
      writeRenderedText(
        output,
        nextRenderedText,
        { isTTY: output.isTTY === true, renderedLineCount },
        (nextLineCount) => {
          renderedLineCount = nextLineCount;
        },
      );
    } catch {
      // The run directory is not guaranteed to exist before preparation starts.
    } finally {
      refreshInFlight = false;
    }
  };

  return {
    start() {
      writePendingMessage();
      void refresh();
      interval = setInterval(() => {
        void refresh();
      }, pollIntervalMs);
    },
    async stop() {
      if (interval !== undefined) {
        clearInterval(interval);
        interval = undefined;
      }

      await refresh();
    },
  };
}

function writeRenderedText(
  output: Pick<NodeJS.WriteStream, "write">,
  text: string,
  options: { isTTY: boolean; renderedLineCount: number },
  onRendered: (renderedLineCount: number) => void,
): void {
  if (options.isTTY && options.renderedLineCount > 0) {
    output.write(`\u001B[${options.renderedLineCount}F\u001B[0J`);
  }

  output.write(text);

  const renderedLineCount = countRenderedLines(text);

  if (options.isTTY) {
    output.write("\n");
    onRendered(renderedLineCount + 1);
    return;
  }

  onRendered(0);
}

function countRenderedLines(value: string): number {
  const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;

  if (normalized.length === 0) {
    return 1;
  }

  return normalized.split("\n").length;
}
