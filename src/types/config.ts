import type { ResolvedProjectContext } from "../adapters/types.js";
import type { HarnessConfigVersion } from "../versioning.js";

export interface ModelConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  maxRetries?: number | undefined;
  timeoutMs?: number | undefined;
}

export type McpServerPreset = "laravel-boost";

export interface McpServerConfig {
  transport: "stdio";
  preset?: McpServerPreset | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  workingDirectory?: string | undefined;
  startupTimeoutMs?: number | undefined;
  toolTimeoutMs?: number | undefined;
}

export interface HarnessConfig {
  version: HarnessConfigVersion;
  models: {
    architect: ModelConfig;
    engineer: ModelConfig;
  };
  project: {
    executionTarget: "docker" | "host";
    containerName?: string | undefined;
  };
  commands: {
    build?: string | undefined;
    format?: string | undefined;
    install?: string | undefined;
    lint?: string | undefined;
    setup?: string | undefined;
    test?: string | undefined;
    typecheck?: string | undefined;
  };
  mcp: {
    allowlist: string[];
    servers?: Record<string, McpServerConfig> | undefined;
  };
  network: {
    mode: "inherit" | "disabled";
  };
  sandbox: {
    mode: "container" | "workspace-write";
  };
  artifacts: {
    rootDir: string;
    runsDir: string;
  };
  stopConditions: {
    maxIterations: number;
    maxEngineerAttempts: number;
    requirePassingChecks: boolean;
  };
}

export interface LoadedHarnessConfig {
  config: HarnessConfig;
  configPath: string;
  projectRoot: string;
  resolvedProject: ResolvedProjectContext;
}
