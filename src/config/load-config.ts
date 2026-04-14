import path from "node:path";
import { readFile } from "node:fs/promises";

import { parse } from "smol-toml";
import type { ZodIssue } from "zod";

import { resolveProjectContext } from "../adapters/detect-project.js";
import type { LoadedHarnessConfig } from "../types/config.js";
import { HARNESS_CONFIG_FILENAME } from "./defaults.js";
import { resolveEnvironmentReferences } from "./resolve-env.js";
import { harnessConfigSchema } from "./schema.js";

export interface LoadHarnessConfigOptions {
  projectRoot?: string;
  configPath?: string;
}

export class HarnessConfigError extends Error {
  readonly configPath: string;
  readonly issues: readonly string[];

  constructor(configPath: string, issues: readonly string[]) {
    super(formatHarnessConfigError(configPath, issues));

    this.name = "HarnessConfigError";
    this.configPath = configPath;
    this.issues = issues;
  }
}

export async function loadHarnessConfig(
  options: LoadHarnessConfigOptions = {},
): Promise<LoadedHarnessConfig> {
  const projectRootFromOptions = options.projectRoot
    ? path.resolve(options.projectRoot)
    : undefined;
  const configPath = options.configPath
    ? path.resolve(projectRootFromOptions ?? process.cwd(), options.configPath)
    : path.join(
        projectRootFromOptions ?? process.cwd(),
        HARNESS_CONFIG_FILENAME,
      );
  const projectRoot = projectRootFromOptions ?? path.dirname(configPath);

  const rawConfig = await readConfigFile(configPath);
  const parsedConfig = parseTomlConfig(configPath, rawConfig);
  const resolvedConfig = resolveEnvironmentReferences(parsedConfig);

  if (resolvedConfig.issues.length > 0) {
    throw new HarnessConfigError(
      configPath,
      resolvedConfig.issues.map(
        (issue) =>
          `${issue.path}: Missing environment variable \`${issue.variableName}\`.`,
      ),
    );
  }

  const validationResult = harnessConfigSchema.safeParse(resolvedConfig.value);

  if (!validationResult.success) {
    throw new HarnessConfigError(
      configPath,
      validationResult.error.issues.map(formatValidationIssue),
    );
  }

  const resolvedProject = await resolveProjectContext({
    commands: validationResult.data.commands,
    projectRoot,
  });
  const issues = validateResolvedProject(
    resolvedProject,
    validationResult.data,
  );

  if (issues.length > 0) {
    throw new HarnessConfigError(configPath, issues);
  }

  return {
    config: validationResult.data,
    configPath,
    projectRoot,
    resolvedProject,
  };
}

async function readConfigFile(configPath: string): Promise<string> {
  try {
    return await readFile(configPath, "utf8");
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;

    if (maybeNodeError.code === "ENOENT") {
      throw new HarnessConfigError(configPath, [
        `Config file not found. Run \`architect-engineer-agentic-harness init\` to create ${HARNESS_CONFIG_FILENAME}.`,
      ]);
    }

    const message = error instanceof Error ? error.message : String(error);

    throw new HarnessConfigError(configPath, [
      `Could not read config file: ${message}`,
    ]);
  }
}

function parseTomlConfig(configPath: string, rawConfig: string): unknown {
  try {
    return parse(rawConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new HarnessConfigError(configPath, [`TOML parse error: ${message}`]);
  }
}

function formatValidationIssue(issue: ZodIssue): string {
  const formattedPath =
    issue.path.length === 0 ? "config" : formatIssuePath(issue.path);

  return `${formattedPath}: ${issue.message}`;
}

function formatIssuePath(pathSegments: readonly PropertyKey[]): string {
  return pathSegments.reduce<string>((formattedPath, segment) => {
    if (typeof segment === "number") {
      return `${formattedPath}[${segment}]`;
    }

    const normalizedSegment = String(segment);

    return formattedPath.length === 0
      ? normalizedSegment
      : `${formattedPath}.${normalizedSegment}`;
  }, "");
}

function formatHarnessConfigError(
  configPath: string,
  issues: readonly string[],
): string {
  return [
    `Invalid harness config at ${configPath}:`,
    ...issues.map((issue) => `- ${issue}`),
  ].join("\n");
}

function validateResolvedProject(
  resolvedProject: Awaited<ReturnType<typeof resolveProjectContext>>,
  config: LoadedHarnessConfig["config"],
): string[] {
  const issues: string[] = [];

  if (
    config.stopConditions.requirePassingChecks &&
    resolvedProject.commands.test.command === undefined
  ) {
    issues.push(
      "commands.test: Could not resolve a required test command from config or project detection.",
    );
  }

  return issues;
}
