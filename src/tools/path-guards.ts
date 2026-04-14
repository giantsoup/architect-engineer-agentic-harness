import path from "node:path";
import { realpath } from "node:fs/promises";

import type { HarnessModelRole } from "../models/types.js";
import {
  BuiltInToolInputError,
  BuiltInToolPathError,
  BuiltInToolPermissionError,
} from "./errors.js";
import {
  isPathWithin,
  type BuiltInToolPaths,
  type BuiltInToolWritePolicy,
} from "./permissions.js";
import type { BuiltInToolName } from "./types.js";

export interface GuardedToolPath {
  absolutePath: string;
  path: string;
}

export async function resolveReadableToolPath(
  toolName: BuiltInToolName,
  inputPath: string,
  paths: BuiltInToolPaths,
): Promise<GuardedToolPath> {
  const normalizedPath = normalizeToolPath(toolName, inputPath);
  const absolutePath = path.resolve(paths.projectRoot, normalizedPath);
  const canonicalProjectRoot = await realpath(paths.projectRoot);
  const canonicalTarget = await resolvePathForBoundaryCheck(absolutePath);

  if (!isPathWithin(canonicalProjectRoot, canonicalTarget)) {
    throw new BuiltInToolPathError(
      toolName,
      `Path \`${normalizedPath}\` resolves outside the project root.`,
    );
  }

  return {
    absolutePath,
    path: toPortableRelativePath(paths.projectRoot, absolutePath),
  };
}

export async function resolveWritableToolPath(
  toolName: BuiltInToolName,
  role: HarnessModelRole,
  inputPath: string,
  policy: BuiltInToolWritePolicy,
): Promise<GuardedToolPath> {
  const normalizedPath = normalizeToolPath(toolName, inputPath);
  const absolutePath = path.resolve(policy.projectRoot, normalizedPath);
  const canonicalProjectRoot = await realpath(policy.projectRoot);
  const canonicalArtifactsRoot = await resolvePathForBoundaryCheck(
    policy.artifactsRoot,
  );
  const canonicalTarget = await resolvePathForBoundaryCheck(absolutePath);

  if (!isPathWithin(canonicalProjectRoot, canonicalTarget)) {
    throw new BuiltInToolPathError(
      toolName,
      `Path \`${normalizedPath}\` resolves outside the project root.`,
    );
  }

  if (role === "architect") {
    if (!isPathWithin(canonicalArtifactsRoot, canonicalTarget)) {
      throw new BuiltInToolPermissionError(
        toolName,
        `Architect may only write inside the artifact root \`${toPortableRelativePath(policy.projectRoot, policy.artifactsRoot)}\`.`,
      );
    }
  } else if (isPathWithin(canonicalArtifactsRoot, canonicalTarget)) {
    throw new BuiltInToolPermissionError(
      toolName,
      `Engineer may not modify files inside the artifact root \`${toPortableRelativePath(policy.projectRoot, policy.artifactsRoot)}\`.`,
    );
  }

  return {
    absolutePath,
    path: toPortableRelativePath(policy.projectRoot, absolutePath),
  };
}

async function resolvePathForBoundaryCheck(
  targetPath: string,
): Promise<string> {
  const missingSegments: string[] = [];
  let currentPath = targetPath;

  while (true) {
    try {
      const resolvedPath = await realpath(currentPath);
      return path.resolve(resolvedPath, ...missingSegments.reverse());
    } catch (error) {
      const maybeNodeError = error as NodeJS.ErrnoException;

      if (maybeNodeError.code === "ENOENT") {
        const parentPath = path.dirname(currentPath);

        if (parentPath === currentPath) {
          throw error;
        }

        missingSegments.push(path.basename(currentPath));
        currentPath = parentPath;
        continue;
      }

      throw error;
    }
  }
}

function normalizeToolPath(
  toolName: BuiltInToolName,
  inputPath: string,
): string {
  if (typeof inputPath !== "string") {
    throw new BuiltInToolInputError(
      toolName,
      "Expected `path` to be a string relative to the project root.",
    );
  }

  const trimmedPath = inputPath.trim();

  if (trimmedPath.length === 0) {
    throw new BuiltInToolInputError(
      toolName,
      "Expected `path` to be a non-empty string relative to the project root.",
    );
  }

  if (trimmedPath.includes("\u0000")) {
    throw new BuiltInToolInputError(
      toolName,
      "Path must not contain null bytes.",
    );
  }

  if (path.isAbsolute(trimmedPath)) {
    throw new BuiltInToolInputError(
      toolName,
      "Expected `path` to be relative to the project root, not absolute.",
    );
  }

  return path.normalize(trimmedPath);
}

function toPortableRelativePath(fromPath: string, targetPath: string): string {
  const relativePath = path.relative(fromPath, targetPath);
  const normalizedRelativePath = relativePath.split(path.sep).join("/");

  return normalizedRelativePath.length === 0 ? "." : normalizedRelativePath;
}
