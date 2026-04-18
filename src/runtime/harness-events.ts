import type { RunDossierPaths, DossierFileKey } from "../artifacts/paths.js";
import type {
  HarnessModelRole,
  SupportedModelProvider,
} from "../models/types.js";
import type {
  ArchitectEngineerNodeName,
  ArchitectEngineerStopReason,
} from "./architect-engineer-state.js";
import type {
  JsonValue,
  RunCheckResult,
  RunLifecycleStatus,
  RunResult,
} from "../types/run.js";

export interface HarnessEventMap {
  "run:status": {
    phase?: ArchitectEngineerNodeName | undefined;
    runId: string;
    status: RunLifecycleStatus | RunResult["status"];
    stopReason?: ArchitectEngineerStopReason | undefined;
    summary?: string | undefined;
  };
  "agent:update": {
    agent: "architect" | "engineer";
    iteration?: number | undefined;
    phase: "execute" | "plan" | "review";
    runId: string;
    status: "active" | "completed";
    summary: string;
  };
  "agent:session": {
    phase: "finished" | "started";
    runId: string;
    status?: RunLifecycleStatus | RunResult["status"] | undefined;
    summary: string;
  };
  "agent:action": {
    runId: string;
    summary: string;
    toolName?: string | undefined;
  };
  "agent:turn": {
    outcome?: "cancelled" | "failed" | "replied" | undefined;
    runId: string;
    status: "finished" | "started";
    summary: string;
    turnIndex: number;
  };
  "command:start": {
    accessMode: "inspect" | "mutate";
    command: string;
    containerName?: string | undefined;
    environment?: Record<string, string> | undefined;
    executionTarget?: "docker" | "host" | undefined;
    role: HarnessModelRole;
    runId?: string | undefined;
    workingDirectory?: string | undefined;
  };
  "command:stdout": {
    chunk: string;
    command: string;
    role: HarnessModelRole;
    runId?: string | undefined;
  };
  "command:stderr": {
    chunk: string;
    command: string;
    role: HarnessModelRole;
    runId?: string | undefined;
  };
  "command:end": {
    accessMode: "inspect" | "mutate";
    command: string;
    containerName?: string | undefined;
    durationMs: number;
    executionTarget: "docker" | "host";
    exitCode: number;
    role: HarnessModelRole;
    runId?: string | undefined;
    status: "completed";
    workingDirectory: string;
  };
  "command:error": {
    accessMode: "inspect" | "mutate";
    command: string;
    containerName?: string | undefined;
    durationMs: number;
    errorName: string;
    executionTarget?: "docker" | "host" | undefined;
    exitCode: number | null;
    message: string;
    role: HarnessModelRole;
    runId?: string | undefined;
    status: "cancelled" | "failed-to-start" | "timed-out";
    timeoutMs?: number | undefined;
    workingDirectory?: string | undefined;
  };
  "artifact:update": {
    artifact: DossierFileKey;
    artifactKind: RunDossierPaths["files"][DossierFileKey]["kind"];
    operation: "append" | "write";
    path: string;
    runId: string;
  };
  "check:update": {
    check: RunCheckResult;
    consecutiveFailedChecks: number;
    requiredCheckCommand: string;
    runId: string;
    totalChecks: number;
  };
  "model:request": {
    attempt: number;
    configuredTimeoutMs: number;
    messageCount: number;
    metadata?: { [key: string]: JsonValue | undefined } | undefined;
    model: string;
    provider: SupportedModelProvider;
    role: HarnessModelRole;
    runId?: string | undefined;
    url: string;
    usedNativeStructuredOutput: boolean;
  };
  "model:retry": {
    attempt: number;
    classification: string;
    message: string;
    model: string;
    nextAttempt: number;
    provider: SupportedModelProvider;
    retryable: boolean;
    role: HarnessModelRole;
    runId?: string | undefined;
    statusCode?: number | undefined;
    usedNativeStructuredOutput: boolean;
  };
}

export type HarnessEventType = keyof HarnessEventMap;

export type HarnessEvent<TType extends HarnessEventType = HarnessEventType> = {
  [K in HarnessEventType]: {
    seq: number;
    timestamp: string;
    type: K;
  } & HarnessEventMap[K];
}[TType];

export type HarnessEventInput<
  TType extends HarnessEventType = HarnessEventType,
> = {
  [K in HarnessEventType]: {
    timestamp?: string | undefined;
    type: K;
  } & HarnessEventMap[K];
}[TType];

export type HarnessEventListener = (event: HarnessEvent) => void;

export interface HarnessEventBus {
  emit<TType extends HarnessEventType>(
    event: HarnessEventInput<TType>,
  ): HarnessEvent<TType>;
  subscribe(listener: HarnessEventListener): () => void;
  unsubscribe(listener: HarnessEventListener): void;
}

export interface CreateHarnessEventBusOptions {
  now?: () => Date;
}

export function createHarnessEventBus(
  options: CreateHarnessEventBusOptions = {},
): HarnessEventBus {
  const now = options.now ?? (() => new Date());
  const listeners = new Set<HarnessEventListener>();
  let nextSeq = 1;

  return {
    emit(event) {
      const emittedEvent = {
        ...event,
        seq: nextSeq,
        timestamp: event.timestamp ?? now().toISOString(),
      } as HarnessEvent;

      nextSeq += 1;

      for (const listener of listeners) {
        try {
          listener(emittedEvent);
        } catch {
          // Live observers must not interfere with the harness core.
        }
      }

      return emittedEvent as HarnessEvent<typeof event.type>;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    unsubscribe(listener) {
      listeners.delete(listener);
    },
  };
}
