import type { JsonValue } from "../types/run.js";

export type HarnessModelRole = "architect" | "engineer";

export type SupportedModelProvider = "llama.cpp" | "openai-compatible";

export type ModelChatRole =
  | "assistant"
  | "developer"
  | "system"
  | "tool"
  | "user";

export interface ModelChatMessage {
  content: string;
  name?: string | undefined;
  role: ModelChatRole;
  toolCallId?: string | undefined;
}

export interface ModelResponseUsage {
  completionTokens?: number | undefined;
  promptTokens?: number | undefined;
  totalTokens?: number | undefined;
}

export interface ModelStructuredOutputSpec<TStructured> {
  allowProviderFallback?: boolean | undefined;
  formatDescription?: string | undefined;
  formatName: string;
  schema: Record<string, unknown>;
  validate: (value: unknown) => Promise<TStructured> | TStructured;
}

export interface ModelChatRequest<TStructured = never> {
  maxOutputTokens?: number | undefined;
  messages: readonly ModelChatMessage[];
  metadata?: { [key: string]: JsonValue | undefined } | undefined;
  structuredOutput?: ModelStructuredOutputSpec<TStructured> | undefined;
  temperature?: number | undefined;
  topP?: number | undefined;
}

export interface ModelChatResponse<TStructured = never> {
  finishReason?: string | undefined;
  id: string;
  providerRequestId?: string | undefined;
  rawContent: string;
  role: "assistant";
  structuredOutput?: TStructured | undefined;
  usage?: ModelResponseUsage | undefined;
}

export interface ResolvedModelConfig {
  baseUrl: string;
  chatCompletionsUrl: string;
  headers: Readonly<Record<string, string>>;
  maxRetries: number;
  model: string;
  provider: SupportedModelProvider;
  role: HarnessModelRole;
  timeoutMs: number;
}

export interface ModelLogRequestEvent {
  attempt: number;
  configuredTimeoutMs: number;
  headers: Record<string, string>;
  messageCount: number;
  metadata?: { [key: string]: JsonValue | undefined } | undefined;
  payload: Record<string, unknown>;
  provider: SupportedModelProvider;
  role: HarnessModelRole;
  timestamp: string;
  url: string;
  usedNativeStructuredOutput: boolean;
}

export interface ModelLogResponseEvent {
  attempt: number;
  durationMs: number;
  finishReason?: string | undefined;
  provider: SupportedModelProvider;
  providerRequestId?: string | undefined;
  rawContent: string;
  role: HarnessModelRole;
  statusCode: number;
  structuredOutput?: JsonValue | undefined;
  timestamp: string;
  usage?: ModelResponseUsage | undefined;
}

export interface ModelLogRetryEvent {
  attempt: number;
  classification: string;
  message: string;
  nextAttempt: number;
  provider: SupportedModelProvider;
  retryable: boolean;
  role: HarnessModelRole;
  statusCode?: number | undefined;
  timestamp: string;
  usedNativeStructuredOutput: boolean;
}

export interface ModelLogErrorEvent {
  attempt: number;
  classification: string;
  issues?: readonly string[] | undefined;
  message: string;
  provider: SupportedModelProvider;
  retryable: boolean;
  role: HarnessModelRole;
  statusCode?: number | undefined;
  timestamp: string;
}

export interface ModelRequestLogger {
  onError?: (event: ModelLogErrorEvent) => Promise<void> | void;
  onRequest?: (event: ModelLogRequestEvent) => Promise<void> | void;
  onResponse?: (event: ModelLogResponseEvent) => Promise<void> | void;
  onRetry?: (event: ModelLogRetryEvent) => Promise<void> | void;
}

export type ArchitectStructuredOutputKind = "plan" | "review";

export interface ArchitectPlanOutput {
  acceptanceCriteria?: string[] | undefined;
  steps: string[];
  summary: string;
}

export interface ArchitectReview {
  decision: "approve" | "fail" | "revise";
  nextActions?: string[] | undefined;
  summary: string;
}

export type ArchitectReviewOutput = ArchitectReview;

export type ArchitectStructuredOutputValue =
  | ArchitectPlanOutput
  | ArchitectReviewOutput;

export type ArchitectStructuredOutputSchema<
  TStructured extends ArchitectStructuredOutputValue,
> = ModelStructuredOutputSpec<TStructured>;
