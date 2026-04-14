import type { LoadedHarnessConfig } from "../../types/config.js";
import { McpToolNotAllowedError } from "../errors.js";

export function assertMcpServerAllowed(
  loadedConfig: LoadedHarnessConfig,
  serverId: string,
): void {
  if (!isMcpServerAllowed(loadedConfig, serverId)) {
    throw new McpToolNotAllowedError(
      `MCP server \`${serverId}\` is not allowlisted in ${loadedConfig.configPath}. Add it to \`mcp.allowlist\` before it can be used.`,
    );
  }
}

export function getAllowlistedMcpServerIds(
  loadedConfig: LoadedHarnessConfig,
): string[] {
  return [...loadedConfig.config.mcp.allowlist];
}

export function isMcpServerAllowed(
  loadedConfig: LoadedHarnessConfig,
  serverId: string,
): boolean {
  return loadedConfig.config.mcp.allowlist.includes(serverId);
}
