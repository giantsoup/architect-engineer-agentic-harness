import { DEFAULT_HARNESS_CONFIG } from "./defaults.js";

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

export function renderHarnessConfigTemplate(): string {
  const config = DEFAULT_HARNESS_CONFIG;

  return `# Repository-local configuration for architect-engineer-agentic-harness.
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
# Use "docker" to execute inside an existing container, or "host" to run locally.
executionTarget = ${quoteTomlString(config.project.executionTarget)}
containerName = ${quoteTomlString(config.project.containerName ?? "app")}

[commands]
# Override these commands to match the target repository.
setup = ${quoteTomlString(config.commands.setup)}
build = ${quoteTomlString(config.commands.build)}
test = ${quoteTomlString(config.commands.test)}
lint = ${quoteTomlString(config.commands.lint)}
format = ${quoteTomlString(config.commands.format)}

[mcp]
# Only listed MCP servers may be used by the harness.
allowlist = []

[network]
mode = ${quoteTomlString(config.network.mode)}

[sandbox]
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
