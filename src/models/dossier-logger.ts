import {
  appendModelEvent,
  appendStructuredMessage,
} from "../runtime/run-dossier.js";
import type { RunDossierPaths } from "../artifacts/paths.js";
import type { ModelRequestLogger } from "./types.js";

export interface CreateRunDossierModelLoggerOptions {
  paths: RunDossierPaths;
}

const REDACTED_HEADER_VALUE = "[REDACTED]";
const SENSITIVE_HEADER_NAMES = new Set([
  "api-key",
  "authorization",
  "proxy-authorization",
  "x-api-key",
]);

export function createRunDossierModelLogger(
  options: CreateRunDossierModelLoggerOptions,
): ModelRequestLogger {
  return {
    onError: async (event) => {
      await appendModelEvent(options.paths, {
        attempt: event.attempt,
        classification: event.classification,
        issues: event.issues,
        message: event.message,
        provider: event.provider,
        retryable: event.retryable,
        role: event.role,
        statusCode: event.statusCode,
        timestamp: event.timestamp,
        type: "model-error",
      });
    },
    onRequest: async (event) => {
      await appendModelEvent(options.paths, {
        attempt: event.attempt,
        configuredTimeoutMs: event.configuredTimeoutMs,
        headers: redactModelHeaders(event.headers),
        messageCount: event.messageCount,
        metadata: event.metadata,
        payload: event.payload,
        provider: event.provider,
        role: event.role,
        timestamp: event.timestamp,
        type: "model-request",
        url: event.url,
        usedNativeStructuredOutput: event.usedNativeStructuredOutput,
      });
    },
    onResponse: async (event) => {
      await appendModelEvent(options.paths, {
        attempt: event.attempt,
        durationMs: event.durationMs,
        finishReason: event.finishReason,
        provider: event.provider,
        providerRequestId: event.providerRequestId,
        role: event.role,
        statusCode: event.statusCode,
        structuredOutput: event.structuredOutput,
        timestamp: event.timestamp,
        type: "model-response",
        usage: event.usage,
      });

      await appendStructuredMessage(options.paths, {
        content: event.rawContent,
        format: event.structuredOutput === undefined ? "text" : "json",
        metadata: {
          durationMs: event.durationMs,
          finishReason: event.finishReason,
          provider: event.provider,
          providerRequestId: event.providerRequestId,
          statusCode: event.statusCode,
          usage:
            event.usage === undefined
              ? undefined
              : {
                  completionTokens: event.usage.completionTokens,
                  promptTokens: event.usage.promptTokens,
                  totalTokens: event.usage.totalTokens,
                },
        },
        role: event.role,
        timestamp: event.timestamp,
      });
    },
    onRetry: async (event) => {
      await appendModelEvent(options.paths, {
        attempt: event.attempt,
        classification: event.classification,
        message: event.message,
        nextAttempt: event.nextAttempt,
        provider: event.provider,
        retryable: event.retryable,
        role: event.role,
        statusCode: event.statusCode,
        timestamp: event.timestamp,
        type: "model-retry",
        usedNativeStructuredOutput: event.usedNativeStructuredOutput,
      });
    },
  };
}

export function redactModelHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([headerName, value]) => [
      headerName,
      SENSITIVE_HEADER_NAMES.has(headerName.toLowerCase())
        ? REDACTED_HEADER_VALUE
        : value,
    ]),
  );
}
