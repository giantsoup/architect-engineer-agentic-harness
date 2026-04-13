export interface ModelConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string | undefined;
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
    setup: string;
    build: string;
    test: string;
    lint: string;
    format: string;
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
}
