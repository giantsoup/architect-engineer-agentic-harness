import { CURRENT_HARNESS_CONFIG_VERSION } from "../versioning.js";

export interface MigrateHarnessConfigResult {
  migrated: boolean;
  value: unknown;
}

export class HarnessConfigMigrationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join("\n"));

    this.name = "HarnessConfigMigrationError";
    this.issues = issues;
  }
}

export function migrateHarnessConfig(
  rawConfig: unknown,
): MigrateHarnessConfigResult {
  if (!isPlainObject(rawConfig)) {
    throw new HarnessConfigMigrationError([
      "config: Expected a TOML table at the document root.",
    ]);
  }

  const rawVersion = rawConfig.version;

  if (rawVersion === undefined) {
    throw new HarnessConfigMigrationError([
      `version: Missing required config version. Add \`version = ${CURRENT_HARNESS_CONFIG_VERSION}\` near the top of agent-harness.toml.`,
    ]);
  }

  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion)) {
    throw new HarnessConfigMigrationError([
      `version: Expected an integer config version. Current supported version: ${CURRENT_HARNESS_CONFIG_VERSION}.`,
    ]);
  }

  const configVersion = rawVersion;

  if (configVersion > CURRENT_HARNESS_CONFIG_VERSION) {
    throw new HarnessConfigMigrationError([
      `version: Config version ${configVersion} is newer than this CLI supports (${CURRENT_HARNESS_CONFIG_VERSION}). Upgrade architect-engineer-agentic-harness before loading this file.`,
    ]);
  }

  if (configVersion !== 1 && configVersion < CURRENT_HARNESS_CONFIG_VERSION) {
    throw new HarnessConfigMigrationError([
      `version: Config version ${configVersion} is not supported by this release. Update the file to version ${CURRENT_HARNESS_CONFIG_VERSION} or regenerate it with \`architect-engineer-agentic-harness init\`.`,
    ]);
  }

  return configVersion === 1
    ? migrateVersion1Config(rawConfig)
    : migrateVersion2Config(rawConfig);
}

function migrateVersion1Config(
  rawConfig: Record<string, unknown>,
): MigrateHarnessConfigResult {
  return {
    migrated: true,
    value: {
      ...rawConfig,
      version: CURRENT_HARNESS_CONFIG_VERSION,
      ...(isPlainObject(rawConfig.commands)
        ? { commands: normalizeCommands(rawConfig.commands) }
        : {}),
      ...(isPlainObject(rawConfig.models)
        ? { models: normalizeVersion1Models(rawConfig.models) }
        : {}),
    },
  };
}

function migrateVersion2Config(
  rawConfig: Record<string, unknown>,
): MigrateHarnessConfigResult {
  if (!isPlainObject(rawConfig.commands)) {
    return {
      migrated: false,
      value: rawConfig,
    };
  }

  const normalizedCommands = normalizeCommands(rawConfig.commands);

  return {
    migrated: normalizedCommands !== rawConfig.commands,
    value: {
      ...rawConfig,
      commands: normalizedCommands,
    },
  };
}

function normalizeCommands(
  commands: Record<string, unknown>,
): Record<string, unknown> {
  const install = commands.install;
  const setup = commands.setup;

  if (typeof install === "string" || typeof setup !== "string") {
    return commands;
  }

  return {
    ...commands,
    install: setup,
  };
}

function normalizeVersion1Models(
  models: Record<string, unknown>,
): Record<string, unknown> {
  if (isPlainObject(models.agent) || !isPlainObject(models.engineer)) {
    return models;
  }

  return {
    ...models,
    agent: { ...models.engineer },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
