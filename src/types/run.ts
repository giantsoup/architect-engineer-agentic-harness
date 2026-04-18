export type JsonPrimitive = boolean | null | number | string;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export type RunLifecycleStatus =
  | "failed"
  | "initialized"
  | "running"
  | "stopped"
  | "success";

export type RunKind = "agent-chat" | "architect-engineer" | "command";

export type DossierArtifactKind = "json" | "jsonl" | "markdown" | "patch";

export interface RunPromptReference {
  id: string;
  sourcePath: string;
  sourceRoot: "package";
  version: string;
}

export interface RunSchemaReference {
  id: string;
  sourcePath: string;
  sourceRoot: "package";
  version: string;
}

export interface RunArtifactFileReference {
  fileName: string;
  kind: DossierArtifactKind;
  relativePath: string;
  root: "project";
}

export interface RunManifestFiles {
  architectPlan: RunArtifactFileReference;
  architectReview: RunArtifactFileReference;
  checks: RunArtifactFileReference;
  commandLog: RunArtifactFileReference;
  conversation: RunArtifactFileReference;
  diff: RunArtifactFileReference;
  engineerTask: RunArtifactFileReference;
  events: RunArtifactFileReference;
  failureNotes: RunArtifactFileReference;
  finalReport: RunArtifactFileReference;
  result: RunArtifactFileReference;
  run: RunArtifactFileReference;
}

export interface RunManifest {
  artifactsRootDir: string;
  createdAt: string;
  files: RunManifestFiles;
  kind?: RunKind | undefined;
  promptVersion: string;
  prompts: RunPromptReference[];
  runDir: string;
  runId: string;
  runsDir: string;
  schemaVersion: string;
  schemas: {
    architectPlan: RunSchemaReference;
    architectReview: RunSchemaReference;
    runResult: RunSchemaReference;
  };
  status: RunLifecycleStatus;
  updatedAt: string;
}

export interface StructuredMessageRecord {
  content: string;
  format?: "json" | "markdown" | "text";
  metadata?: { [key: string]: JsonValue | undefined };
  role: "agent" | "architect" | "engineer" | "system" | "tool" | "user";
  timestamp: string;
}

export interface ConversationMessageRecord {
  content: string;
  format?: "json" | "markdown" | "text";
  metadata?: { [key: string]: JsonValue | undefined };
  role: "agent" | "system" | "user";
  timestamp: string;
}

export interface CommandLogRecord {
  accessMode?: "inspect" | "mutate";
  command: string;
  containerName?: string;
  durationMs: number;
  environment?: Record<string, string>;
  executionTarget?: "docker" | "host";
  exitCode: number | null;
  role?: "agent" | "architect" | "engineer" | "system";
  stderr?: string;
  status?: "cancelled" | "completed" | "failed-to-start" | "timed-out";
  stdout?: string;
  timestamp: string;
  workingDirectory?: string;
}

export interface ToolCallErrorRecord {
  code:
    | "command-failed"
    | "git-failed"
    | "invalid-input"
    | "invalid-state"
    | "mcp-call-failed"
    | "mcp-not-allowed"
    | "mcp-server-unavailable"
    | "mcp-tool-not-found"
    | "path-violation"
    | "permission-denied";
  message: string;
  name: string;
}

export interface ToolCallRecord {
  durationMs: number;
  error?: ToolCallErrorRecord;
  request: { [key: string]: JsonValue | undefined };
  result?: { [key: string]: JsonValue | undefined };
  role: "agent" | "architect" | "engineer";
  status: "completed" | "failed";
  timestamp: string;
  toolName: string;
}

export interface RunCheckResult {
  command?: string;
  durationMs?: number;
  exitCode?: number;
  name: string;
  outputPath?: string;
  status: "failed" | "passed" | "skipped";
  summary?: string;
}

export interface RunChecksSummary {
  checks: RunCheckResult[];
  recordedAt?: string;
}

export interface GitWorkingTreeSummary {
  changedPaths: string[];
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  hasUntrackedChanges: boolean;
  isDirty: boolean;
}

export interface RunGitCommitSummary {
  commitHash: string;
  message: string;
  phase: "engineer-milestone" | "final-state";
  recordedAt: string;
}

export interface RunGitMetadata {
  createdCommits: RunGitCommitSummary[];
  dirtyWorkingTreeOutcome?: "clean" | "stopped";
  dirtyWorkingTreePolicy: "stop";
  errors: string[];
  finalCommit?: string;
  initialWorkingTree?: GitWorkingTreeSummary;
  runBranch?: string;
  startingBranch?: string;
  startingCommit?: string;
  warnings: string[];
}

export interface RunConvergenceMetrics {
  duplicateExplorationSuppressions: number;
  explorationBudget: number;
  explorationBudgetExhaustedAtStep: number | null;
  repeatedListingCount: number;
  repeatedReadCount: number;
  repoMemoryHits: number;
  stepsToFirstCheck: number | null;
  stepsToFirstEdit: number | null;
}

export interface RunResult {
  artifacts?: string[] | undefined;
  convergence?: RunConvergenceMetrics | undefined;
  git?: RunGitMetadata | undefined;
  status: "failed" | "stopped" | "success";
  summary: string;
}
