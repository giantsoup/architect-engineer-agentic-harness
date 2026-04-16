import type {
  HarnessEvent,
  HarnessEventBus,
} from "../runtime/harness-events.js";

export interface CreateTuiEventBridgeOptions {
  batchDelayMs?: number | undefined;
  eventBus: HarnessEventBus;
  maxBatchSize?: number | undefined;
  onBatch(events: readonly HarnessEvent[]): void | Promise<void>;
}

export interface TuiEventBridge {
  start(): void;
  stop(): void;
}

export function createTuiEventBridge(
  options: CreateTuiEventBridgeOptions,
): TuiEventBridge {
  const batchDelayMs = options.batchDelayMs ?? 24;
  const maxBatchSize = options.maxBatchSize ?? 200;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  const queuedEvents: HarnessEvent[] = [];

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const flush = () => {
    clearTimer();

    if (stopped || queuedEvents.length === 0) {
      return;
    }

    const events = queuedEvents.splice(0, maxBatchSize);

    void options.onBatch(events);

    if (queuedEvents.length > 0) {
      scheduleFlush(queuedEvents.length >= maxBatchSize ? 0 : batchDelayMs);
    }
  };

  const scheduleFlush = (delayMs: number) => {
    if (stopped || timer !== undefined) {
      return;
    }

    timer = setTimeout(flush, delayMs);
  };

  return {
    start() {
      if (stopped || unsubscribe !== undefined) {
        return;
      }

      unsubscribe = options.eventBus.subscribe((event) => {
        if (!coalesceQueuedEvent(queuedEvents, event)) {
          queuedEvents.push(event);
        }

        scheduleFlush(queuedEvents.length >= maxBatchSize ? 0 : batchDelayMs);
      });
    },
    stop() {
      if (stopped) {
        return;
      }

      stopped = true;
      clearTimer();
      unsubscribe?.();
      unsubscribe = undefined;
      queuedEvents.length = 0;
    },
  };
}

function coalesceQueuedEvent(
  queuedEvents: HarnessEvent[],
  incoming: HarnessEvent,
): boolean {
  const previous = queuedEvents.at(-1);

  if (previous === undefined) {
    return false;
  }

  if (
    (incoming.type === "command:stdout" ||
      incoming.type === "command:stderr") &&
    previous.type === incoming.type &&
    previous.command === incoming.command &&
    previous.role === incoming.role &&
    previous.runId === incoming.runId
  ) {
    queuedEvents[queuedEvents.length - 1] = {
      ...previous,
      chunk: `${previous.chunk}${incoming.chunk}`,
      timestamp: incoming.timestamp,
    };
    return true;
  }

  if (
    incoming.type === "artifact:update" &&
    previous.type === "artifact:update" &&
    previous.artifact === incoming.artifact &&
    previous.operation === incoming.operation &&
    previous.runId === incoming.runId
  ) {
    queuedEvents[queuedEvents.length - 1] = incoming;
    return true;
  }

  return false;
}
