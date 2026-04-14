import path from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";

import {
  getResolvedProjectCommand,
  resolveProjectContext,
} from "../adapters/detect-project.js";
import type { HarnessConfig } from "../types/config.js";
import type { ResolvedProjectContext } from "../adapters/types.js";
import { HARNESS_CONFIG_FILENAME } from "./defaults.js";
import { DEFAULT_HARNESS_CONFIG } from "./defaults.js";
import { loadHarnessConfig } from "./load-config.js";
import { renderHarnessConfigTemplate } from "./template.js";

export interface InitializeProjectResult {
  projectRoot: string;
  configPath: string;
  configAction: "created" | "preserved";
  artifactRootDir: string;
  artifactRootAction: "created" | "existing";
  runsDir: string;
  runsDirAction: "created" | "existing";
  gitignorePath: string;
  gitignoreAction: "created" | "updated" | "unchanged";
  resolvedProject: ResolvedProjectContext;
}

export async function initializeProject(
  projectRoot: string = process.cwd(),
): Promise<InitializeProjectResult> {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const configPath = path.join(resolvedProjectRoot, HARNESS_CONFIG_FILENAME);
  const detectedProject = await resolveProjectContext({
    commands: {},
    projectRoot: resolvedProjectRoot,
  });

  let configAction: InitializeProjectResult["configAction"] = "preserved";

  if (!(await pathExists(configPath))) {
    const initialConfig = createInitialHarnessConfig(detectedProject);

    await writeFile(
      configPath,
      renderHarnessConfigTemplate({
        config: initialConfig,
        detectedProject: detectedProject.adapter,
      }),
      "utf8",
    );
    configAction = "created";
  }

  const loadedConfig = await loadHarnessConfig({
    projectRoot: resolvedProjectRoot,
  });
  const { config } = loadedConfig;
  const artifactRootPath = path.join(
    resolvedProjectRoot,
    config.artifacts.rootDir,
  );
  const runsPath = path.join(resolvedProjectRoot, config.artifacts.runsDir);
  const artifactRootAction = await ensureDirectory(artifactRootPath);
  const runsDirAction = await ensureDirectory(runsPath);
  const gitignorePath = path.join(resolvedProjectRoot, ".gitignore");
  const gitignoreAction = await ensureArtifactIgnoreRule(
    gitignorePath,
    config.artifacts.rootDir,
  );

  return {
    projectRoot: resolvedProjectRoot,
    configPath,
    configAction,
    artifactRootDir: config.artifacts.rootDir,
    artifactRootAction,
    runsDir: config.artifacts.runsDir,
    runsDirAction,
    gitignorePath,
    gitignoreAction,
    resolvedProject: loadedConfig.resolvedProject,
  };
}

export function formatInitializeProjectSummary(
  result: InitializeProjectResult,
): string {
  const gitignoreEntry = toGitignoreEntry(result.artifactRootDir);

  return [
    `Initialized architect-engineer-agentic-harness in ${result.projectRoot}`,
    `- Config: ${describeConfigAction(result.configAction, path.basename(result.configPath))}`,
    `- Artifact root: ${describeDirectoryAction(result.artifactRootAction, result.artifactRootDir)}`,
    `- Runs directory: ${describeDirectoryAction(result.runsDirAction, result.runsDir)}`,
    `- .gitignore: ${describeGitignoreAction(result.gitignoreAction, gitignoreEntry)}`,
    `- Project adapter: ${formatProjectAdapter(result.resolvedProject)}`,
  ].join("\n");
}

async function ensureDirectory(
  directoryPath: string,
): Promise<"created" | "existing"> {
  if (await pathExists(directoryPath)) {
    const directoryStats = await stat(directoryPath);

    if (!directoryStats.isDirectory()) {
      throw new Error(`${directoryPath} exists but is not a directory.`);
    }

    return "existing";
  }

  await mkdir(directoryPath, { recursive: true });
  return "created";
}

async function ensureArtifactIgnoreRule(
  gitignorePath: string,
  artifactRootDir: string,
): Promise<"created" | "updated" | "unchanged"> {
  const ignoreEntry = toGitignoreEntry(artifactRootDir);

  let gitignoreContents: string | undefined;

  try {
    gitignoreContents = await readFile(gitignorePath, "utf8");
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;

    if (maybeNodeError.code !== "ENOENT") {
      throw error;
    }
  }

  if (
    gitignoreContents !== undefined &&
    hasEquivalentIgnoreEntry(gitignoreContents, artifactRootDir)
  ) {
    return "unchanged";
  }

  const nextContents =
    gitignoreContents === undefined
      ? `${ignoreEntry}\n`
      : appendLine(gitignoreContents, ignoreEntry);

  await writeFile(gitignorePath, nextContents, "utf8");

  return gitignoreContents === undefined ? "created" : "updated";
}

function hasEquivalentIgnoreEntry(
  gitignoreContents: string,
  artifactRootDir: string,
): boolean {
  const normalizedArtifactRootDir = normalizeIgnorePath(artifactRootDir);

  return gitignoreContents.split(/\r?\n/u).some((line) => {
    const trimmedLine = line.trim();

    if (
      trimmedLine.length === 0 ||
      trimmedLine.startsWith("#") ||
      trimmedLine.startsWith("!")
    ) {
      return false;
    }

    return normalizeIgnorePath(trimmedLine) === normalizedArtifactRootDir;
  });
}

function normalizeIgnorePath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .trim()
    .replace(/^\.\/+/u, "")
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "");
}

function toGitignoreEntry(artifactRootDir: string): string {
  return `/${normalizeIgnorePath(artifactRootDir)}/`;
}

function appendLine(currentContents: string, lineToAppend: string): string {
  const trailingNewline = currentContents.endsWith("\n") ? "" : "\n";

  return `${currentContents}${trailingNewline}${lineToAppend}\n`;
}

function describeConfigAction(
  action: InitializeProjectResult["configAction"],
  configFileName: string,
): string {
  return action === "created"
    ? `created ${configFileName}`
    : `preserved existing ${configFileName}`;
}

function describeDirectoryAction(
  action: "created" | "existing",
  directory: string,
): string {
  return action === "created"
    ? `created ${directory}`
    : `kept existing ${directory}`;
}

function describeGitignoreAction(
  action: InitializeProjectResult["gitignoreAction"],
  ignoreEntry: string,
): string {
  switch (action) {
    case "created":
      return `created with ${ignoreEntry}`;
    case "updated":
      return `added ${ignoreEntry}`;
    case "unchanged":
      return `already contains ${ignoreEntry}`;
  }
}

function createInitialHarnessConfig(
  resolvedProject: ResolvedProjectContext,
): HarnessConfig {
  const commands: HarnessConfig["commands"] =
    resolvedProject.adapter.id === "laravel-generic"
      ? {
          ...(getResolvedProjectCommand(resolvedProject, "install") ===
          undefined
            ? {}
            : {
                install: getResolvedProjectCommand(resolvedProject, "install"),
              }),
          ...(getResolvedProjectCommand(resolvedProject, "test") === undefined
            ? {}
            : { test: getResolvedProjectCommand(resolvedProject, "test") }),
          ...(getResolvedProjectCommand(resolvedProject, "lint") === undefined
            ? {}
            : { lint: getResolvedProjectCommand(resolvedProject, "lint") }),
          ...(getResolvedProjectCommand(resolvedProject, "typecheck") ===
          undefined
            ? {}
            : {
                typecheck: getResolvedProjectCommand(
                  resolvedProject,
                  "typecheck",
                ),
              }),
        }
      : {
          ...DEFAULT_HARNESS_CONFIG.commands,
          ...(getResolvedProjectCommand(resolvedProject, "install") ===
          undefined
            ? {}
            : {
                install: getResolvedProjectCommand(resolvedProject, "install"),
              }),
          ...(getResolvedProjectCommand(resolvedProject, "test") === undefined
            ? {}
            : { test: getResolvedProjectCommand(resolvedProject, "test") }),
          ...(getResolvedProjectCommand(resolvedProject, "lint") === undefined
            ? {}
            : { lint: getResolvedProjectCommand(resolvedProject, "lint") }),
          ...(getResolvedProjectCommand(resolvedProject, "typecheck") ===
          undefined
            ? {}
            : {
                typecheck: getResolvedProjectCommand(
                  resolvedProject,
                  "typecheck",
                ),
              }),
        };

  return {
    ...DEFAULT_HARNESS_CONFIG,
    commands,
  };
}

function formatProjectAdapter(resolvedProject: ResolvedProjectContext): string {
  if (resolvedProject.adapter.id === "unknown") {
    return "not detected";
  }

  return `${resolvedProject.adapter.label} (${resolvedProject.adapter.markers.join(", ")})`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;

    if (maybeNodeError.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}
