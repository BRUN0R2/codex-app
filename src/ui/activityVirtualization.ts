import { VariableSizeVirtualizer } from "./variableSizeVirtualizer";

export interface ActivityVirtualizerActivation {
  readonly keysChanged: boolean;
  readonly measurementsReset: boolean;
  readonly virtualizer: VariableSizeVirtualizer;
}

interface ActivityVirtualizerRecord {
  layoutSignature: string | null;
  sourceKeys: readonly string[] | null;
  virtualizer: VariableSizeVirtualizer;
}

export class ActivityVirtualizerStore {
  readonly #capacity: number;
  readonly #estimatedItemSize: number;
  readonly #records = new Map<string, ActivityVirtualizerRecord>();

  constructor(estimatedItemSize: number, capacity: number) {
    if (!Number.isFinite(estimatedItemSize) || estimatedItemSize <= 0) {
      throw new Error("Activity item estimates must be positive finite numbers.");
    }
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Activity virtualizer capacity must be a positive integer.");
    }
    this.#estimatedItemSize = estimatedItemSize;
    this.#capacity = capacity;
  }

  activate(
    groupKey: string,
    itemKeys: readonly string[],
    layoutSignature: string | null,
  ): ActivityVirtualizerActivation {
    if (groupKey.length === 0) {
      throw new Error("Activity virtualizers require a non-empty group key.");
    }
    const current = this.#records.get(groupKey);
    const record =
      current ??
      ({
        layoutSignature,
        sourceKeys: null,
        virtualizer: new VariableSizeVirtualizer(this.#estimatedItemSize),
      } satisfies ActivityVirtualizerRecord);
    const keysChanged =
      record.sourceKeys === itemKeys ? false : record.virtualizer.setKeys(itemKeys);
    const measurementsReset =
      record.layoutSignature !== null &&
      layoutSignature !== null &&
      record.layoutSignature !== layoutSignature &&
      record.virtualizer.resetMeasurements();
    if (layoutSignature !== null) {
      record.layoutSignature = layoutSignature;
    }
    record.sourceKeys = itemKeys;
    this.#touch(groupKey, record);
    return { keysChanged, measurementsReset, virtualizer: record.virtualizer };
  }

  #touch(groupKey: string, record: ActivityVirtualizerRecord): void {
    this.#records.delete(groupKey);
    this.#records.set(groupKey, record);
    while (this.#records.size > this.#capacity) {
      const oldestGroupKey = this.#records.keys().next().value;
      if (oldestGroupKey === undefined) {
        throw new Error("Activity virtualizer cache lost its eviction candidate.");
      }
      this.#records.delete(oldestGroupKey);
    }
  }
}

export interface ActivityViewportInput {
  readonly listTop: number;
  readonly scrollTop: number;
  readonly viewportSize: number;
}

export interface ActivityViewport {
  readonly offset: number;
  readonly size: number;
}

export function resolveActivityViewport(input: ActivityViewportInput): ActivityViewport {
  const scrollTop = Number.isFinite(input.scrollTop) ? Math.max(0, input.scrollTop) : 0;
  const listTop = Number.isFinite(input.listTop) ? input.listTop : 0;
  const viewportSize = Number.isFinite(input.viewportSize) ? Math.max(1, input.viewportSize) : 1;
  return {
    offset: Math.max(0, scrollTop - listTop),
    size: viewportSize,
  };
}

export function resolveActivityAnchorCorrection(
  previousAnchorOffset: number | null,
  nextAnchorOffset: number | null,
): number {
  if (
    previousAnchorOffset === null ||
    nextAnchorOffset === null ||
    !Number.isFinite(previousAnchorOffset) ||
    !Number.isFinite(nextAnchorOffset)
  ) {
    return 0;
  }
  return nextAnchorOffset - previousAnchorOffset;
}

export function shouldDeferActivityContent(scrollDelta: number, viewportSize: number): boolean {
  if (!Number.isFinite(scrollDelta) || !Number.isFinite(viewportSize) || viewportSize <= 0) {
    return false;
  }
  return Math.abs(scrollDelta) >= Math.max(160, viewportSize * 0.25);
}
