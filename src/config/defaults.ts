import type { HarnessConfig } from "../types/config.js";
import { CURRENT_HARNESS_CONFIG_VERSION } from "../versioning.js";

export const HARNESS_CONFIG_FILENAME = "agent-harness.toml";
export const DEFAULT_ARTIFACTS_ROOT_DIR = ".agent-harness";
export const DEFAULT_RUNS_DIR = `${DEFAULT_ARTIFACTS_ROOT_DIR}/runs`;

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  version: CURRENT_HARNESS_CONFIG_VERSION,
  models: {
    architect: {
      provider: "openai-compatible",
      model: "replace-with-your-architect-model",
      baseUrl: "https://api.openai.com/v1",
    },
    engineer: {
      provider: "llama.cpp",
      model: "replace-with-your-engineer-model",
      baseUrl: "http://127.0.0.1:8080/v1",
    },
  },
  project: {
    executionTarget: "host",
  },
  commands: {
    build: "npm run build",
    format: "npm run format",
    install: "npm install",
    lint: "npm run lint",
    test: "npm run test",
    typecheck: "npm run typecheck",
  },
  mcp: {
    allowlist: [],
    servers: {},
  },
  network: {
    mode: "inherit",
  },
  sandbox: {
    mode: "workspace-write",
  },
  artifacts: {
    rootDir: DEFAULT_ARTIFACTS_ROOT_DIR,
    runsDir: DEFAULT_RUNS_DIR,
  },
  stopConditions: {
    maxIterations: 12,
    maxEngineerAttempts: 5,
    requirePassingChecks: true,
  },
};
