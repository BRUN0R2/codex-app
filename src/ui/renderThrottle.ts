export interface RenderThrottleScheduler {
  readonly cancel: (handle: number) => void;
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => number;
}

export interface LatestValueThrottle<T> {
  readonly cancel: () => void;
  readonly dispose: () => void;
  readonly flush: () => void;
  readonly push: (value: T, minimumIntervalMs: number, immediate?: boolean) => void;
}

interface LatestValueThrottleOptions<T> {
  readonly emit: (value: T) => void;
  readonly scheduler: RenderThrottleScheduler;
}

const SHORT_MARKDOWN_CHARACTERS = 8_192;
const MEDIUM_MARKDOWN_CHARACTERS = 32_768;
const LONG_MARKDOWN_CHARACTERS = 131_072;
const FRAME_INTERVAL_MS = 16;
const SHORT_STREAM_INTERVAL_MS = 33;
const MEDIUM_STREAM_INTERVAL_MS = 66;
const LONG_STREAM_INTERVAL_MS = 125;

export function markdownStreamRenderInterval(characterCount: number): number {
  if (characterCount < SHORT_MARKDOWN_CHARACTERS) {
    return FRAME_INTERVAL_MS;
  }
  if (characterCount < MEDIUM_MARKDOWN_CHARACTERS) {
    return SHORT_STREAM_INTERVAL_MS;
  }
  if (characterCount < LONG_MARKDOWN_CHARACTERS) {
    return MEDIUM_STREAM_INTERVAL_MS;
  }
  return LONG_STREAM_INTERVAL_MS;
}

export function createLatestValueThrottle<T>(
  options: LatestValueThrottleOptions<T>,
): LatestValueThrottle<T> {
  let disposed = false;
  let lastEmissionAt: number | null = null;
  let pending: { readonly value: T } | null = null;
  let scheduledAt: number | null = null;
  let scheduledHandle: number | undefined;

  function cancelSchedule(): void {
    if (scheduledHandle !== undefined) {
      options.scheduler.cancel(scheduledHandle);
      scheduledHandle = undefined;
      scheduledAt = null;
    }
  }

  function emitPending(): void {
    if (pending === null || disposed) {
      return;
    }
    const value = pending.value;
    pending = null;
    lastEmissionAt = options.scheduler.now();
    options.emit(value);
  }

  function scheduleAt(targetTime: number): void {
    if (scheduledAt !== null && scheduledAt <= targetTime) {
      return;
    }
    cancelSchedule();
    scheduledAt = targetTime;
    scheduledHandle = options.scheduler.schedule(
      () => {
        scheduledHandle = undefined;
        scheduledAt = null;
        emitPending();
      },
      Math.max(0, targetTime - options.scheduler.now()),
    );
  }

  return {
    cancel() {
      cancelSchedule();
      pending = null;
    },
    dispose() {
      disposed = true;
      cancelSchedule();
      pending = null;
    },
    flush() {
      cancelSchedule();
      emitPending();
    },
    push(value, minimumIntervalMs, immediate = false) {
      if (disposed) {
        return;
      }
      pending = { value };
      const now = options.scheduler.now();
      if (immediate || lastEmissionAt === null || now - lastEmissionAt >= minimumIntervalMs) {
        cancelSchedule();
        emitPending();
        return;
      }
      scheduleAt(lastEmissionAt + minimumIntervalMs);
    },
  };
}

export function createBrowserRenderThrottleScheduler(): RenderThrottleScheduler {
  return {
    cancel: (handle) => window.clearTimeout(handle),
    now: () => performance.now(),
    schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
  };
}
