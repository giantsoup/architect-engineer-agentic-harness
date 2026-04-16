export {
  CURRENT_HARNESS_CONFIG_VERSION,
  DEFAULT_PROMPT_VERSION,
  DEFAULT_SCHEMA_VERSION,
} from "./versioning.js";
export {
  detectProjectAdapter,
  getResolvedProjectCommand,
  resolveProjectContext,
} from "./adapters/detect-project.js";

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
export {
  HarnessConfigMigrationError,
  migrateHarnessConfig,
} from "./config/migrate-config.js";
export { renderHarnessConfigTemplate } from "./config/template.js";
export { appendJsonLine } from "./artifacts/logs.js";
export {
  buildRunDossierPaths,
  DOSSIER_FILE_KINDS,
  DOSSIER_FILE_NAMES,
} from "./artifacts/paths.js";
export {
  assertValidRunId,
  createRunId,
  formatRunTimestamp,
  isValidRunId,
  RUN_ID_PATTERN,
} from "./artifacts/run-id.js";
export {
  appendCommandLog,
  appendModelEvent,
  appendRunEvent,
  appendStructuredMessage,
  appendToolCall,
  initializeRunDossier,
  readRunManifest,
  RunDossierError,
  writeArchitectPlan,
  writeArchitectReview,
  writeChecks,
  writeDiff,
  writeEngineerTask,
  writeFailureNotes,
  writeFinalReport,
  writeRunLifecycleStatus,
  writeRunResult,
} from "./runtime/run-dossier.js";
export {
  BuiltInToolCommandError,
  BuiltInToolError,
  BuiltInToolGitError,
  BuiltInToolInputError,
  BuiltInToolPathError,
  BuiltInToolPermissionError,
  BuiltInToolStateError,
  McpServerUnavailableError,
  McpToolCallError,
  McpToolError,
  McpToolNotAllowedError,
  McpToolNotFoundError,
} from "./tools/errors.js";
export {
  buildDockerExecArgs,
  ContainerCommandCancelledError,
  ContainerCommandTimeoutError,
  ContainerNotFoundError,
  ContainerRuntimeError,
  ContainerSessionConfigError,
  ContainerSessionError,
  ContainerSessionStateError,
  createDockerContainerSession,
} from "./sandbox/container-session.js";
export { createHostCommandSession } from "./sandbox/host-session.js";
export {
  createBuiltInToolExecutor,
  BuiltInToolExecutor,
} from "./tools/built-in-tools.js";
export { createToolRouter, ToolRouter } from "./tools/tool-router.js";
export {
  createProjectCommandRunner,
  ProjectCommandRunner,
} from "./sandbox/command-runner.js";
export {
  assertMcpServerAllowed,
  getAllowlistedMcpServerIds,
  isMcpServerAllowed,
} from "./tools/mcp/allowlist.js";
export { createMcpServerClient } from "./tools/mcp/client.js";
export {
  DEFAULT_MCP_STARTUP_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  listConfiguredMcpServerIds,
  resolveConfiguredMcpServers,
  resolveMcpServerDefinition,
} from "./tools/mcp/registry.js";
export {
  RunResultValidationError,
  validateRunResult,
} from "./runtime/run-result.js";
export { createRunBranchName } from "./git/branch.js";
export { createRunCommitMessage, isCommitNeeded } from "./git/commit.js";
export {
  classifyGitWorkingTree,
  GitStatusParseError,
  parseGitStatusPorcelain,
} from "./git/status.js";
export type {
  HarnessConfig,
  LoadedHarnessConfig,
  McpServerConfig,
  McpServerPreset,
} from "./types/config.js";
export type {
  DetectedProjectAdapter,
  ProjectAdapterId,
  ProjectCommandName,
  ProjectCommandResolution,
  ProjectCommandSource,
  ResolvedProjectCommands,
  ResolvedProjectContext,
} from "./adapters/types.js";
export type { CreateBuiltInToolExecutorOptions } from "./tools/built-in-tools.js";
export type {
  BuiltInToolExecutionContext,
  BuiltInToolName,
  BuiltInToolRequest,
  BuiltInToolResult,
  CommandExecutionToolRequest,
  CommandExecutionToolResult,
  FileListEntry,
  FileListToolRequest,
  FileListToolResult,
  FileReadManyToolRequest,
  FileReadManyToolResult,
  FileReadManyToolResultEntry,
  FileReadToolRequest,
  FileReadToolResult,
  FileSearchToolRequest,
  FileSearchToolResult,
  FileSearchToolResultEntry,
  FileSearchToolResultHit,
  FileWriteToolRequest,
  FileWriteToolResult,
  GitDiffToolRequest,
  GitDiffToolResult,
  GitStatusBranchSummary,
  GitStatusEntry,
  GitStatusToolRequest,
  GitStatusToolResult,
  McpAvailableTool,
  McpServerAvailability,
  McpToolCallRequest,
  McpToolCallResult,
  McpToolResponseContent,
  ToolCatalog,
  ToolExecutionContext,
  ToolExecutionSummary,
  ToolRequest,
  ToolResult,
} from "./tools/types.js";
export type { CreateToolRouterOptions } from "./tools/tool-router.js";
export type {
  CommandExecutionRequest,
  CreateProjectCommandRunnerOptions,
  EngineerCommandExecutionRequest,
  ProjectCommandRunnerLike,
} from "./sandbox/command-runner.js";
export type {
  ContainerCommandAccessMode,
  ContainerCommandEnvironment,
  ContainerCommandRequest,
  ContainerCommandResult,
  ContainerCommandRole,
  ContainerSession,
  ContainerSessionMetadata,
  CreateDockerContainerSessionOptions,
} from "./sandbox/container-session.js";
export type { CreateHostCommandSessionOptions } from "./sandbox/host-session.js";
export {
  ArchitectControlOutputValidationError,
  createArchitectStructuredOutputFormat,
  loadArchitectControlSchema,
  validateArchitectControlOutput,
} from "./models/architect-output.js";
export {
  createRunDossierModelLogger,
  redactModelHeaders,
} from "./models/dossier-logger.js";
export {
  createEngineerToolDefinitions,
  createEngineerStructuredOutputFormat,
  EngineerControlOutputValidationError,
  EngineerTurnValidationError,
  loadEngineerControlSchema,
  resolveEngineerTurn,
  validateEngineerToolRequest,
  validateEngineerControlOutput,
} from "./models/engineer-output.js";
export {
  DEFAULT_MODEL_MAX_RETRIES,
  DEFAULT_MODEL_TIMEOUT_MS,
  createRoleModelClient,
  normalizeOpenAiCompatibleBaseUrl,
  resolveModelConfigForRole,
} from "./models/provider-factory.js";
export {
  renderAcceptanceCriteriaLines,
  resolveAcceptanceCriteriaPolicy,
} from "./runtime/acceptance-criteria.js";
export { executeEngineerTask } from "./runtime/engineer-task.js";
export { executeArchitectEngineerRun } from "./runtime/architect-engineer-run.js";
export { createHarnessEventBus } from "./runtime/harness-events.js";
export {
  ModelClientConfigError,
  ModelClientError,
  ModelHttpError,
  ModelNetworkError,
  ModelResponseError,
  ModelStructuredOutputError,
  ModelTimeoutError,
  OpenAiCompatibleChatClient,
  UnsupportedModelProviderError,
} from "./models/openai-compatible-client.js";
export type {
  ArchitectEngineerFailureNote,
  ArchitectEngineerFinalOutcome,
  ArchitectEngineerRunMetadata,
  ArchitectEngineerState,
  ArchitectEngineerStopConditionState,
  ArchitectEngineerStopReason,
  ArchitectEngineerExecutionSnapshot,
  ArchitectEngineerIterationState,
  ArchitectEngineerNodeName,
} from "./runtime/architect-engineer-state.js";
export type {
  DirtyWorkingTreeOutcome,
  DirtyWorkingTreePolicy,
  RuntimeRunGitMetadata,
  RunGitCommitRecord,
} from "./runtime/run-git-state.js";
export type {
  CommandLogRecord,
  DossierArtifactKind,
  JsonPrimitive,
  JsonValue,
  RunArtifactFileReference,
  RunCheckResult,
  RunChecksSummary,
  RunConvergenceMetrics,
  RunGitCommitSummary,
  RunGitMetadata,
  RunLifecycleStatus,
  RunManifest,
  RunManifestFiles,
  RunPromptReference,
  RunResult,
  RunSchemaReference,
  StructuredMessageRecord,
  ToolCallErrorRecord,
  ToolCallRecord,
} from "./types/run.js";
export type {
  CreateMcpServerClient,
  McpServerClientLike,
} from "./tools/mcp/client.js";
export type {
  EngineerAction,
  EngineerFinalAction,
  EngineerToolCallAction,
  EngineerToolAction,
  EngineerTurn,
} from "./models/engineer-output.js";
export type {
  ArchitectControlAction,
  ArchitectPlanAction,
  ArchitectPlanOutput,
  ArchitectReview,
  ArchitectReviewAction,
  ArchitectReviewOutput,
  ArchitectToolAction,
  ArchitectStructuredOutputKind,
  ArchitectStructuredOutputSchema,
  ArchitectStructuredOutputValue,
  HarnessModelRole,
  ModelChatMessage,
  ModelChatRequest,
  ModelChatResponse,
  ModelChatRole,
  ModelLogErrorEvent,
  ModelLogRequestEvent,
  ModelLogResponseEvent,
  ModelLogRetryEvent,
  ModelRequestLogger,
  ModelResponseUsage,
  ModelStructuredOutputSpec,
  ModelToolCall,
  ModelToolDefinition,
  ResolvedModelConfig,
  SupportedModelProvider,
} from "./models/types.js";
export type {
  EngineerTaskExecution,
  EngineerTaskStopReason,
  EngineerTaskModelClient,
  ExecuteEngineerTaskOptions,
} from "./runtime/engineer-task.js";
export type { ArchitectRunModelClient } from "./runtime/architect-engineer-nodes.js";
export type {
  CreateHarnessEventBusOptions,
  HarnessEvent,
  HarnessEventBus,
  HarnessEventInput,
  HarnessEventListener,
  HarnessEventMap,
  HarnessEventType,
} from "./runtime/harness-events.js";
export type {
  ArchitectEngineerRunExecution,
  ExecuteArchitectEngineerRunOptions,
} from "./runtime/architect-engineer-run.js";
export type { ResolvedMcpServerDefinition } from "./tools/mcp/registry.js";
