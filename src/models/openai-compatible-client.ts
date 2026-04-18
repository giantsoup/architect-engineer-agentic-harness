import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelLogErrorEvent,
  ModelToolCall,
  ModelRequestLogger,
  ModelStructuredOutputSpec,
  ResolvedModelConfig,
} from "./types.js";
import type { JsonValue } from "../types/run.js";
import type { HarnessEventBus } from "../runtime/harness-events.js";
import { OperationCancelledError } from "../cancellation.js";
import {
  resolveModelFamilyAdapter,
  type ModelFamilyAdapter,
  type ModelToolCallMode,
} from "./model-family-adapter.js";
import { normalizeEngineerToolRequestCandidate } from "./engineer-output.js";

export type ModelClientErrorClassification =
  | "cancelled"
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

export class ModelCancelledError extends ModelClientError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("cancelled", message, {
      ...options,
      retryable: false,
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
  eventBus?: HarnessEventBus;
  fetch?: typeof fetch;
  logger?: ModelRequestLogger;
  retryDelayMs?: number;
}

interface OpenAiChatCompletionChoice {
  finish_reason?: string | null;
  message?: {
    content?: string | Array<{ text?: string; type?: string }> | null;
    role?: string | null;
    tool_calls?: OpenAiChatCompletionToolCall[] | null;
  } | null;
}

interface OpenAiChatCompletionToolCall {
  function?: {
    arguments?: string | Record<string, JsonValue> | null;
    name?: string | null;
  } | null;
  id?: string | null;
  type?: string | null;
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
  private readonly modelFamilyAdapter: ModelFamilyAdapter;
  private readonly retryDelayMs: number;

  constructor(options: OpenAiCompatibleChatClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.logger = combineModelRequestLoggers(
      createHarnessEventModelLogger(options.eventBus, this.config),
      options.logger,
    );
    this.modelFamilyAdapter = resolveModelFamilyAdapter(this.config);
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
    let toolCallMode: ModelToolCallMode =
      (request.tools?.length ?? 0) > 0 ? "native" : "disabled";
    let useReasoningControl =
      this.config.role === "engineer" &&
      this.modelFamilyAdapter.shouldDisableReasoningParameter();
    let attempt = 1;
    const maxAttempts = this.config.maxRetries + 1;

    while (true) {
      const requestTimestamp = new Date().toISOString();
      const startedAt = Date.now();
      const payload = this.buildRequestPayload(
        request,
        toolCallMode,
        usedNativeStructuredOutput,
        useReasoningControl,
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
        const response = await this.executeRequest(payload, request.signal);

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

          if (
            toolCallMode === "native" &&
            isNativeToolCallingUnsupported(httpError)
          ) {
            await this.logger?.onRetry?.({
              attempt,
              classification: "unsupported-provider",
              message:
                "Provider rejected native tool calling. Retrying with the fallback engineer tool protocol.",
              nextAttempt: attempt,
              provider: this.config.provider,
              retryable: true,
              role: this.config.role,
              statusCode: response.status,
              timestamp: new Date().toISOString(),
              usedNativeStructuredOutput,
            });
            toolCallMode = "fallback";
            continue;
          }

          if (
            useReasoningControl &&
            isReasoningParameterUnsupported(httpError)
          ) {
            await this.logger?.onRetry?.({
              attempt,
              classification: "unsupported-provider",
              message:
                "Provider rejected the Qwen non-thinking request parameter. Retrying without it.",
              nextAttempt: attempt,
              provider: this.config.provider,
              retryable: true,
              role: this.config.role,
              statusCode: response.status,
              timestamp: new Date().toISOString(),
              usedNativeStructuredOutput,
            });
            useReasoningControl = false;
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
        let assistantContent: string;
        let toolCalls: readonly ModelToolCall[];

        try {
          const extractedResponse =
            this.modelFamilyAdapter.extractToolCalls(choice);
          assistantContent = extractedResponse.assistantContent;
          toolCalls =
            this.config.role === "engineer"
              ? normalizeEngineerToolCalls(extractedResponse.toolCalls)
              : extractedResponse.toolCalls;
        } catch (error) {
          throw new ModelResponseError(
            `OpenAI-compatible response from ${this.describeTarget()} could not be parsed.`,
            { cause: error },
          );
        }
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
          ...(toolCalls.length === 0 ? {} : { toolCalls }),
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
    toolCallMode: ModelToolCallMode,
    useNativeStructuredOutput: boolean,
    useReasoningControl: boolean,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      max_tokens: request.maxOutputTokens,
      messages: this.modelFamilyAdapter.buildMessages(request, {
        toolCallMode,
        useNativeStructuredOutput,
      }),
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

    const toolPayload = this.modelFamilyAdapter.buildToolPayload(
      request.tools,
      toolCallMode,
    );

    if (toolPayload !== undefined) {
      payload.tools = toolPayload;
    }

    if (useReasoningControl) {
      payload.extra_body = {
        chat_template_kwargs: {
          enable_thinking: false,
        },
      };
    }

    return payload;
  }

  private async executeRequest(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(
      () => timeoutController.abort(),
      this.config.timeoutMs,
    );
    const requestSignal =
      signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([signal, timeoutController.signal]);

    try {
      return await this.fetchImpl(this.config.chatCompletionsUrl, {
        body: JSON.stringify(payload),
        headers: this.config.headers,
        method: "POST",
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted === true) {
        throw new ModelCancelledError(
          `Cancelled request to ${this.describeTarget()}.`,
          { cause: error },
        );
      }

      if (timeoutController.signal.aborted) {
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
    const hasAmbiguousArchitectJson = isAmbiguousArchitectStructuredOutput(
      structuredOutput.formatName,
      rawContent,
    );
    const validatedArchitectCandidates = new Map<string, TStructured>();
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
        const validatedOutput = await structuredOutput.validate(parsedJson);

        if (!hasAmbiguousArchitectJson) {
          return validatedOutput;
        }

        validatedArchitectCandidates.set(
          JSON.stringify(validatedOutput),
          validatedOutput,
        );
        continue;
      } catch (error) {
        lastValidationError = error;

        const normalizedJson = normalizeStructuredOutputCandidate(
          structuredOutput.formatName,
          parsedJson,
        );

        if (normalizedJson !== parsedJson) {
          try {
            const validatedOutput =
              await structuredOutput.validate(normalizedJson);

            if (!hasAmbiguousArchitectJson) {
              return validatedOutput;
            }

            validatedArchitectCandidates.set(
              JSON.stringify(validatedOutput),
              validatedOutput,
            );
          } catch (normalizedError) {
            lastValidationError = normalizedError;
          }
        }
      }
    }

    if (hasAmbiguousArchitectJson) {
      if (validatedArchitectCandidates.size === 1) {
        return validatedArchitectCandidates.values().next()
          .value as TStructured;
      }

      if (validatedArchitectCandidates.size > 1) {
        throw createAmbiguousArchitectStructuredOutputError(
          this.describeTarget(),
          structuredOutput.formatName,
        );
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

function createHarnessEventModelLogger(
  eventBus: HarnessEventBus | undefined,
  config: ResolvedModelConfig,
): ModelRequestLogger | undefined {
  if (eventBus === undefined) {
    return undefined;
  }

  const requestRunIds = new Map<number, string>();

  return {
    onRequest(event) {
      const runId = resolveModelRunId(event.metadata);

      if (runId !== undefined) {
        requestRunIds.set(event.attempt, runId);
      } else {
        requestRunIds.delete(event.attempt);
      }

      eventBus.emit({
        type: "model:request",
        attempt: event.attempt,
        configuredTimeoutMs: event.configuredTimeoutMs,
        messageCount: event.messageCount,
        metadata: event.metadata,
        model: config.model,
        provider: event.provider,
        role: event.role,
        ...(runId === undefined ? {} : { runId }),
        timestamp: event.timestamp,
        url: event.url,
        usedNativeStructuredOutput: event.usedNativeStructuredOutput,
      });
    },
    onRetry(event) {
      const runId = requestRunIds.get(event.attempt);

      eventBus.emit({
        type: "model:retry",
        attempt: event.attempt,
        classification: event.classification,
        message: event.message,
        model: config.model,
        nextAttempt: event.nextAttempt,
        provider: event.provider,
        retryable: event.retryable,
        role: event.role,
        ...(runId === undefined ? {} : { runId }),
        statusCode: event.statusCode,
        timestamp: event.timestamp,
        usedNativeStructuredOutput: event.usedNativeStructuredOutput,
      });

      requestRunIds.delete(event.attempt);
    },
    onError(event) {
      requestRunIds.delete(event.attempt);
    },
    onResponse(event) {
      requestRunIds.delete(event.attempt);
    },
  };
}

function combineModelRequestLoggers(
  primaryLogger: ModelRequestLogger | undefined,
  secondaryLogger: ModelRequestLogger | undefined,
): ModelRequestLogger | undefined {
  if (primaryLogger === undefined) {
    return secondaryLogger;
  }

  if (secondaryLogger === undefined) {
    return primaryLogger;
  }

  return {
    onError: async (event) => {
      await primaryLogger.onError?.(event);
      await secondaryLogger.onError?.(event);
    },
    onRequest: async (event) => {
      await primaryLogger.onRequest?.(event);
      await secondaryLogger.onRequest?.(event);
    },
    onResponse: async (event) => {
      await primaryLogger.onResponse?.(event);
      await secondaryLogger.onResponse?.(event);
    },
    onRetry: async (event) => {
      await primaryLogger.onRetry?.(event);
      await secondaryLogger.onRetry?.(event);
    },
  };
}

function resolveModelRunId(
  metadata: { [key: string]: JsonValue | undefined } | undefined,
): string | undefined {
  const runId = metadata?.runId;

  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
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

function isNativeToolCallingUnsupported(error: ModelClientError): boolean {
  if (error.classification === "unsupported-provider") {
    return false;
  }

  if (error.classification !== "http") {
    return false;
  }

  return isNativeToolCallingUnsupportedStatus(
    error.statusCode ?? 0,
    error.message,
  );
}

function isReasoningParameterUnsupported(error: ModelClientError): boolean {
  if (error.classification !== "http") {
    return false;
  }

  if (![400, 404, 415, 422, 501].includes(error.statusCode ?? 0)) {
    return false;
  }

  const normalizedMessage = error.message.toLowerCase();

  return (
    normalizedMessage.includes("enable_thinking") ||
    normalizedMessage.includes("chat_template_kwargs") ||
    normalizedMessage.includes("extra_body") ||
    normalizedMessage.includes("thinking mode") ||
    normalizedMessage.includes("enable thinking")
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
    normalizedMessage.includes("iterating prediction stream") ||
    normalizedMessage.includes("'type' must be a string") ||
    normalizedMessage.includes('"type" must be a string')
  );
}

function isNativeToolCallingUnsupportedStatus(
  statusCode: number,
  message: string,
): boolean {
  if (![400, 404, 415, 422, 501].includes(statusCode)) {
    return false;
  }

  const normalizedMessage = message.toLowerCase();

  return (
    normalizedMessage.includes("tool_calls") ||
    normalizedMessage.includes("tool_choice") ||
    normalizedMessage.includes("parallel_tool_calls") ||
    normalizedMessage.includes("function calling") ||
    normalizedMessage.includes("tools are not supported") ||
    normalizedMessage.includes("functions are not supported")
  );
}

function toModelClientError(
  config: ResolvedModelConfig,
  error: unknown,
): ModelClientError {
  if (error instanceof ModelClientError) {
    return error;
  }

  if (error instanceof OperationCancelledError) {
    return new ModelCancelledError(
      `Cancelled request to ${config.role} model \`${config.model}\`.`,
      { cause: error },
    );
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

  for (const candidate of extractLikelyStructuredObjectCandidates(
    trimmedContent,
  )) {
    addCandidate(candidate);
  }

  for (const candidate of extractTopLevelJsonCandidates(trimmedContent)) {
    addCandidate(candidate);
  }

  if (fencedJson !== undefined) {
    for (const candidate of extractLikelyStructuredObjectCandidates(
      fencedJson,
    )) {
      addCandidate(candidate);
    }

    for (const candidate of extractTopLevelJsonCandidates(fencedJson)) {
      addCandidate(candidate);
    }
  }

  return candidates;
}

function isAmbiguousArchitectStructuredOutput(
  formatName: string,
  rawContent: string,
): boolean {
  if (formatName !== "architect_plan" && formatName !== "architect_review") {
    return false;
  }

  const topLevelCandidates = extractTopLevelJsonCandidates(rawContent.trim());

  return topLevelCandidates.length > 1;
}

function createAmbiguousArchitectStructuredOutputError(
  targetDescription: string,
  formatName: string,
): ModelStructuredOutputError {
  return new ModelStructuredOutputError(
    `Structured output from ${targetDescription} was ambiguous for ${formatName}.`,
    {
      issues: [
        "Response contained multiple top-level JSON objects. Return exactly one JSON object and nothing else.",
      ],
      retryable: true,
      schemaName: formatName,
    },
  );
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
  if (
    options.formatName !== "engineer_action" &&
    options.formatName !== "architect_plan" &&
    options.formatName !== "architect_review"
  ) {
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
  if (!isPlainObject(value)) {
    return value;
  }

  switch (formatName) {
    case "engineer_action":
      return normalizeEngineerActionCandidate(value);
    case "architect_plan":
      return normalizeArchitectPlanCandidate(value);
    case "architect_review":
      return normalizeArchitectReviewCandidate(value);
    default:
      return value;
  }
}

function normalizeEngineerActionCandidate(
  value: Record<string, unknown>,
): unknown {
  const normalizedType = normalizeLowercaseString(value.type);

  if (normalizedType === "tool") {
    const normalized: Record<string, unknown> = {
      request: normalizeToolRequestCandidate(value.request),
      summary: normalizeTrimmedString(value.summary),
      type: normalizedType,
    };
    const normalizedStopWhenSuccessful = normalizeBooleanLike(
      value.stopWhenSuccessful,
    );

    if (normalizedStopWhenSuccessful !== undefined) {
      normalized.stopWhenSuccessful = normalizedStopWhenSuccessful;
    }

    return normalized;
  }

  if (normalizedType === "final") {
    const normalized: Record<string, unknown> = {
      outcome: normalizeLowercaseString(value.outcome),
      summary: normalizeTrimmedString(value.summary),
      type: normalizedType,
    };
    const normalizedBlockers = normalizeStringList(value.blockers);

    if (normalizedBlockers !== undefined) {
      normalized.blockers = normalizedBlockers;
    }

    return normalized;
  }

  return value;
}

function normalizeArchitectPlanCandidate(
  value: Record<string, unknown>,
): unknown {
  if (normalizeLowercaseString(value.type) === "tool") {
    return {
      request: normalizeToolRequestCandidate(value.request),
      summary: normalizeTrimmedString(value.summary),
      type: "tool",
    };
  }

  const normalized: Record<string, unknown> = {
    steps: normalizeStringList(value.steps),
    summary: normalizeTrimmedString(value.summary),
  };
  const normalizedAcceptanceCriteria = normalizeStringList(
    value.acceptanceCriteria,
  );
  const normalizedType = normalizeLowercaseString(value.type);

  if (normalizedAcceptanceCriteria !== undefined) {
    normalized.acceptanceCriteria = normalizedAcceptanceCriteria;
  }

  if (normalizedType !== undefined) {
    normalized.type = normalizedType;
  }

  return normalized;
}

function normalizeArchitectReviewCandidate(
  value: Record<string, unknown>,
): unknown {
  if (normalizeLowercaseString(value.type) === "tool") {
    return {
      request: normalizeToolRequestCandidate(value.request),
      summary: normalizeTrimmedString(value.summary),
      type: "tool",
    };
  }

  const normalized: Record<string, unknown> = {
    decision: normalizeKeywordLiteral(value.decision),
    summary: normalizeTrimmedString(value.summary),
  };
  const normalizedNextActions = normalizeStringList(value.nextActions);
  const normalizedType = normalizeLowercaseString(value.type);

  if (normalizedNextActions !== undefined) {
    normalized.nextActions = normalizedNextActions;
  }

  if (normalizedType !== undefined) {
    normalized.type = normalizedType;
  }

  return normalized;
}

function normalizeToolRequestCandidate(value: unknown): unknown {
  return normalizeEngineerToolRequestCandidate(value);
}

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmedValue = value.trim();

  return trimmedValue.length === 0 ? "" : trimmedValue;
}

function normalizeLowercaseString(value: unknown): string | undefined {
  const normalized = normalizeTrimmedString(value);

  return normalized === undefined ? undefined : normalized.toLowerCase();
}

function normalizeKeywordLiteral(value: unknown): string | undefined {
  const normalized = normalizeLowercaseString(value);

  if (normalized === undefined) {
    return undefined;
  }

  return normalized.replace(/^[`"'“”‘’\s]+|[`"'“”‘’\s.,;:!?]+$/gu, "");
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const normalized = normalizeTrimmedString(value);

    return normalized === undefined ? undefined : [normalized];
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.map((entry) =>
    typeof entry === "string" ? entry.trim() : entry,
  ) as string[];
}

function normalizeBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case "true":
      return true;
    case "false":
      return false;
    default:
      return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEngineerToolCalls(
  toolCalls: readonly ModelToolCall[],
): readonly ModelToolCall[] {
  return toolCalls.map((toolCall) => {
    const normalizedRequest = normalizeEngineerToolRequestCandidate({
      ...toolCall.arguments,
      toolName: toolCall.name,
    });

    if (
      !isPlainObject(normalizedRequest) ||
      typeof normalizedRequest.toolName !== "string"
    ) {
      return toolCall;
    }

    const { toolName, ...argumentsValue } = normalizedRequest;

    return {
      arguments: JSON.parse(JSON.stringify(argumentsValue)) as Record<
        string,
        JsonValue
      >,
      id: toolCall.id,
      name: toolName,
    };
  });
}

async function delay(durationMs: number): Promise<void> {
  if (durationMs <= 0) {
    return;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
