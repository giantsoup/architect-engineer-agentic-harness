import { readFile, stat } from "node:fs/promises";

import type { RunDossierPaths } from "../artifacts/paths.js";
import type { CommandLogRecord, RunChecksSummary } from "../types/run.js";

type JsonRecord = Record<string, unknown>;

export interface TuiArtifactSnapshot {
  architectPlan: string;
  architectReview: string;
  checks: RunChecksSummary | undefined;
  commandLog: readonly CommandLogRecord[];
  diff: string;
  engineerTask: string;
  events: readonly JsonRecord[];
}

export interface TuiArtifactReader {
  read(options?: { force?: boolean | undefined }): Promise<TuiArtifactSnapshot>;
}

interface CachedArtifact<TValue> {
  fingerprint: string;
  value: TValue;
}

export function createTuiArtifactReader(options: {
  paths: Pick<RunDossierPaths, "files">;
}): TuiArtifactReader {
  const { paths } = options;
  const cache = new Map<string, CachedArtifact<unknown>>();

  const readCached = async <TValue>(
    filePath: string,
    reader: () => Promise<TValue>,
    force: boolean,
  ): Promise<TValue> => {
    const fingerprint = await getFingerprint(filePath);
    const cached = cache.get(filePath);

    if (!force && cached?.fingerprint === fingerprint) {
      return cached.value as TValue;
    }

    const value = await reader();

    cache.set(filePath, {
      fingerprint,
      value,
    });

    return value;
  };

  return {
    async read(readOptions = {}) {
      const force = readOptions.force ?? false;

      const [
        architectPlan,
        architectReview,
        checks,
        commandLog,
        diff,
        engineerTask,
        events,
      ] = await Promise.all([
        readCached(
          paths.files.architectPlan.absolutePath,
          () => readTextArtifact(paths.files.architectPlan.absolutePath),
          force,
        ),
        readCached(
          paths.files.architectReview.absolutePath,
          () => readTextArtifact(paths.files.architectReview.absolutePath),
          force,
        ),
        readCached(
          paths.files.checks.absolutePath,
          () =>
            readOptionalJsonArtifact<RunChecksSummary>(
              paths.files.checks.absolutePath,
            ),
          force,
        ),
        readCached(
          paths.files.commandLog.absolutePath,
          () =>
            readJsonLinesArtifact<CommandLogRecord>(
              paths.files.commandLog.absolutePath,
            ),
          force,
        ),
        readCached(
          paths.files.diff.absolutePath,
          () => readTextArtifact(paths.files.diff.absolutePath),
          force,
        ),
        readCached(
          paths.files.engineerTask.absolutePath,
          () => readTextArtifact(paths.files.engineerTask.absolutePath),
          force,
        ),
        readCached(
          paths.files.events.absolutePath,
          () =>
            readJsonLinesArtifact<JsonRecord>(paths.files.events.absolutePath),
          force,
        ),
      ]);

      return {
        architectPlan,
        architectReview,
        checks,
        commandLog,
        diff,
        engineerTask,
        events,
      };
    },
  };
}

async function getFingerprint(filePath: string): Promise<string> {
  try {
    const stats = await stat(filePath);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError.code === "ENOENT") {
      return "missing";
    }

    throw error;
  }
}

async function readTextArtifact(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

async function readOptionalJsonArtifact<TValue>(
  filePath: string,
): Promise<TValue | undefined> {
  const rawContents = await readTextArtifact(filePath);

  if (rawContents.trim().length === 0) {
    return undefined;
  }

  return JSON.parse(rawContents) as TValue;
}

async function readJsonLinesArtifact<TValue>(
  filePath: string,
): Promise<readonly TValue[]> {
  const rawContents = await readTextArtifact(filePath);

  if (rawContents.trim().length === 0) {
    return [];
  }

  return rawContents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TValue);
}
