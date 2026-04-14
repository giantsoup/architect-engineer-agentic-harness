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

  if (configVersion < CURRENT_HARNESS_CONFIG_VERSION) {
    throw new HarnessConfigMigrationError([
      `version: Config version ${configVersion} is not supported by this release. Update the file to version ${CURRENT_HARNESS_CONFIG_VERSION} or regenerate it with \`architect-engineer-agentic-harness init\`.`,
    ]);
  }

  return migrateVersion1Config(rawConfig);
}

function migrateVersion1Config(
  rawConfig: Record<string, unknown>,
): MigrateHarnessConfigResult {
  if (!isPlainObject(rawConfig.commands)) {
    return {
      migrated: false,
      value: rawConfig,
    };
  }

  const install = rawConfig.commands.install;
  const setup = rawConfig.commands.setup;

  if (typeof install === "string" || typeof setup !== "string") {
    return {
      migrated: false,
      value: rawConfig,
    };
  }

  return {
    migrated: true,
    value: {
      ...rawConfig,
      commands: {
        ...rawConfig.commands,
        install: setup,
      },
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
