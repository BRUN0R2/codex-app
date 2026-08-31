import type { ThreadTurn, VisibleThreadItem } from "../contracts/types";

export interface VisibleThreadTurn extends Omit<ThreadTurn, "items"> {
  readonly confirmedOutputTokens: number;
  readonly items: readonly VisibleThreadItem[];
}

export interface VisibleTurnSequence {
  readonly length: number;
  readonly at: (index: number) => VisibleThreadTurn | undefined;
  readonly slice: (start?: number, end?: number) => readonly VisibleThreadTurn[];
}

export function overlayVisibleTurn(
  persisted: readonly VisibleThreadTurn[],
  overlayIndex: number,
  overlay: VisibleThreadTurn,
): VisibleTurnSequence {
  return overlayVisibleTurns(persisted, new Map([[overlayIndex, overlay]]));
}

export function overlayVisibleTurns(
  persisted: readonly VisibleThreadTurn[],
  overlays: ReadonlyMap<number, VisibleThreadTurn>,
): VisibleTurnSequence {
  if (overlays.size === 0) {
    return persisted;
  }
  for (const [overlayIndex, overlay] of overlays) {
    if (!Number.isInteger(overlayIndex) || overlayIndex < 0 || overlayIndex > persisted.length) {
      throw new Error("The visible turn overlay index is outside the persisted sequence.");
    }
    const persistedTurn = persisted[overlayIndex];
    if (persistedTurn !== undefined && persistedTurn.id !== overlay.id) {
      throw new Error("The visible turn overlay does not match its persisted turn.");
    }
  }
  return new OverlayTurnSequence(persisted, overlays);
}

export function findVisibleTurn(
  turns: VisibleTurnSequence,
  turnId: string,
): VisibleThreadTurn | undefined {
  const latest = turns.at(-1);
  if (latest?.id === turnId) {
    return latest;
  }
  for (let index = turns.length - 2; index >= 0; index -= 1) {
    const turn = turns.at(index);
    if (turn?.id === turnId) {
      return turn;
    }
  }
  return undefined;
}

class OverlayTurnSequence implements VisibleTurnSequence {
  readonly length: number;
  readonly #overlays: ReadonlyMap<number, VisibleThreadTurn>;
  readonly #persisted: readonly VisibleThreadTurn[];

  constructor(
    persisted: readonly VisibleThreadTurn[],
    overlays: ReadonlyMap<number, VisibleThreadTurn>,
  ) {
    this.#persisted = persisted;
    this.#overlays = overlays;
    this.length = Math.max(persisted.length, Math.max(...overlays.keys()) + 1);
  }

  at(index: number): VisibleThreadTurn | undefined {
    const normalized = normalizeAtIndex(index, this.length);
    if (normalized === null) {
      return undefined;
    }
    return this.#overlays.get(normalized) ?? this.#persisted[normalized];
  }

  slice(start?: number, end?: number): readonly VisibleThreadTurn[] {
    const from = normalizeSliceIndex(start, this.length, 0);
    const to = normalizeSliceIndex(end, this.length, this.length);
    if (to <= from) {
      return [];
    }
    const turns: VisibleThreadTurn[] = [];
    for (let index = from; index < to; index += 1) {
      const turn = this.at(index);
      if (turn !== undefined) {
        turns.push(turn);
      }
    }
    return turns;
  }
}

function normalizeAtIndex(index: number, length: number): number | null {
  if (!Number.isFinite(index)) {
    return null;
  }
  const integer = Math.trunc(index);
  const normalized = integer < 0 ? length + integer : integer;
  return normalized < 0 || normalized >= length ? null : normalized;
}

function normalizeSliceIndex(index: number | undefined, length: number, fallback: number): number {
  if (index === undefined) {
    return fallback;
  }
  if (Number.isNaN(index) || index === Number.NEGATIVE_INFINITY) {
    return 0;
  }
  if (index === Number.POSITIVE_INFINITY) {
    return length;
  }
  const integer = Math.trunc(index);
  return integer < 0 ? Math.max(0, length + integer) : Math.min(length, integer);
}
