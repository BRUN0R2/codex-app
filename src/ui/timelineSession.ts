import { touchMostRecentEntry } from "./recentlyUsedMap";
import type { VariableSizeVirtualizer, VirtualAnchor } from "./variableSizeVirtualizer";

export interface TimelineViewportAnchor {
  readonly anchor: VirtualAnchor;
  readonly viewportOffset: number;
}

export interface TimelineViewportSnapshot {
  readonly anchor: TimelineViewportAnchor | null;
  readonly followingLatest: boolean;
  readonly scrollTop: number;
}

export interface TimelineThreadSession extends TimelineViewportSnapshot {
  readonly virtualizer: VariableSizeVirtualizer;
}

export interface TimelineThreadActivation {
  readonly keysChanged: boolean;
  readonly measurementsReset: boolean;
  readonly session: TimelineThreadSession;
}

export interface TimelineTurnReference {
  readonly id: string;
}

interface TimelineThreadSessionRecord {
  anchor: TimelineViewportAnchor | null;
  followingLatest: boolean;
  layoutSignature: string | null;
  scrollTop: number;
  sourceTurns: readonly TimelineTurnReference[] | null;
  virtualizer: VariableSizeVirtualizer;
}

export class TimelineThreadSessionStore {
  readonly #capacity: number;
  readonly #createVirtualizer: () => VariableSizeVirtualizer;
  readonly #sessions = new Map<string, TimelineThreadSessionRecord>();

  constructor(createVirtualizer: () => VariableSizeVirtualizer, capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Timeline session capacity must be a positive integer.");
    }
    this.#createVirtualizer = createVirtualizer;
    this.#capacity = capacity;
  }

  activate(
    threadId: string,
    turns: readonly TimelineTurnReference[],
    layoutSignature: string | null = null,
  ): TimelineThreadActivation {
    if (threadId.length === 0) {
      throw new Error("Timeline sessions require a non-empty thread id.");
    }
    const current = this.#sessions.get(threadId);
    const session =
      current ??
      ({
        anchor: null,
        followingLatest: true,
        layoutSignature,
        scrollTop: 0,
        sourceTurns: null,
        virtualizer: this.#createVirtualizer(),
      } satisfies TimelineThreadSessionRecord);
    const keysChanged =
      session.sourceTurns === turns
        ? false
        : session.virtualizer.setKeys(turns.map((turn) => `${threadId}\u0000${turn.id}`));
    const measurementsReset =
      session.layoutSignature !== null &&
      layoutSignature !== null &&
      session.layoutSignature !== layoutSignature &&
      session.virtualizer.resetMeasurements();
    if (layoutSignature !== null) {
      session.layoutSignature = layoutSignature;
    }
    session.sourceTurns = turns;
    this.#touch(threadId, session);
    return { keysChanged, measurementsReset, session };
  }

  save(threadId: string, snapshot: TimelineViewportSnapshot): void {
    const current = this.#sessions.get(threadId);
    if (current === undefined) {
      throw new Error(`Timeline session ${threadId} is not active in the cache.`);
    }
    if (!Number.isFinite(snapshot.scrollTop) || snapshot.scrollTop < 0) {
      throw new Error("Timeline scroll position must be a non-negative finite number.");
    }
    if (
      snapshot.anchor !== null &&
      (!Number.isFinite(snapshot.anchor.viewportOffset) ||
        !Number.isFinite(snapshot.anchor.anchor.offsetWithinItem) ||
        snapshot.anchor.anchor.offsetWithinItem < 0)
    ) {
      throw new Error("Timeline viewport anchor must contain finite offsets.");
    }
    current.anchor = snapshot.anchor;
    current.followingLatest = snapshot.followingLatest;
    current.scrollTop = snapshot.scrollTop;
    this.#touch(threadId, current);
  }

  #touch(threadId: string, session: TimelineThreadSessionRecord): void {
    if (!this.#sessions.has(threadId)) {
      this.#sessions.set(threadId, session);
    }
    touchMostRecentEntry(this.#sessions, threadId, this.#capacity);
  }
}
