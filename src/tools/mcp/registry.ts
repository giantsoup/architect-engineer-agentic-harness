import path from "node:path";

import type {
  LoadedHarnessConfig,
  McpServerConfig,
  McpServerPreset,
} from "../../types/config.js";

export const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 15_000;
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000;

export interface ResolvedMcpServerDefinition {
  args: string[];
  command: string;
  cwd: string;
  env?: Record<string, string> | undefined;
  id: string;
  preset?: McpServerPreset | undefined;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
  transport: "stdio";
}

export function listConfiguredMcpServerIds(
  loadedConfig: LoadedHarnessConfig,
): string[] {
  return Object.keys(loadedConfig.config.mcp.servers ?? {}).sort();
}

export function resolveConfiguredMcpServers(
  loadedConfig: LoadedHarnessConfig,
): ResolvedMcpServerDefinition[] {
  return Object.entries(loadedConfig.config.mcp.servers ?? {})
    .map(([serverId, serverConfig]) =>
      resolveMcpServerDefinition(loadedConfig, serverId, serverConfig),
    )
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
}

export function resolveMcpServerDefinition(
  loadedConfig: LoadedHarnessConfig,
  serverId: string,
  serverConfig: McpServerConfig,
): ResolvedMcpServerDefinition {
  const presetConfig =
    serverConfig.preset === undefined
      ? undefined
      : resolveMcpPresetDefinition(serverConfig.preset);

  return {
    args: [...(serverConfig.args ?? presetConfig?.args ?? [])],
    command: serverConfig.command ?? presetConfig?.command ?? "",
    cwd: path.resolve(
      loadedConfig.projectRoot,
      serverConfig.workingDirectory ?? presetConfig?.workingDirectory ?? ".",
    ),
    ...(serverConfig.env === undefined ? {} : { env: { ...serverConfig.env } }),
    id: serverId,
    ...(serverConfig.preset === undefined
      ? {}
      : { preset: serverConfig.preset }),
    startupTimeoutMs:
      serverConfig.startupTimeoutMs ??
      presetConfig?.startupTimeoutMs ??
      DEFAULT_MCP_STARTUP_TIMEOUT_MS,
    toolTimeoutMs:
      serverConfig.toolTimeoutMs ??
      presetConfig?.toolTimeoutMs ??
      DEFAULT_MCP_TOOL_TIMEOUT_MS,
    transport: "stdio",
  };
}

interface PresetDefinition {
  args: string[];
  command: string;
  startupTimeoutMs?: number | undefined;
  toolTimeoutMs?: number | undefined;
  workingDirectory?: string | undefined;
}

function resolveMcpPresetDefinition(preset: McpServerPreset): PresetDefinition {
  switch (preset) {
    case "laravel-boost":
      return {
        args: ["artisan", "boost:mcp"],
        command: "php",
        workingDirectory: ".",
      };
  }
}
