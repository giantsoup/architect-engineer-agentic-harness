import path from "node:path";

import type { HarnessModelRole } from "../models/types.js";
import type { LoadedHarnessConfig } from "../types/config.js";

export interface BuiltInToolPaths {
  artifactsRoot: string;
  projectRoot: string;
}

export interface BuiltInToolWritePolicy {
  artifactsRoot: string;
  projectRoot: string;
  role: HarnessModelRole;
  writableRoots: readonly string[];
}

export function resolveBuiltInToolPaths(
  loadedConfig: LoadedHarnessConfig,
): BuiltInToolPaths {
  const projectRoot = path.resolve(loadedConfig.projectRoot);

  return {
    artifactsRoot: path.resolve(
      projectRoot,
      loadedConfig.config.artifacts.rootDir,
    ),
    projectRoot,
  };
}

export function resolveBuiltInToolWritePolicy(
  role: HarnessModelRole,
  paths: BuiltInToolPaths,
): BuiltInToolWritePolicy {
  return {
    artifactsRoot: paths.artifactsRoot,
    projectRoot: paths.projectRoot,
    role,
    writableRoots:
      role === "architect" ? [paths.artifactsRoot] : [paths.projectRoot],
  };
}

export function isPathWithin(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);

  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}
