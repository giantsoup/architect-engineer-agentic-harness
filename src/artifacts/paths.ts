import path from "node:path";

import type { DossierArtifactKind } from "../types/run.js";

export const DOSSIER_FILE_NAMES = {
  architectPlan: "architect-plan.md",
  architectReview: "architect-review.md",
  checks: "checks.json",
  commandLog: "command-log.jsonl",
  diff: "diff.patch",
  engineerTask: "engineer-task.md",
  events: "events.jsonl",
  failureNotes: "failure-notes.md",
  finalReport: "final-report.md",
  result: "result.json",
  run: "run.json",
} as const;

export const DOSSIER_FILE_KINDS: {
  readonly [Key in DossierFileKey]: DossierArtifactKind;
} = {
  architectPlan: "markdown",
  architectReview: "markdown",
  checks: "json",
  commandLog: "jsonl",
  diff: "patch",
  engineerTask: "markdown",
  events: "jsonl",
  failureNotes: "markdown",
  finalReport: "markdown",
  result: "json",
  run: "json",
};

export type DossierFileKey = keyof typeof DOSSIER_FILE_NAMES;

export interface DossierFilePath {
  absolutePath: string;
  fileName: (typeof DOSSIER_FILE_NAMES)[DossierFileKey];
  key: DossierFileKey;
  kind: DossierArtifactKind;
  relativePath: string;
}

export interface BuildRunDossierPathsOptions {
  artifactsRootDir: string;
  projectRoot: string;
  runId: string;
  runsDir: string;
}

export interface RunDossierPaths {
  artifactsRootAbsolutePath: string;
  artifactsRootRelativePath: string;
  files: {
    [Key in DossierFileKey]: DossierFilePath;
  };
  projectRoot: string;
  runDirAbsolutePath: string;
  runDirRelativePath: string;
  runId: string;
  runsDirAbsolutePath: string;
  runsDirRelativePath: string;
}

export function buildRunDossierPaths(
  options: BuildRunDossierPathsOptions,
): RunDossierPaths {
  const projectRoot = path.resolve(options.projectRoot);
  const artifactsRootAbsolutePath = path.resolve(
    projectRoot,
    options.artifactsRootDir,
  );
  const runsDirAbsolutePath = path.resolve(projectRoot, options.runsDir);
  const runDirAbsolutePath = path.join(runsDirAbsolutePath, options.runId);

  const files = Object.fromEntries(
    (Object.keys(DOSSIER_FILE_NAMES) as DossierFileKey[]).map((key) => {
      const absolutePath = path.join(
        runDirAbsolutePath,
        DOSSIER_FILE_NAMES[key],
      );

      return [
        key,
        {
          absolutePath,
          fileName: DOSSIER_FILE_NAMES[key],
          key,
          kind: DOSSIER_FILE_KINDS[key],
          relativePath: toPortableRelativePath(projectRoot, absolutePath),
        },
      ];
    }),
  ) as RunDossierPaths["files"];

  return {
    artifactsRootAbsolutePath,
    artifactsRootRelativePath: toPortableRelativePath(
      projectRoot,
      artifactsRootAbsolutePath,
    ),
    files,
    projectRoot,
    runDirAbsolutePath,
    runDirRelativePath: toPortableRelativePath(projectRoot, runDirAbsolutePath),
    runId: options.runId,
    runsDirAbsolutePath,
    runsDirRelativePath: toPortableRelativePath(
      projectRoot,
      runsDirAbsolutePath,
    ),
  };
}

function toPortableRelativePath(fromPath: string, targetPath: string): string {
  const relativePath = path.relative(fromPath, targetPath);
  const normalizedRelativePath = relativePath.split(path.sep).join("/");

  return normalizedRelativePath.length === 0 ? "." : normalizedRelativePath;
}
