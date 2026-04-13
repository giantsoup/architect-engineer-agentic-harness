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
  promptVersion: string;
  prompts: RunPromptReference[];
  runDir: string;
  runId: string;
  runsDir: string;
  schemaVersion: string;
  schemas: {
    runResult: RunSchemaReference;
  };
  status: RunLifecycleStatus;
  updatedAt: string;
}

export interface StructuredMessageRecord {
  content: string;
  format?: "json" | "markdown" | "text";
  metadata?: { [key: string]: JsonValue | undefined };
  role: "architect" | "engineer" | "system" | "tool" | "user";
  timestamp: string;
}

export interface CommandLogRecord {
  command: string;
  durationMs: number;
  exitCode: number;
  role?: "architect" | "engineer" | "system";
  stderr?: string;
  stdout?: string;
  timestamp: string;
  workingDirectory?: string;
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

export interface RunResult {
  artifacts?: string[] | undefined;
  status: "failed" | "stopped" | "success";
  summary: string;
}
