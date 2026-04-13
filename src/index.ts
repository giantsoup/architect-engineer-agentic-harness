export const DEFAULT_PROMPT_VERSION = "v1";
export const DEFAULT_SCHEMA_VERSION = "v1";

export {
  DEFAULT_ARTIFACTS_ROOT_DIR,
  DEFAULT_HARNESS_CONFIG,
  DEFAULT_RUNS_DIR,
  HARNESS_CONFIG_FILENAME,
} from "./config/defaults.js";
export {
  formatInitializeProjectSummary,
  initializeProject,
} from "./config/init-project.js";
export { HarnessConfigError, loadHarnessConfig } from "./config/load-config.js";
export { renderHarnessConfigTemplate } from "./config/template.js";
export type { HarnessConfig, LoadedHarnessConfig } from "./types/config.js";
