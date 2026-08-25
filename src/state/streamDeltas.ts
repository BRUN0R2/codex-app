export type StreamDelta =
  | {
      readonly kind: "agentText";
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly delta: string;
    }
  | {
      readonly kind: "reasoningText";
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly index: number;
      readonly target: "content" | "summary";
      readonly delta: string;
    }
  | {
      readonly kind: "commandOutput";
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly stream: "stderr" | "stdout";
      readonly operation:
        | { readonly type: "append"; readonly delta: string }
        | { readonly type: "backspace" | "clearCurrentLine" | "truncated" };
    };

export interface StreamDeltaScheduler {
  readonly cancel: (handle: number) => void;
  readonly schedule: (callback: () => void) => number;
}

export interface StreamDeltaBatcher {
  readonly dispose: () => void;
  readonly enqueue: (delta: StreamDelta) => void;
  readonly flush: () => void;
  readonly releaseItem: (threadId: string, turnId: string, itemId: string) => void;
  readonly releaseThread: (threadId: string) => void;
}

interface StreamDeltaBatcherOptions {
  readonly apply: (deltas: readonly StreamDelta[]) => void;
  readonly reportError: (reason: unknown) => void;
  readonly scheduler: StreamDeltaScheduler;
}

const KEY_SEPARATOR = "\u0000";

export function createStreamDeltaBatcher(options: StreamDeltaBatcherOptions): StreamDeltaBatcher {
  const leadingKeys = new Set<string>();
  const pendingIndexes = new Map<string, number>();
  let pending: StreamDelta[] = [];
  let scheduledHandle: number | undefined;
  let disposed = false;

  function apply(deltas: readonly StreamDelta[]): void {
    if (deltas.length === 0 || disposed) {
      return;
    }
    try {
      options.apply(deltas);
    } catch (reason) {
      options.reportError(reason);
    }
  }

  function scheduleFlush(): void {
    if (scheduledHandle !== undefined || disposed) {
      return;
    }
    scheduledHandle = options.scheduler.schedule(() => {
      scheduledHandle = undefined;
      flushPending();
    });
  }

  function flushPending(): void {
    if (pending.length === 0) {
      return;
    }
    const deltas = pending;
    pending = [];
    pendingIndexes.clear();
    apply(deltas);
  }

  function cancelScheduledFlush(): void {
    if (scheduledHandle === undefined) {
      return;
    }
    options.scheduler.cancel(scheduledHandle);
    scheduledHandle = undefined;
  }

  function flush(): void {
    cancelScheduledFlush();
    flushPending();
  }

  function releaseMatching(prefix: string): void {
    for (const key of leadingKeys) {
      if (key.startsWith(prefix)) {
        leadingKeys.delete(key);
      }
    }
    if (pending.length === 0) {
      return;
    }
    const retained = pending.filter((delta) => !streamDeltaKey(delta).startsWith(prefix));
    if (retained.length === pending.length) {
      return;
    }
    pending = retained;
    pendingIndexes.clear();
    for (let index = 0; index < pending.length; index += 1) {
      const delta = pending[index];
      if (delta !== undefined) {
        pendingIndexes.set(streamDeltaKey(delta), index);
      }
    }
    if (pending.length === 0) {
      cancelScheduledFlush();
    }
  }

  return {
    dispose() {
      disposed = true;
      cancelScheduledFlush();
      pending = [];
      pendingIndexes.clear();
      leadingKeys.clear();
    },
    enqueue(delta) {
      if (disposed || streamDeltaText(delta) === "") {
        return;
      }
      const key = streamDeltaKey(delta);
      if (!leadingKeys.has(key)) {
        leadingKeys.add(key);
        apply([delta]);
        return;
      }
      const pendingIndex = pendingIndexes.get(key);
      if (delta.kind === "commandOutput") {
        const previous = pending.at(-1);
        if (
          previous?.kind === "commandOutput" &&
          previous.itemId === delta.itemId &&
          previous.threadId === delta.threadId &&
          previous.turnId === delta.turnId &&
          previous.stream === delta.stream &&
          previous.operation.type === "append" &&
          delta.operation.type === "append"
        ) {
          pending[pending.length - 1] = {
            ...previous,
            operation: {
              type: "append",
              delta: previous.operation.delta + delta.operation.delta,
            },
          };
        } else {
          pending.push(delta);
        }
        scheduleFlush();
        return;
      }
      if (pendingIndex === undefined) {
        pendingIndexes.set(key, pending.length);
        pending.push(delta);
      } else {
        const current = pending[pendingIndex];
        if (current === undefined || current.kind !== delta.kind) {
          options.reportError(new Error("O lote de deltas do stream ficou inconsistente."));
          return;
        }
        pending[pendingIndex] = { ...current, delta: current.delta + delta.delta };
      }
      scheduleFlush();
    },
    flush,
    releaseItem(threadId, turnId, itemId) {
      releaseMatching(
        `${threadId}${KEY_SEPARATOR}${turnId}${KEY_SEPARATOR}${itemId}${KEY_SEPARATOR}`,
      );
    },
    releaseThread(threadId) {
      releaseMatching(`${threadId}${KEY_SEPARATOR}`);
    },
  };
}

export function createBrowserStreamDeltaScheduler(): StreamDeltaScheduler {
  return {
    cancel: (handle) => cancelAnimationFrame(handle),
    schedule: (callback) => requestAnimationFrame(callback),
  };
}

function streamDeltaKey(delta: StreamDelta): string {
  const base = `${delta.threadId}${KEY_SEPARATOR}${delta.turnId}${KEY_SEPARATOR}${delta.itemId}${KEY_SEPARATOR}${delta.kind}`;
  switch (delta.kind) {
    case "agentText":
      return base;
    case "commandOutput":
      return `${base}${KEY_SEPARATOR}${delta.stream}`;
    case "reasoningText":
      return `${base}${KEY_SEPARATOR}${delta.target}${KEY_SEPARATOR}${delta.index}`;
  }
}

function streamDeltaText(delta: StreamDelta): string | null {
  return delta.kind === "commandOutput"
    ? delta.operation.type === "append"
      ? delta.operation.delta
      : null
    : delta.delta;
}
