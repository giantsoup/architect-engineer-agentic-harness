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
  config: HarnessConfig;
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
    config,
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
  const configFileName = path.basename(result.configPath);
  const resolvedCommands = [
    ["install", getResolvedProjectCommand(result.resolvedProject, "install")],
    ["test", getResolvedProjectCommand(result.resolvedProject, "test")],
    ["lint", getResolvedProjectCommand(result.resolvedProject, "lint")],
    [
      "typecheck",
      getResolvedProjectCommand(result.resolvedProject, "typecheck"),
    ],
    ["build", getResolvedProjectCommand(result.resolvedProject, "build")],
    ["format", getResolvedProjectCommand(result.resolvedProject, "format")],
  ].filter((entry): entry is [string, string] => entry[1] !== undefined);

  return [
    ...renderInitWelcomeBanner(),
    "",
    `Initialized architect-engineer-agentic-harness in ${result.projectRoot}`,
    "",
    "Files",
    `- ${describeConfigAction(result.configAction, configFileName)}`,
    `  Main repo-local config for model endpoints, execution mode, project commands, MCP allowlist, and stop conditions.`,
    `- ${describeDirectoryAction(result.artifactRootAction, result.artifactRootDir)}`,
    "  Artifact root for harness output such as run manifests, logs, and summaries.",
    `- ${describeDirectoryAction(result.runsDirAction, result.runsDir)}`,
    "  Per-run dossiers are written here.",
    `- .gitignore: ${describeGitignoreAction(result.gitignoreAction, gitignoreEntry)}`,
    "  Keeps generated harness artifacts out of version control.",
    "",
    "Detected defaults",
    `- Project adapter: ${formatProjectAdapter(result.resolvedProject)}`,
    `- Execution target: ${result.config.project.executionTarget}`,
    `- Sandbox mode: ${result.config.sandbox.mode}`,
    `- MCP allowlist: ${formatMcpAllowlist(result.config.mcp.allowlist)}`,
    ...(resolvedCommands.length === 0
      ? ["- Commands: none detected automatically"]
      : [
          "- Commands:",
          ...resolvedCommands.map(([name, command]) => `  ${name}: ${command}`),
        ]),
    "",
    "Next steps",
    ...formatNextSteps(result, configFileName),
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

  const mcp: HarnessConfig["mcp"] =
    resolvedProject.adapter.id === "laravel-generic"
      ? {
          allowlist: [],
          servers: {
            "laravel-boost": {
              preset: "laravel-boost",
              transport: "stdio",
            },
          },
        }
      : {
          allowlist: [],
          servers: {},
        };

  return {
    ...DEFAULT_HARNESS_CONFIG,
    commands,
    mcp,
    ...(resolvedProject.adapter.id === "laravel-generic"
      ? {
          project: {
            executionTarget: "docker" as const,
            containerName: "app",
          },
          sandbox: {
            mode: "container" as const,
          },
        }
      : {}),
  };
}

function formatProjectAdapter(resolvedProject: ResolvedProjectContext): string {
  if (resolvedProject.adapter.id === "unknown") {
    return "not detected";
  }

  return `${resolvedProject.adapter.label} (${resolvedProject.adapter.markers.join(", ")})`;
}

function formatMcpAllowlist(allowlist: readonly string[]): string {
  return allowlist.length === 0 ? "empty" : allowlist.join(", ");
}

function renderInitWelcomeBanner(): string[] {
  return [
    "+------------------------------------------------------+",
    "|                                                      |",
    "|  ____  _                 _       _       _           |",
    "| | __ )| |_   _  ___ _ __(_)_ __ | |_    (_)_ __      |",
    "| |  _ \\| | | | |/ _ \\ '__| | '_ \\| __|   | | '_ \\     |",
    "| | |_) | | |_| |  __/ |  | | |_) | |_ _  | | | | |    |",
    "| |____/|_|\\__,_|\\___|_|  |_| .__/ \\__(_) |_|_| |_|    |",
    "|                           |_|                        |",
    "|                                                      |",
    "|               Setup Complete                         |",
    "|                                                      |",
    "+------------------------------------------------------+",
  ];
}

function formatNextSteps(
  result: InitializeProjectResult,
  configFileName: string,
): string[] {
  const configPrefix =
    result.configAction === "created"
      ? `Open ${configFileName} and replace the example`
      : `Review ${configFileName} and confirm the`;
  const steps = [
    `1. ${configPrefix} \`models.architect\` values for your real Architect endpoint.`,
    `2. ${configPrefix} \`models.agent\` for interactive chat, plus \`models.engineer\` for split-brain execution.`,
    `3. Review the detected commands under \`[commands]\` and adjust any repo-specific overrides.`,
    "4. Optional: add allowlisted MCP servers under `[mcp]` before task runs.",
  ];

  if (result.config.project.executionTarget === "docker") {
    steps.push(
      "5. Make sure the configured project container is already running before `blueprint run`.",
    );
  } else {
    steps.push(
      '5. Smoke test the command path with `blueprint run --command "npm test"`.',
    );
  }

  return steps;
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
