export interface CreateRenderSchedulerOptions {
  delayMs?: number | undefined;
  render: () => void;
}

export interface RenderScheduler {
  destroy(): void;
  flush(): void;
  markDirty(): void;
}

export function createRenderScheduler(
  options: CreateRenderSchedulerOptions,
): RenderScheduler {
  const delayMs = options.delayMs ?? 16;
  let destroyed = false;
  let dirty = false;
  let timer: NodeJS.Timeout | undefined;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const schedule = () => {
    if (destroyed || timer !== undefined) {
      return;
    }

    timer = setTimeout(() => {
      timer = undefined;
      renderIfNeeded();
    }, delayMs);
  };

  const renderIfNeeded = () => {
    clearTimer();

    if (destroyed || !dirty) {
      return;
    }

    dirty = false;
    options.render();

    if (dirty) {
      schedule();
    }
  };

  return {
    destroy() {
      destroyed = true;
      dirty = false;
      clearTimer();
    },
    flush() {
      renderIfNeeded();
    },
    markDirty() {
      if (destroyed) {
        return;
      }

      dirty = true;
      schedule();
    },
  };
}
