import type { ResolvedProjectContext } from "../adapters/types.js";

export interface ModelConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  maxRetries?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface HarnessConfig {
  version: 1;
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
