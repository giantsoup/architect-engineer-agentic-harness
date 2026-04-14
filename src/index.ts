export {
  DEFAULT_PROMPT_VERSION,
  DEFAULT_SCHEMA_VERSION,
} from "./versioning.js";

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
export {
  createBuiltInToolExecutor,
  BuiltInToolExecutor,
} from "./tools/built-in-tools.js";
export {
  createProjectCommandRunner,
  ProjectCommandRunner,
} from "./sandbox/command-runner.js";
export {
  RunResultValidationError,
  validateRunResult,
} from "./runtime/run-result.js";
export type { HarnessConfig, LoadedHarnessConfig } from "./types/config.js";
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
  FileReadToolRequest,
  FileReadToolResult,
  FileWriteToolRequest,
  FileWriteToolResult,
  GitDiffToolRequest,
  GitDiffToolResult,
  GitStatusBranchSummary,
  GitStatusEntry,
  GitStatusToolRequest,
  GitStatusToolResult,
} from "./tools/types.js";
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
  createEngineerStructuredOutputFormat,
  EngineerControlOutputValidationError,
  loadEngineerControlSchema,
  validateEngineerControlOutput,
} from "./models/engineer-output.js";
export {
  DEFAULT_MODEL_MAX_RETRIES,
  DEFAULT_MODEL_TIMEOUT_MS,
  createRoleModelClient,
  normalizeOpenAiCompatibleBaseUrl,
  resolveModelConfigForRole,
} from "./models/provider-factory.js";
export { executeEngineerTask } from "./runtime/engineer-task.js";
export { executeArchitectEngineerRun } from "./runtime/architect-engineer-run.js";
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
  CommandLogRecord,
  DossierArtifactKind,
  JsonPrimitive,
  JsonValue,
  RunArtifactFileReference,
  RunCheckResult,
  RunChecksSummary,
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
  EngineerAction,
  EngineerFinalAction,
  EngineerToolAction,
} from "./models/engineer-output.js";
export type {
  ArchitectPlanOutput,
  ArchitectReview,
  ArchitectReviewOutput,
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
  ArchitectEngineerRunExecution,
  ExecuteArchitectEngineerRunOptions,
} from "./runtime/architect-engineer-run.js";
