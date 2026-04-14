import path from "node:path";

import { z } from "zod";

import type { HarnessConfig } from "../types/config.js";

const nonEmptyStringSchema = z.string().trim().min(1, "Must not be empty.");
const relativeProjectPathSchema = nonEmptyStringSchema
  .refine(
    (value) => !path.isAbsolute(value),
    "Must be a relative path inside the project.",
  )
  .refine(
    (value) => staysWithinProjectRoot(value),
    "Must stay within the project root.",
  );
const artifactRootDirSchema = relativeProjectPathSchema.refine(
  (value) => normalizePath(value) !== ".",
  "Must not be the project root.",
);

const modelConfigSchema = z
  .object({
    provider: nonEmptyStringSchema,
    model: nonEmptyStringSchema,
    baseUrl: z.string().url("Must be a valid URL."),
    apiKey: nonEmptyStringSchema.optional(),
    headers: z.record(nonEmptyStringSchema, nonEmptyStringSchema).optional(),
    maxRetries: z.number().int().min(0).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const harnessConfigSchema: z.ZodType<HarnessConfig> = z
  .object({
    version: z.literal(1),
    models: z
      .object({
        architect: modelConfigSchema,
        engineer: modelConfigSchema,
      })
      .strict(),
    project: z
      .object({
        executionTarget: z.enum(["docker", "host"]),
        containerName: nonEmptyStringSchema.optional(),
      })
      .strict(),
    commands: z
      .object({
        build: nonEmptyStringSchema.optional(),
        format: nonEmptyStringSchema.optional(),
        install: nonEmptyStringSchema.optional(),
        lint: nonEmptyStringSchema.optional(),
        setup: nonEmptyStringSchema.optional(),
        test: nonEmptyStringSchema.optional(),
        typecheck: nonEmptyStringSchema.optional(),
      })
      .strict(),
    mcp: z
      .object({
        allowlist: z.array(nonEmptyStringSchema),
      })
      .strict(),
    network: z
      .object({
        mode: z.enum(["inherit", "disabled"]),
      })
      .strict(),
    sandbox: z
      .object({
        mode: z.enum(["container", "workspace-write"]),
      })
      .strict(),
    artifacts: z
      .object({
        rootDir: artifactRootDirSchema,
        runsDir: relativeProjectPathSchema,
      })
      .strict(),
    stopConditions: z
      .object({
        maxIterations: z.number().int().positive(),
        maxEngineerAttempts: z.number().int().positive(),
        requirePassingChecks: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    if (
      config.project.executionTarget === "docker" &&
      config.project.containerName === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["project", "containerName"],
        message: 'Required when project.executionTarget is "docker".',
      });
    }

    if (!isNestedPath(config.artifacts.rootDir, config.artifacts.runsDir)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifacts", "runsDir"],
        message: "Must be a subdirectory of artifacts.rootDir.",
      });
    }

    const uniqueAllowlist = new Set(config.mcp.allowlist);
    if (uniqueAllowlist.size !== config.mcp.allowlist.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mcp", "allowlist"],
        message: "Duplicate MCP server identifiers are not allowed.",
      });
    }
  });

function staysWithinProjectRoot(value: string): boolean {
  const normalizedValue = normalizePath(value);

  return normalizedValue !== ".." && !normalizedValue.startsWith("../");
}

function isNestedPath(rootDir: string, nestedDir: string): boolean {
  const projectSentinel = "/project";
  const normalizedRootDir = path.posix.resolve(
    projectSentinel,
    normalizePath(rootDir),
  );
  const normalizedNestedDir = path.posix.resolve(
    projectSentinel,
    normalizePath(nestedDir),
  );
  const relativePath = path.posix.relative(
    normalizedRootDir,
    normalizedNestedDir,
  );

  return (
    relativePath.length > 0 &&
    !relativePath.startsWith("..") &&
    !path.posix.isAbsolute(relativePath)
  );
}

function normalizePath(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/"));
}
