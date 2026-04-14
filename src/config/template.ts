import type { ResolvedProjectContext } from "../adapters/types.js";
import type { HarnessConfig } from "../types/config.js";
import { DEFAULT_HARNESS_CONFIG } from "./defaults.js";

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

export interface RenderHarnessConfigTemplateOptions {
  config?: HarnessConfig;
  detectedProject?: ResolvedProjectContext["adapter"];
}

export function renderHarnessConfigTemplate(
  options: RenderHarnessConfigTemplateOptions = {},
): string {
  const config = options.config ?? DEFAULT_HARNESS_CONFIG;
  const lines = [
    "# Repository-local configuration for architect-engineer-agentic-harness.",
  ];

  if (
    options.detectedProject !== undefined &&
    options.detectedProject.id !== "unknown"
  ) {
    lines.push(
      `# Detected project adapter: ${options.detectedProject.label} (${options.detectedProject.markers.join(", ")}).`,
    );
  }

  return `${lines.join("\n")}
# Keep secrets out of this file. Reference environment variables instead:
#   apiKey = "\${OPENAI_API_KEY}"
#
# Replace the example model values below before running real tasks.

version = ${config.version}

[models.architect]
# Example remote model provider for the Architect role.
provider = ${quoteTomlString(config.models.architect.provider)}
model = ${quoteTomlString(config.models.architect.model)}
baseUrl = ${quoteTomlString(config.models.architect.baseUrl)}
# apiKey = "\${OPENAI_API_KEY}"
# timeoutMs = 45000
# maxRetries = 2
#
# [models.architect.headers]
# x-provider-route = "architect"

[models.engineer]
# Example local llama.cpp-compatible endpoint for the Engineer role.
provider = ${quoteTomlString(config.models.engineer.provider)}
model = ${quoteTomlString(config.models.engineer.model)}
baseUrl = ${quoteTomlString(config.models.engineer.baseUrl)}
# timeoutMs = 120000
# maxRetries = 1
#
# [models.engineer.headers]
# x-provider-route = "engineer"

[project]
# Use "host" to run commands directly in the local repo checkout.
# Use "docker" to run commands in an already-running project container.
executionTarget = ${quoteTomlString(config.project.executionTarget)}
${renderOptionalProjectContainerName(config.project.containerName)}

[commands]
# Override these commands to match the target repository. Omit keys to rely on fallback detection.
# Use \`install\`; \`setup\` remains a legacy compatibility alias.
${renderOptionalTomlKey("install", config.commands.install)}
${renderOptionalTomlKey("test", config.commands.test)}
${renderOptionalTomlKey("lint", config.commands.lint)}
${renderOptionalTomlKey("typecheck", config.commands.typecheck)}
${renderOptionalTomlKey("build", config.commands.build)}
${renderOptionalTomlKey("format", config.commands.format)}

[mcp]
# Only listed MCP servers may be used by the harness.
allowlist = ${renderTomlStringArray(config.mcp.allowlist)}
#
# Example custom stdio server:
# [mcp.servers.repo]
# transport = "stdio"
# command = "node"
# args = ["scripts/repo-mcp.js"]
#
# Laravel Boost preset:
# [mcp.servers.laravel-boost]
# transport = "stdio"
# preset = "laravel-boost"
${renderMcpServers(config)}

[network]
mode = ${quoteTomlString(config.network.mode)}

[sandbox]
# "workspace-write" is the practical host-mode setting.
# "container" is the Docker-oriented setting.
mode = ${quoteTomlString(config.sandbox.mode)}

[artifacts]
# The harness writes verbose run artifacts here.
rootDir = ${quoteTomlString(config.artifacts.rootDir)}
runsDir = ${quoteTomlString(config.artifacts.runsDir)}

[stopConditions]
maxIterations = ${config.stopConditions.maxIterations}
# During the single-Engineer execution slice, this acts as the consecutive failed-check threshold.
maxEngineerAttempts = ${config.stopConditions.maxEngineerAttempts}
requirePassingChecks = ${config.stopConditions.requirePassingChecks}
`;
}

function renderOptionalTomlKey(key: string, value: string | undefined): string {
  return value === undefined
    ? `# ${key} = ${quoteTomlString(`replace-with-${key}-command`)}`
    : `${key} = ${quoteTomlString(value)}`;
}

function renderOptionalProjectContainerName(value: string | undefined): string {
  return value === undefined
    ? '# containerName = "app"'
    : `containerName = ${quoteTomlString(value)}`;
}

function renderMcpServers(config: HarnessConfig): string {
  const serverEntries = Object.entries(config.mcp.servers ?? {});

  if (serverEntries.length === 0) {
    return "";
  }

  return `\n${serverEntries
    .map(([serverId, serverConfig]) =>
      [
        `[mcp.servers.${serverId}]`,
        `transport = ${quoteTomlString(serverConfig.transport)}`,
        ...(serverConfig.preset === undefined
          ? []
          : [`preset = ${quoteTomlString(serverConfig.preset)}`]),
        ...(serverConfig.command === undefined
          ? []
          : [`command = ${quoteTomlString(serverConfig.command)}`]),
        ...(serverConfig.args === undefined
          ? []
          : [`args = ${renderTomlStringArray(serverConfig.args)}`]),
        ...(serverConfig.workingDirectory === undefined
          ? []
          : [
              `workingDirectory = ${quoteTomlString(serverConfig.workingDirectory)}`,
            ]),
        ...(serverConfig.startupTimeoutMs === undefined
          ? []
          : [`startupTimeoutMs = ${serverConfig.startupTimeoutMs}`]),
        ...(serverConfig.toolTimeoutMs === undefined
          ? []
          : [`toolTimeoutMs = ${serverConfig.toolTimeoutMs}`]),
        ...(serverConfig.env === undefined
          ? []
          : [
              "",
              `[mcp.servers.${serverId}.env]`,
              ...Object.entries(serverConfig.env).map(
                ([key, value]) => `${key} = ${quoteTomlString(value)}`,
              ),
            ]),
      ].join("\n"),
    )
    .join("\n\n")}`;
}

function renderTomlStringArray(values: readonly string[]): string {
  return `[${values.map((value) => quoteTomlString(value)).join(", ")}]`;
}
