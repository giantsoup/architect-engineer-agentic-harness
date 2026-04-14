import type {
  ModelChatMessage,
  ModelChatRequest,
  ModelChatResponse,
  ModelLogErrorEvent,
  ModelRequestLogger,
  ModelStructuredOutputSpec,
  ResolvedModelConfig,
} from "./types.js";
import type { JsonValue } from "../types/run.js";

export type ModelClientErrorClassification =
  | "config"
  | "http"
  | "invalid-response"
  | "invalid-structured-output"
  | "network"
  | "timeout"
  | "unsupported-provider";

export class ModelClientError extends Error {
  readonly classification: ModelClientErrorClassification;
  readonly issues?: readonly string[] | undefined;
  readonly retryable: boolean;
  readonly statusCode?: number | undefined;

  constructor(
    classification: ModelClientErrorClassification,
    message: string,
    options: {
      cause?: unknown;
      issues?: readonly string[] | undefined;
      retryable?: boolean;
      statusCode?: number | undefined;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );

    this.name = new.target.name;
    this.classification = classification;
    this.issues = options.issues;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode;
  }
}

export class ModelClientConfigError extends ModelClientError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("config", message, options);
  }
}

export class ModelNetworkError extends ModelClientError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("network", message, {
      ...options,
      retryable: true,
    });
  }
}

export class ModelTimeoutError extends ModelClientError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("timeout", message, {
      ...options,
      retryable: true,
    });
  }
}

export class ModelHttpError extends ModelClientError {
  readonly bodyText?: string | undefined;

  constructor(
    message: string,
    options: {
      bodyText?: string | undefined;
      cause?: unknown;
      retryable?: boolean;
      statusCode: number;
    },
  ) {
    const baseOptions: {
      cause?: unknown;
      retryable?: boolean;
      statusCode?: number;
    } = {
      statusCode: options.statusCode,
    };

    if (options.cause !== undefined) {
      baseOptions.cause = options.cause;
    }

    if (options.retryable !== undefined) {
      baseOptions.retryable = options.retryable;
    }

    super("http", message, baseOptions);

    this.bodyText = options.bodyText;
  }
}

export class UnsupportedModelProviderError extends ModelClientError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("unsupported-provider", message, options);
  }
}

export class ModelResponseError extends ModelClientError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("invalid-response", message, options);
  }
}

export class ModelStructuredOutputError extends ModelClientError {
  readonly schemaName?: string | undefined;

  constructor(
    message: string,
    options: {
      cause?: unknown;
      issues?: readonly string[] | undefined;
      retryable?: boolean;
      schemaName?: string | undefined;
    } = {},
  ) {
    const baseOptions: {
      cause?: unknown;
      issues?: readonly string[] | undefined;
      retryable?: boolean;
    } = {
      cause: options.cause,
      issues: options.issues,
    };

    if (options.retryable !== undefined) {
      baseOptions.retryable = options.retryable;
    }

    super("invalid-structured-output", message, {
      ...baseOptions,
    });

    this.schemaName = options.schemaName;
  }
}

export interface OpenAiCompatibleChatClientOptions {
  config: ResolvedModelConfig;
  fetch?: typeof fetch;
  logger?: ModelRequestLogger;
  retryDelayMs?: number;
}

interface OpenAiChatCompletionChoice {
  finish_reason?: string | null;
  message?: {
    content?: string | Array<{ text?: string; type?: string }> | null;
    role?: string | null;
  } | null;
}

interface OpenAiChatCompletionResponse {
  choices?: OpenAiChatCompletionChoice[];
  id?: string;
  usage?: {
    completion_tokens?: number;
    prompt_tokens?: number;
    total_tokens?: number;
  };
}

export class OpenAiCompatibleChatClient {
  private readonly config: ResolvedModelConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: ModelRequestLogger | undefined;
  private readonly retryDelayMs: number;

  constructor(options: OpenAiCompatibleChatClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.logger = options.logger;
    this.retryDelayMs = options.retryDelayMs ?? 100;
  }

  async chat<TStructured = never>(
    request: ModelChatRequest<TStructured>,
  ): Promise<ModelChatResponse<TStructured>> {
    if (request.messages.length === 0) {
      throw new ModelClientConfigError(
        `Cannot send an empty chat request to ${this.describeTarget()}.`,
      );
    }

    let usedNativeStructuredOutput = this.shouldUseNativeStructuredOutput(
      request.structuredOutput,
    );
    let attempt = 1;
    const maxAttempts = this.config.maxRetries + 1;

    while (true) {
      const requestTimestamp = new Date().toISOString();
      const startedAt = Date.now();
      const payload = this.buildRequestPayload(
        request,
        usedNativeStructuredOutput,
      );

      await this.logger?.onRequest?.({
        attempt,
        configuredTimeoutMs: this.config.timeoutMs,
        headers: { ...this.config.headers },
        messageCount: request.messages.length,
        metadata: request.metadata,
        payload,
        provider: this.config.provider,
        role: this.config.role,
        timestamp: requestTimestamp,
        url: this.config.chatCompletionsUrl,
        usedNativeStructuredOutput,
      });

      try {
        const response = await this.executeRequest(payload);

        if (!response.ok) {
          const bodyText = await response.text();
          const httpError = createHttpError(
            this.config,
            response.status,
            bodyText,
          );

          if (
            usedNativeStructuredOutput &&
            request.structuredOutput?.allowProviderFallback !== false &&
            isNativeStructuredOutputUnsupported(httpError)
          ) {
            await this.logger?.onRetry?.({
              attempt,
              classification: "unsupported-provider",
              message:
                "Provider rejected native structured output. Retrying without response_format and validating locally.",
              nextAttempt: attempt,
              provider: this.config.provider,
              retryable: true,
              role: this.config.role,
              statusCode: response.status,
              timestamp: new Date().toISOString(),
              usedNativeStructuredOutput,
            });
            usedNativeStructuredOutput = false;
            continue;
          }

          if (httpError.retryable && attempt < maxAttempts) {
            await this.logRetry(httpError, attempt, usedNativeStructuredOutput);
            await delay(this.getRetryDelay(attempt));
            attempt += 1;
            continue;
          }

          await this.logError(httpError, attempt);
          throw httpError;
        }

        const responseJson = await parseOpenAiChatCompletionResponse(
          response,
          this.describeTarget(),
        );
        const choice = responseJson.choices?.[0];
        const assistantContent = extractAssistantContent(choice);
        const structuredOutput = await this.resolveStructuredOutput(
          request.structuredOutput,
          assistantContent,
        );
        const responseTimestamp = new Date().toISOString();

        const parsedResponse: ModelChatResponse<TStructured> = {
          finishReason: choice?.finish_reason ?? undefined,
          id: responseJson.id ?? `chatcmpl-local-${responseTimestamp}`,
          providerRequestId: response.headers.get("x-request-id") ?? undefined,
          rawContent: assistantContent,
          role: "assistant",
          structuredOutput,
          usage:
            responseJson.usage === undefined
              ? undefined
              : {
                  completionTokens: responseJson.usage.completion_tokens,
                  promptTokens: responseJson.usage.prompt_tokens,
                  totalTokens: responseJson.usage.total_tokens,
                },
        };

        await this.logger?.onResponse?.({
          attempt,
          durationMs: Date.now() - startedAt,
          finishReason: parsedResponse.finishReason,
          provider: this.config.provider,
          providerRequestId: parsedResponse.providerRequestId,
          rawContent: parsedResponse.rawContent,
          role: this.config.role,
          statusCode: response.status,
          structuredOutput: toJsonValue(parsedResponse.structuredOutput),
          timestamp: responseTimestamp,
          usage: parsedResponse.usage,
        });

        return parsedResponse;
      } catch (error) {
        const modelError = toModelClientError(this.config, error);

        if (modelError.retryable && attempt < maxAttempts) {
          await this.logRetry(modelError, attempt, usedNativeStructuredOutput);
          await delay(this.getRetryDelay(attempt));
          attempt += 1;
          continue;
        }

        await this.logError(modelError, attempt);
        throw modelError;
      }
    }
  }

  private buildRequestPayload<TStructured>(
    request: ModelChatRequest<TStructured>,
    useNativeStructuredOutput: boolean,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      max_tokens: request.maxOutputTokens,
      messages: this.buildMessages(request, useNativeStructuredOutput),
      model: this.config.model,
      temperature: request.temperature,
      top_p: request.topP,
    };

    if (request.maxOutputTokens === undefined) {
      delete payload.max_tokens;
    }

    if (request.temperature === undefined) {
      delete payload.temperature;
    }

    if (request.topP === undefined) {
      delete payload.top_p;
    }

    if (useNativeStructuredOutput && request.structuredOutput !== undefined) {
      payload.response_format = {
        json_schema: {
          name: request.structuredOutput.formatName,
          schema: request.structuredOutput.schema,
          strict: true,
        },
        type: "json_schema",
      };
    }

    return payload;
  }

  private buildMessages<TStructured>(
    request: ModelChatRequest<TStructured>,
    useNativeStructuredOutput: boolean,
  ): Array<Record<string, string>> {
    const messages = request.messages.map((message) => toOpenAiMessage(message));

    if (!useNativeStructuredOutput && request.structuredOutput !== undefined) {
      messages.push({
        content: renderStructuredOutputFallbackInstruction(
          request.structuredOutput,
        ),
        role: "developer",
      });
    }

    return messages;
  }

  private async executeRequest(
    payload: Record<string, unknown>,
  ): Promise<Response> {
    const abortController = new AbortController();
    const timeoutId = setTimeout(
      () => abortController.abort(),
      this.config.timeoutMs,
    );

    try {
      return await this.fetchImpl(this.config.chatCompletionsUrl, {
        body: JSON.stringify(payload),
        headers: this.config.headers,
        method: "POST",
        signal: abortController.signal,
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new ModelTimeoutError(
          `Timed out after ${this.config.timeoutMs}ms calling ${this.describeTarget()}.`,
          { cause: error },
        );
      }

      throw new ModelNetworkError(
        `Network failure calling ${this.describeTarget()}: ${describeUnknownError(error)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async resolveStructuredOutput<TStructured>(
    structuredOutput: ModelStructuredOutputSpec<TStructured> | undefined,
    rawContent: string,
  ): Promise<TStructured | undefined> {
    if (structuredOutput === undefined) {
      return undefined;
    }

    const candidateJsonSnippets = collectStructuredOutputCandidates(rawContent);
    let lastParseError: unknown;
    let lastValidationError: unknown;

    for (const candidateJson of candidateJsonSnippets) {
      let parsedJson: unknown;

      try {
        parsedJson = JSON.parse(candidateJson);
      } catch (error) {
        lastParseError = error;
        continue;
      }

      try {
        return await structuredOutput.validate(parsedJson);
      } catch (error) {
        lastValidationError = error;

        const normalizedJson = normalizeStructuredOutputCandidate(
          structuredOutput.formatName,
          parsedJson,
        );

        if (normalizedJson !== parsedJson) {
          try {
            return await structuredOutput.validate(normalizedJson);
          } catch (normalizedError) {
            lastValidationError = normalizedError;
          }
        }
      }
    }

    if (lastValidationError !== undefined) {
      const issues =
        lastValidationError instanceof Error && "issues" in lastValidationError
          ? ((lastValidationError as { issues?: readonly string[] }).issues ??
              undefined)
          : undefined;
      const schemaPath =
        lastValidationError instanceof Error &&
        "schemaPath" in lastValidationError
          ? ((lastValidationError as { schemaPath?: string }).schemaPath ??
              undefined)
          : undefined;
      const retryable = isRetryableStructuredOutputFailure({
        candidateCount: candidateJsonSnippets.length,
        formatName: structuredOutput.formatName,
        issues,
        rawContent,
      });

      throw new ModelStructuredOutputError(
        schemaPath === undefined
          ? `Structured output from ${this.describeTarget()} did not match ${structuredOutput.formatName}.`
          : `Structured output from ${this.describeTarget()} did not match ${structuredOutput.formatName} (${schemaPath}).`,
        {
          cause: lastValidationError,
          issues,
          retryable,
          schemaName: structuredOutput.formatName,
        },
      );
    }

    const retryable = isRetryableStructuredOutputFailure({
      candidateCount: candidateJsonSnippets.length,
      formatName: structuredOutput.formatName,
      rawContent,
    });

    throw new ModelStructuredOutputError(
      `Expected valid JSON for structured output from ${this.describeTarget()}, but the response could not be parsed.`,
      {
        cause: lastParseError,
        retryable,
        schemaName: structuredOutput.formatName,
      },
    );
  }

  private shouldUseNativeStructuredOutput<TStructured>(
    structuredOutput: ModelStructuredOutputSpec<TStructured> | undefined,
  ): boolean {
    return (
      structuredOutput !== undefined && this.config.provider !== "llama.cpp"
    );
  }

  private async logRetry(
    error: ModelClientError,
    attempt: number,
    usedNativeStructuredOutput: boolean,
  ): Promise<void> {
    await this.logger?.onRetry?.({
      attempt,
      classification: error.classification,
      message: error.message,
      nextAttempt: attempt + 1,
      provider: this.config.provider,
      retryable: error.retryable,
      role: this.config.role,
      statusCode: error.statusCode,
      timestamp: new Date().toISOString(),
      usedNativeStructuredOutput,
    });
  }

  private async logError(
    error: ModelClientError,
    attempt: number,
  ): Promise<void> {
    const event: ModelLogErrorEvent = {
      attempt,
      classification: error.classification,
      issues: error.issues,
      message: error.message,
      provider: this.config.provider,
      retryable: error.retryable,
      role: this.config.role,
      statusCode: error.statusCode,
      timestamp: new Date().toISOString(),
    };

    await this.logger?.onError?.(event);
  }

  private getRetryDelay(attempt: number): number {
    return this.retryDelayMs * attempt;
  }

  private describeTarget(): string {
    return `${this.config.role} model \`${this.config.model}\` at ${this.config.chatCompletionsUrl}`;
  }
}

function toOpenAiMessage(message: ModelChatMessage): Record<string, string> {
  const normalizedRole = normalizeOpenAiMessageRole(message.role);
  const normalizedContent =
    message.role === "tool"
      ? renderToolResultMessage(message)
      : message.content;
  const openAiMessage: Record<string, string> = {
    content: normalizedContent,
    role: normalizedRole,
  };

  if (message.name !== undefined && normalizedRole !== "user") {
    openAiMessage.name = message.name;
  }

  if (message.toolCallId !== undefined && normalizedRole === "tool") {
    openAiMessage.tool_call_id = message.toolCallId;
  }

  return openAiMessage;
}

function normalizeOpenAiMessageRole(role: ModelChatMessage["role"]): string {
  switch (role) {
    case "assistant":
      return "assistant";
    case "developer":
      return "system";
    case "system":
      return "system";
    case "tool":
      return "user";
    case "user":
      return "user";
  }
}

function renderToolResultMessage(message: ModelChatMessage): string {
  const toolLabel = message.name === undefined ? "tool" : message.name;

  return [
    `Tool result for ${toolLabel}:`,
    message.content,
  ].join("\n");
}

function extractAssistantContent(
  choice: OpenAiChatCompletionChoice | undefined,
): string {
  const content = choice?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textContent = content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("");

    if (textContent.length > 0) {
      return textContent;
    }
  }

  throw new ModelResponseError(
    "OpenAI-compatible response did not include assistant text content in choices[0].message.content.",
  );
}

function createHttpError(
  config: ResolvedModelConfig,
  statusCode: number,
  bodyText: string,
): ModelHttpError | UnsupportedModelProviderError {
  const providerMessage = extractProviderErrorMessage(bodyText);
  const errorMessage = `OpenAI-compatible request to ${config.role} model \`${config.model}\` failed with HTTP ${statusCode}${providerMessage.length > 0 ? `: ${providerMessage}` : "."}`;

  if (isNativeStructuredOutputUnsupportedStatus(statusCode, providerMessage)) {
    return new UnsupportedModelProviderError(errorMessage);
  }

  return new ModelHttpError(errorMessage, {
    bodyText,
    retryable: [408, 409, 425, 429, 500, 502, 503, 504].includes(statusCode),
    statusCode,
  });
}

function extractProviderErrorMessage(bodyText: string): string {
  const trimmedBody = bodyText.trim();

  if (trimmedBody.length === 0) {
    return "";
  }

  try {
    const parsedBody = JSON.parse(trimmedBody) as {
      error?: { message?: string; type?: string };
      message?: string;
    };

    if (typeof parsedBody.error?.message === "string") {
      return parsedBody.error.message;
    }

    if (typeof parsedBody.message === "string") {
      return parsedBody.message;
    }
  } catch {
    return trimmedBody;
  }

  return trimmedBody;
}

function isNativeStructuredOutputUnsupported(error: ModelClientError): boolean {
  if (error.classification === "unsupported-provider") {
    return true;
  }

  if (error.classification !== "http") {
    return false;
  }

  return isNativeStructuredOutputUnsupportedStatus(
    error.statusCode ?? 0,
    error.message,
  );
}

function isNativeStructuredOutputUnsupportedStatus(
  statusCode: number,
  message: string,
): boolean {
  if (![400, 404, 415, 422, 501].includes(statusCode)) {
    return false;
  }

  const normalizedMessage = message.toLowerCase();

  return (
    normalizedMessage.includes("response_format") ||
    normalizedMessage.includes("json_schema") ||
    normalizedMessage.includes("schema") ||
    normalizedMessage.includes("unsupported") ||
    normalizedMessage.includes("iterating prediction stream") ||
    normalizedMessage.includes("'type' must be a string") ||
    normalizedMessage.includes('"type" must be a string')
  );
}

function toModelClientError(
  config: ResolvedModelConfig,
  error: unknown,
): ModelClientError {
  if (error instanceof ModelClientError) {
    return error;
  }

  return new ModelNetworkError(
    `Unexpected failure calling ${config.role} model \`${config.model}\`: ${describeUnknownError(error)}`,
    { cause: error },
  );
}

function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function parseOpenAiChatCompletionResponse(
  response: Response,
  targetDescription: string,
): Promise<OpenAiChatCompletionResponse> {
  try {
    return (await response.json()) as OpenAiChatCompletionResponse;
  } catch (error) {
    throw new ModelResponseError(
      `OpenAI-compatible response from ${targetDescription} was not valid JSON.`,
      { cause: error },
    );
  }
}

function extractJsonCodeFence(rawContent: string): string | undefined {
  const fencedMatch =
    /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(rawContent) ??
    /```(?:json)?\s*([\s\S]*?)\s*```/iu.exec(rawContent);

  return fencedMatch?.[1];
}

function collectStructuredOutputCandidates(rawContent: string): string[] {
  const trimmedContent = rawContent.trim();
  const candidates: string[] = [];
  const seen = new Set<string>();

  function addCandidate(candidate: string | undefined): void {
    if (candidate === undefined) {
      return;
    }

    const trimmedCandidate = candidate.trim();

    if (trimmedCandidate.length === 0 || seen.has(trimmedCandidate)) {
      return;
    }

    seen.add(trimmedCandidate);
    candidates.push(trimmedCandidate);
  }

  addCandidate(trimmedContent);

  const fencedJson = extractJsonCodeFence(trimmedContent);
  addCandidate(fencedJson);

  for (const candidate of extractLikelyStructuredObjectCandidates(trimmedContent)) {
    addCandidate(candidate);
  }

  for (const candidate of extractTopLevelJsonCandidates(trimmedContent)) {
    addCandidate(candidate);
  }

  if (fencedJson !== undefined) {
    for (const candidate of extractLikelyStructuredObjectCandidates(fencedJson)) {
      addCandidate(candidate);
    }

    for (const candidate of extractTopLevelJsonCandidates(fencedJson)) {
      addCandidate(candidate);
    }
  }

  return candidates;
}

function extractTopLevelJsonCandidates(rawContent: string): string[] {
  const candidates: string[] = [];

  for (let index = 0; index < rawContent.length; index += 1) {
    const character = rawContent[index];

    if (character !== "{" && character !== "[") {
      continue;
    }

    const endIndex = findBalancedJsonEnd(rawContent, index);

    if (endIndex === undefined) {
      continue;
    }

    candidates.push(rawContent.slice(index, endIndex + 1));
    index = endIndex;
  }

  return candidates;
}

function extractLikelyStructuredObjectCandidates(rawContent: string): string[] {
  const candidates: string[] = [];
  const anchorPattern =
    /\{\s*"type"\s*:|\{\s*"summary"\s*:|\{\s*"request"\s*:|\{\s*"outcome"\s*:/gu;

  for (const match of rawContent.matchAll(anchorPattern)) {
    const startIndex = match.index;

    if (startIndex === undefined) {
      continue;
    }

    const endIndex = findBalancedJsonEnd(rawContent, startIndex);

    if (endIndex === undefined) {
      continue;
    }

    candidates.push(rawContent.slice(startIndex, endIndex + 1));
  }

  return candidates;
}

function findBalancedJsonEnd(
  rawContent: string,
  startIndex: number,
): number | undefined {
  const stack = [rawContent[startIndex]];
  let inString = false;
  let isEscaped = false;

  for (let index = startIndex + 1; index < rawContent.length; index += 1) {
    const character = rawContent[index];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (character === "\\") {
        isEscaped = true;
        continue;
      }

      if (character === '"') {
        inString = false;
      }

      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === "{" || character === "[") {
      stack.push(character);
      continue;
    }

    if (character !== "}" && character !== "]") {
      continue;
    }

    const expectedOpen = character === "}" ? "{" : "[";
    const actualOpen = stack.pop();

    if (actualOpen !== expectedOpen) {
      return undefined;
    }

    if (stack.length === 0) {
      return index;
    }
  }

  return undefined;
}

function isRetryableStructuredOutputFailure(options: {
  candidateCount: number;
  formatName: string;
  issues?: readonly string[] | undefined;
  rawContent: string;
}): boolean {
  if (options.formatName !== "engineer_action") {
    return false;
  }

  if (
    options.rawContent.includes("{") ||
    options.rawContent.includes("[") ||
    options.rawContent.includes("```")
  ) {
    return true;
  }

  if ((options.issues?.length ?? 0) > 0 && options.candidateCount > 0) {
    return true;
  }

  return false;
}

function normalizeStructuredOutputCandidate(
  formatName: string,
  value: unknown,
): unknown {
  if (formatName !== "engineer_action" || !isPlainObject(value)) {
    return value;
  }

  if (value.type === "tool") {
    const normalized: Record<string, unknown> = {
      request: normalizeEngineerToolRequest(value.request),
      summary: value.summary,
      type: value.type,
    };

    if (value.stopWhenSuccessful !== undefined) {
      normalized.stopWhenSuccessful = value.stopWhenSuccessful;
    }

    return normalized;
  }

  if (value.type === "final") {
    const normalized: Record<string, unknown> = {
      outcome: value.outcome,
      summary: value.summary,
      type: value.type,
    };

    if (value.blockers !== undefined) {
      normalized.blockers = value.blockers;
    }

    return normalized;
  }

  return value;
}

function normalizeEngineerToolRequest(value: unknown): unknown {
  if (!isPlainObject(value) || typeof value.toolName !== "string") {
    return value;
  }

  switch (value.toolName) {
    case "file.read":
      return {
        path: value.path,
        toolName: value.toolName,
      };
    case "file.write":
      return {
        content: value.content,
        path: value.path,
        toolName: value.toolName,
      };
    case "file.list":
      return {
        ...(value.path === undefined ? {} : { path: value.path }),
        toolName: value.toolName,
      };
    case "command.execute":
      return {
        ...(value.accessMode === undefined
          ? {}
          : { accessMode: value.accessMode }),
        command: value.command,
        ...(value.environment === undefined
          ? {}
          : { environment: value.environment }),
        ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
        toolName: value.toolName,
        ...(value.workingDirectory === undefined
          ? {}
          : { workingDirectory: value.workingDirectory }),
      };
    case "git.status":
      return {
        toolName: value.toolName,
      };
    case "git.diff":
      return {
        ...(value.staged === undefined ? {} : { staged: value.staged }),
        toolName: value.toolName,
      };
    case "mcp.call":
      return {
        ...(value.arguments === undefined ? {} : { arguments: value.arguments }),
        name: value.name,
        server: value.server,
        toolName: value.toolName,
      };
    default:
      return value;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderStructuredOutputFallbackInstruction<TStructured>(
  structuredOutput: ModelStructuredOutputSpec<TStructured>,
): string {
  return [
    `Structured output fallback mode for ${structuredOutput.formatName}.`,
    "Return exactly one JSON object and nothing else.",
    "Do not include markdown fences, comments, prose, or multiple JSON objects.",
    `The JSON must match this schema exactly: ${JSON.stringify(structuredOutput.schema)}`,
  ].join("\n");
}

async function delay(durationMs: number): Promise<void> {
  if (durationMs <= 0) {
    return;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
