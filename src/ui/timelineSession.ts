import type { VariableSizeVirtualizer } from "./variableSizeVirtualizer";

export interface TimelineViewportSnapshot {
  readonly followingLatest: boolean;
  readonly scrollTop: number;
}

export interface TimelineThreadSession extends TimelineViewportSnapshot {
  readonly virtualizer: VariableSizeVirtualizer;
}

export class TimelineThreadSessionStore {
  readonly #capacity: number;
  readonly #createVirtualizer: () => VariableSizeVirtualizer;
  readonly #sessions = new Map<string, TimelineThreadSession>();

  constructor(createVirtualizer: () => VariableSizeVirtualizer, capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Timeline session capacity must be a positive integer.");
    }
    this.#createVirtualizer = createVirtualizer;
    this.#capacity = capacity;
  }

  activate(threadId: string, keys: readonly string[]): TimelineThreadSession {
    if (threadId.length === 0) {
      throw new Error("Timeline sessions require a non-empty thread id.");
    }
    const current = this.#sessions.get(threadId);
    const session =
      current ??
      ({
        followingLatest: true,
        scrollTop: 0,
        virtualizer: this.#createVirtualizer(),
      } satisfies TimelineThreadSession);
    session.virtualizer.setKeys(keys);
    this.#touch(threadId, session);
    return session;
  }

  save(threadId: string, snapshot: TimelineViewportSnapshot): void {
    const current = this.#sessions.get(threadId);
    if (current === undefined) {
      throw new Error(`Timeline session ${threadId} is not active in the cache.`);
    }
    if (!Number.isFinite(snapshot.scrollTop) || snapshot.scrollTop < 0) {
      throw new Error("Timeline scroll position must be a non-negative finite number.");
    }
    this.#touch(threadId, {
      followingLatest: snapshot.followingLatest,
      scrollTop: snapshot.scrollTop,
      virtualizer: current.virtualizer,
    });
  }

  #touch(threadId: string, session: TimelineThreadSession): void {
    this.#sessions.delete(threadId);
    this.#sessions.set(threadId, session);
    while (this.#sessions.size > this.#capacity) {
      const oldestThreadId = this.#sessions.keys().next().value;
      if (oldestThreadId === undefined) {
        throw new Error("Timeline session cache lost its eviction candidate.");
      }
      this.#sessions.delete(oldestThreadId);
    }
  }
}
