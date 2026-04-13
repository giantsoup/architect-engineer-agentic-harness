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
      schemaName?: string | undefined;
    } = {},
  ) {
    super("invalid-structured-output", message, {
      cause: options.cause,
      issues: options.issues,
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
      messages: request.messages.map((message) => toOpenAiMessage(message)),
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

    let parsedJson: unknown;

    try {
      parsedJson = parseStructuredOutputJson(rawContent);
    } catch (error) {
      throw new ModelStructuredOutputError(
        `Expected valid JSON for structured output from ${this.describeTarget()}, but the response could not be parsed.`,
        {
          cause: error,
          schemaName: structuredOutput.formatName,
        },
      );
    }

    try {
      return await structuredOutput.validate(parsedJson);
    } catch (error) {
      const issues =
        error instanceof Error && "issues" in error
          ? ((error as { issues?: readonly string[] }).issues ?? undefined)
          : undefined;
      const schemaPath =
        error instanceof Error && "schemaPath" in error
          ? ((error as { schemaPath?: string }).schemaPath ?? undefined)
          : undefined;

      throw new ModelStructuredOutputError(
        schemaPath === undefined
          ? `Structured output from ${this.describeTarget()} did not match ${structuredOutput.formatName}.`
          : `Structured output from ${this.describeTarget()} did not match ${structuredOutput.formatName} (${schemaPath}).`,
        {
          cause: error,
          issues,
          schemaName: structuredOutput.formatName,
        },
      );
    }
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
  const openAiMessage: Record<string, string> = {
    content: message.content,
    role: message.role,
  };

  if (message.name !== undefined) {
    openAiMessage.name = message.name;
  }

  if (message.toolCallId !== undefined) {
    openAiMessage.tool_call_id = message.toolCallId;
  }

  return openAiMessage;
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
    normalizedMessage.includes("unsupported")
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

function parseStructuredOutputJson(rawContent: string): unknown {
  const trimmedContent = rawContent.trim();

  try {
    return JSON.parse(trimmedContent);
  } catch (error) {
    const fencedJson = extractJsonCodeFence(trimmedContent);

    if (fencedJson !== undefined) {
      return JSON.parse(fencedJson);
    }

    throw error;
  }
}

function extractJsonCodeFence(rawContent: string): string | undefined {
  const fencedMatch =
    /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(rawContent) ??
    /```(?:json)?\s*([\s\S]*?)\s*```/iu.exec(rawContent);

  return fencedMatch?.[1];
}

async function delay(durationMs: number): Promise<void> {
  if (durationMs <= 0) {
    return;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
