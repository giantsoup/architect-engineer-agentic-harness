import type { LoadedHarnessConfig } from "../types/config.js";
import type { ModelConfig } from "../types/config.js";
import type { RunDossierPaths } from "../artifacts/paths.js";
import type { HarnessEventBus } from "../runtime/harness-events.js";
import {
  createRunDossierModelLogger,
  type CreateRunDossierModelLoggerOptions,
} from "./dossier-logger.js";
import {
  OpenAiCompatibleChatClient,
  UnsupportedModelProviderError,
} from "./openai-compatible-client.js";
import type {
  HarnessModelRole,
  ModelRequestLogger,
  ResolvedModelConfig,
  SupportedModelProvider,
} from "./types.js";

export const DEFAULT_MODEL_TIMEOUT_MS = 60_000;
export const DEFAULT_MODEL_MAX_RETRIES = 2;

export interface CreateRoleModelClientOptions {
  dossierLoggerOptions?: Omit<CreateRunDossierModelLoggerOptions, "paths">;
  dossierPaths?: RunDossierPaths;
  eventBus?: HarnessEventBus;
  fetch?: typeof fetch;
  loadedConfig: LoadedHarnessConfig;
  logger?: ModelRequestLogger;
  role: HarnessModelRole;
}

export function createRoleModelClient(
  options: CreateRoleModelClientOptions,
): OpenAiCompatibleChatClient {
  const config = resolveModelConfigForRole(options.loadedConfig, options.role);
  const logger =
    options.dossierPaths === undefined
      ? options.logger
      : combineLoggers(
          createRunDossierModelLogger({
            ...options.dossierLoggerOptions,
            paths: options.dossierPaths,
          }),
          options.logger,
        );

  return new OpenAiCompatibleChatClient({
    config,
    ...(options.eventBus === undefined ? {} : { eventBus: options.eventBus }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(logger === undefined ? {} : { logger }),
  });
}

export function resolveModelConfigForRole(
  loadedConfig: LoadedHarnessConfig,
  role: HarnessModelRole,
): ResolvedModelConfig {
  const roleConfig = loadedConfig.config.models[role];
  const provider = normalizeProvider(roleConfig.provider);

  return {
    baseUrl: normalizeOpenAiCompatibleBaseUrl(roleConfig.baseUrl),
    chatCompletionsUrl: buildChatCompletionsUrl(roleConfig.baseUrl),
    headers: Object.freeze(buildHeaders(roleConfig)),
    maxRetries: roleConfig.maxRetries ?? DEFAULT_MODEL_MAX_RETRIES,
    model: roleConfig.model,
    provider,
    role,
    timeoutMs: roleConfig.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS,
  };
}

export function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
  const normalizedUrl = new URL(baseUrl);
  const normalizedPathname = normalizedUrl.pathname.endsWith("/")
    ? normalizedUrl.pathname
    : `${normalizedUrl.pathname}/`;

  normalizedUrl.pathname = normalizedPathname;

  return normalizedUrl.toString();
}

function buildChatCompletionsUrl(baseUrl: string): string {
  return new URL(
    "chat/completions",
    normalizeOpenAiCompatibleBaseUrl(baseUrl),
  ).toString();
}

function buildHeaders(modelConfig: ModelConfig): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };

  if (modelConfig.apiKey !== undefined) {
    headers.authorization = `Bearer ${modelConfig.apiKey}`;
  }

  for (const [name, value] of Object.entries(modelConfig.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }

  return headers;
}

function normalizeProvider(provider: string): SupportedModelProvider {
  if (provider === "llama.cpp" || provider === "openai-compatible") {
    return provider;
  }

  throw new UnsupportedModelProviderError(
    `Unsupported model provider \`${provider}\`. v1 supports \`openai-compatible\` and \`llama.cpp\` only.`,
  );
}

function combineLoggers(
  primaryLogger: ModelRequestLogger,
  secondaryLogger?: ModelRequestLogger,
): ModelRequestLogger {
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
