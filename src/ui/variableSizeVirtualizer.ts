export interface VirtualRange {
  readonly end: number;
  readonly start: number;
}

export interface VirtualAnchor {
  readonly key: string;
  readonly offsetWithinItem: number;
}

export interface MeasurementChange {
  readonly delta: number;
  readonly index: number;
}

export interface VirtualMeasurement {
  readonly key: string;
  readonly size: number;
}

export interface VirtualItemEstimate {
  readonly estimatedSize: number;
  readonly key: string;
}

export interface VirtualItemSource {
  readonly count: number;
  readonly estimatedOffsetOf: (index: number) => number;
  readonly estimatedSizeAt: (index: number) => number;
  readonly identity: object;
  readonly indexOf: (key: string) => number | null;
  readonly keyAt: (index: number) => string;
}

export interface MeasurementBatch {
  readonly changed: boolean;
}

export class VariableSizeVirtualizer {
  readonly #estimate: number;
  #baseEstimate: number;
  #itemCount = 0;
  #itemSource: VirtualItemSource | null = null;
  #itemSourceUniformEstimate: number | null = null;
  #keys: readonly string[] = [];
  #sourceKeys: readonly string[] | null = null;
  #sourceEstimatedItems: readonly VirtualItemEstimate[] | null = null;
  #sourceEstimatedKeys: readonly string[] | null = null;
  #sourceEstimateAt: ((key: string, index: number) => number) | null = null;
  #indexByKey = new Map<string, number>();
  #measuredByKey = new Map<string, number>();
  #estimateOverrides = new Map<number, number>();
  #sizeOverrides = new Map<number, number>();
  #tree = new Float64Array(1);

  constructor(estimatedSize: number) {
    if (!Number.isFinite(estimatedSize) || estimatedSize <= 0) {
      throw new Error("The virtual item estimate must be a positive finite number.");
    }
    this.#estimate = estimatedSize;
    this.#baseEstimate = estimatedSize;
  }

  setItemSource(
    source: VirtualItemSource,
    uniformEstimatedSize: number | null = null,
    resetEstimates = false,
  ): boolean {
    assertVirtualItemSource(source, uniformEstimatedSize);
    const sourceIdentityUnchanged =
      this.#itemSource?.identity === source.identity && this.#itemCount === source.count;
    const estimateModeUnchanged = this.#itemSourceUniformEstimate === uniformEstimatedSize;
    if (sourceIdentityUnchanged && estimateModeUnchanged && !resetEstimates) {
      this.#itemSource = source;
      return false;
    }

    this.#itemSource = source;
    this.#itemSourceUniformEstimate = uniformEstimatedSize;
    this.#itemCount = source.count;
    this.#keys = [];
    this.#sourceKeys = null;
    this.#sourceEstimatedItems = null;
    this.#sourceEstimatedKeys = null;
    this.#sourceEstimateAt = null;
    this.#indexByKey = new Map();
    this.#measuredByKey = new Map();
    this.#estimateOverrides = new Map();
    this.#sizeOverrides = new Map();
    this.#tree = new Float64Array(source.count + 1);
    return true;
  }

  setKeys(keys: readonly string[]): boolean {
    if (
      this.#sourceKeys === keys &&
      this.#sourceEstimatedItems === null &&
      this.#sourceEstimatedKeys === null
    ) {
      return false;
    }
    this.#sourceKeys = keys;
    this.#sourceEstimatedItems = null;
    this.#sourceEstimatedKeys = null;
    this.#sourceEstimateAt = null;
    return this.#replaceItems(keys, this.#estimate, new Map());
  }

  setEstimatedItems(items: readonly VirtualItemEstimate[]): boolean {
    if (this.#sourceEstimatedItems === items) {
      return false;
    }
    const keys = new Array<string>(items.length);
    let uniformEstimate: number | null = null;
    let estimatesAreUniform = true;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item === undefined) {
        throw new Error("Virtual item estimates must address every item.");
      }
      if (!Number.isFinite(item.estimatedSize) || item.estimatedSize <= 0) {
        throw new Error("Virtual item estimates must be positive finite numbers.");
      }
      keys[index] = item.key;
      uniformEstimate ??= item.estimatedSize;
      estimatesAreUniform &&= item.estimatedSize === uniformEstimate;
    }
    const baseEstimate = estimatesAreUniform ? (uniformEstimate ?? this.#estimate) : this.#estimate;
    const estimateOverrides = new Map<number, number>();
    if (!estimatesAreUniform) {
      for (let index = 0; index < items.length; index += 1) {
        const estimatedSize = items[index]?.estimatedSize ?? this.#estimate;
        if (estimatedSize !== baseEstimate) {
          estimateOverrides.set(index, estimatedSize);
        }
      }
    }
    this.#sourceKeys = null;
    this.#sourceEstimatedItems = items;
    this.#sourceEstimatedKeys = null;
    this.#sourceEstimateAt = null;
    return this.#replaceItems(keys, baseEstimate, estimateOverrides);
  }

  setEstimatedKeys(
    keys: readonly string[],
    estimateAt: (key: string, index: number) => number,
  ): boolean {
    if (this.#sourceEstimatedKeys === keys && this.#sourceEstimateAt === estimateAt) {
      return false;
    }
    const estimates = new Float64Array(keys.length);
    let uniformEstimate: number | null = null;
    let estimatesAreUniform = true;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (key === undefined) {
        throw new Error("Virtualized timeline keys must address every item.");
      }
      const estimatedSize = estimateAt(key, index);
      if (!Number.isFinite(estimatedSize) || estimatedSize <= 0) {
        throw new Error("Virtual item estimates must be positive finite numbers.");
      }
      estimates[index] = estimatedSize;
      uniformEstimate ??= estimatedSize;
      estimatesAreUniform &&= estimatedSize === uniformEstimate;
    }
    const baseEstimate = estimatesAreUniform ? (uniformEstimate ?? this.#estimate) : this.#estimate;
    const estimateOverrides = new Map<number, number>();
    if (!estimatesAreUniform) {
      for (let index = 0; index < estimates.length; index += 1) {
        const estimatedSize = estimates[index] ?? this.#estimate;
        if (estimatedSize !== baseEstimate) {
          estimateOverrides.set(index, estimatedSize);
        }
      }
    }
    this.#sourceKeys = null;
    this.#sourceEstimatedItems = null;
    this.#sourceEstimatedKeys = keys;
    this.#sourceEstimateAt = estimateAt;
    return this.#replaceItems(keys, baseEstimate, estimateOverrides);
  }

  updateEstimatedSizes(estimateAt: (key: string, index: number) => number): boolean {
    let changed = false;
    for (let index = 0; index < this.#itemCount; index += 1) {
      const key = this.#keyAt(index);
      const estimatedSize = estimateAt(key, index);
      if (!Number.isFinite(estimatedSize) || estimatedSize <= 0) {
        throw new Error("Virtual item estimates must be positive finite numbers.");
      }
      if (this.#estimateAt(index) === estimatedSize) {
        continue;
      }
      const previousSize = this.#sizeAt(index);
      if (estimatedSize === this.#baseSizeAt(index)) {
        this.#estimateOverrides.delete(index);
      } else {
        this.#estimateOverrides.set(index, estimatedSize);
      }
      this.#measuredByKey.delete(key);
      this.#setSize(index, estimatedSize, previousSize);
      changed = true;
    }
    this.#sourceEstimateAt = estimateAt;
    return changed;
  }

  anchorAt(offset: number): VirtualAnchor | null {
    if (this.#itemCount === 0) {
      return null;
    }
    const safeOffset = Number.isFinite(offset)
      ? Math.min(this.totalSize(), Math.max(0, offset))
      : 0;
    const index = this.#indexAt(safeOffset);
    const key = this.#keyAt(index);
    const size = this.#sizeAt(index);
    return {
      key,
      offsetWithinItem: Math.min(size, Math.max(0, safeOffset - this.offsetOf(index))),
    };
  }

  resolveAnchorOffset(anchor: VirtualAnchor): number | null {
    const index = this.#indexForKey(anchor.key);
    if (
      index === undefined ||
      !Number.isFinite(anchor.offsetWithinItem) ||
      anchor.offsetWithinItem < 0
    ) {
      return null;
    }
    const size = this.#sizeAt(index);
    return this.offsetOf(index) + Math.min(size, anchor.offsetWithinItem);
  }

  indexOf(key: string): number | null {
    return this.#indexForKey(key) ?? null;
  }

  measure(key: string, size: number): MeasurementChange | null {
    const index = this.#indexForKey(key);
    if (index === undefined || !Number.isFinite(size) || size <= 0) {
      return null;
    }
    const normalized = Math.max(1, Math.round(size));
    const previous = this.#sizeAt(index);
    if (previous === normalized) {
      return null;
    }
    this.#setSize(index, normalized, previous);
    this.#measuredByKey.set(key, normalized);
    return { delta: normalized - previous, index };
  }

  estimate(key: string, estimatedSize: number): boolean {
    const index = this.#indexForKey(key);
    if (index === undefined) {
      return false;
    }
    if (!Number.isFinite(estimatedSize) || estimatedSize <= 0) {
      throw new Error("Virtual item estimates must be positive finite numbers.");
    }
    const previousEstimate = this.#estimateAt(index);
    if (previousEstimate === estimatedSize) {
      return false;
    }
    const previousSize = this.#sizeAt(index);
    if (estimatedSize === this.#baseSizeAt(index)) {
      this.#estimateOverrides.delete(index);
    } else {
      this.#estimateOverrides.set(index, estimatedSize);
    }
    this.#measuredByKey.delete(key);
    this.#setSize(index, estimatedSize, previousSize);
    return true;
  }

  estimatedSizeOf(key: string): number | null {
    const index = this.#indexForKey(key);
    return index === undefined ? null : this.#estimateAt(index);
  }

  measureBatch(measurements: readonly VirtualMeasurement[]): MeasurementBatch {
    const ordered = measurements
      .map((measurement) => ({
        ...measurement,
        index: this.#indexForKey(measurement.key),
      }))
      .filter(
        (measurement): measurement is VirtualMeasurement & { readonly index: number } =>
          measurement.index !== undefined,
      )
      .sort((left, right) => left.index - right.index);
    let changed = false;

    for (const measurement of ordered) {
      changed = this.measure(measurement.key, measurement.size) !== null || changed;
    }

    return { changed };
  }

  resetMeasurements(): boolean {
    if (this.#measuredByKey.size === 0) {
      return false;
    }
    for (const key of this.#measuredByKey.keys()) {
      const index = this.#indexForKey(key);
      if (index === undefined) {
        continue;
      }
      const previousSize = this.#sizeAt(index);
      const estimatedSize = this.#estimateAt(index);
      if (previousSize !== estimatedSize) {
        this.#setSize(index, estimatedSize, previousSize);
      }
    }
    this.#measuredByKey.clear();
    return true;
  }

  resetEstimates(): boolean {
    if (
      this.#baseEstimate === this.#estimate &&
      this.#estimateOverrides.size === 0 &&
      this.#measuredByKey.size === 0
    ) {
      return false;
    }
    if (this.#itemSource === null) {
      this.#baseEstimate = this.#estimate;
    }
    this.#estimateOverrides.clear();
    this.#sizeOverrides.clear();
    this.#measuredByKey.clear();
    this.#sourceEstimatedItems = null;
    this.#sourceEstimatedKeys = null;
    this.#sourceEstimateAt = null;
    this.#tree = new Float64Array(this.#itemCount + 1);
    return true;
  }

  sizeOf(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.#itemCount) {
      throw new Error("Virtual item indexes must address an existing item.");
    }
    return this.#sizeAt(index);
  }

  offsetOf(index: number): number {
    const bounded = Math.min(this.#itemCount, Math.max(0, Math.trunc(index)));
    let delta = 0;
    for (let cursor = bounded; cursor > 0; cursor -= cursor & -cursor) {
      delta += this.#tree[cursor] ?? 0;
    }
    return this.#baseOffsetOf(bounded) + delta;
  }

  totalSize(): number {
    return this.offsetOf(this.#itemCount);
  }

  range(scrollOffset: number, viewportSize: number, overscan: number): VirtualRange {
    if (this.#itemCount === 0) {
      return { start: 0, end: 0 };
    }
    const safeOffset = Number.isFinite(scrollOffset) ? Math.max(0, scrollOffset) : 0;
    const safeViewport = Number.isFinite(viewportSize) ? Math.max(1, viewportSize) : 1;
    const safeOverscan = Number.isFinite(overscan) ? Math.max(0, overscan) : 0;
    const start = this.#indexAt(Math.max(0, safeOffset - safeOverscan));
    const endOffset = Math.min(this.totalSize(), safeOffset + safeViewport + safeOverscan);
    return {
      start,
      end: Math.min(this.#itemCount, this.#indexAt(endOffset) + 1),
    };
  }

  #add(index: number, delta: number): void {
    for (let cursor = index + 1; cursor < this.#tree.length; cursor += cursor & -cursor) {
      this.#tree[cursor] = (this.#tree[cursor] ?? 0) + delta;
    }
  }

  #estimateAt(index: number): number {
    return this.#estimateOverrides.get(index) ?? this.#baseSizeAt(index);
  }

  #indexAt(offset: number): number {
    if (this.#itemSource !== null && this.#itemSourceUniformEstimate === null) {
      let start = 0;
      let end = this.#itemCount;
      while (start < end) {
        const middle = start + Math.floor((end - start) / 2);
        if (this.offsetOf(middle + 1) <= offset) {
          start = middle + 1;
        } else {
          end = middle;
        }
      }
      return Math.min(start, this.#itemCount - 1);
    }
    let index = 0;
    let prefix = 0;
    let bit = highestPowerOfTwo(this.#itemCount);
    while (bit !== 0) {
      const candidate = index + bit;
      const delta = this.#tree[candidate];
      if (candidate <= this.#itemCount && delta !== undefined) {
        const baseEstimate = this.#itemSourceUniformEstimate ?? this.#baseEstimate;
        const candidateValue = (candidate & -candidate) * baseEstimate + delta;
        if (prefix + candidateValue <= offset) {
          index = candidate;
          prefix += candidateValue;
        }
      }
      bit >>= 1;
    }
    return Math.min(index, this.#itemCount - 1);
  }

  #rebuildTree(): void {
    this.#tree = new Float64Array(this.#itemCount + 1);
    if (this.#sizeOverrides.size === 0) {
      return;
    }
    for (const [index, size] of this.#sizeOverrides) {
      this.#tree[index + 1] = size - this.#baseSizeAt(index);
    }
    for (let cursor = 1; cursor < this.#tree.length; cursor += 1) {
      const parent = cursor + (cursor & -cursor);
      if (parent < this.#tree.length) {
        this.#tree[parent] = (this.#tree[parent] ?? 0) + (this.#tree[cursor] ?? 0);
      }
    }
  }

  #replaceItems(
    keys: readonly string[],
    baseEstimate: number,
    estimateOverrides: ReadonlyMap<number, number>,
  ): boolean {
    const nextIndexByKey = new Map<string, number>();
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (key === undefined) {
        throw new Error("Virtualized timeline keys must address every item.");
      }
      if (nextIndexByKey.has(key)) {
        throw new Error("Virtualized timeline keys must be unique.");
      }
      nextIndexByKey.set(key, index);
    }

    const keysChanged = this.#itemSource !== null || !sameKeys(this.#keys, keys);
    let estimatesChanged = this.#itemCount !== keys.length;
    if (!estimatesChanged) {
      for (let index = 0; index < keys.length; index += 1) {
        if (this.#estimateAt(index) !== (estimateOverrides.get(index) ?? baseEstimate)) {
          estimatesChanged = true;
          break;
        }
      }
    }
    if (!keysChanged && !estimatesChanged) {
      return false;
    }

    const previousIndexByKey = this.#indexByKey;
    const previousMeasuredByKey = this.#measuredByKey;
    const nextMeasuredByKey = new Map<string, number>();
    for (const [key, measuredSize] of previousMeasuredByKey) {
      const previousIndex = previousIndexByKey.get(key);
      const nextIndex = nextIndexByKey.get(key);
      if (
        previousIndex !== undefined &&
        nextIndex !== undefined &&
        this.#estimateAt(previousIndex) === (estimateOverrides.get(nextIndex) ?? baseEstimate)
      ) {
        nextMeasuredByKey.set(key, measuredSize);
      }
    }

    this.#itemSource = null;
    this.#itemSourceUniformEstimate = null;
    this.#itemCount = keys.length;
    this.#keys = keys;
    this.#indexByKey = nextIndexByKey;
    this.#baseEstimate = baseEstimate;
    this.#estimateOverrides = new Map(estimateOverrides);
    this.#measuredByKey = nextMeasuredByKey;
    this.#sizeOverrides = new Map(estimateOverrides);
    for (const [key, measuredSize] of nextMeasuredByKey) {
      const index = nextIndexByKey.get(key);
      if (index === undefined) {
        continue;
      }
      if (measuredSize === baseEstimate) {
        this.#sizeOverrides.delete(index);
      } else {
        this.#sizeOverrides.set(index, measuredSize);
      }
    }
    this.#rebuildTree();
    return true;
  }

  #setSize(index: number, size: number, previousSize = this.#sizeAt(index)): void {
    if (size === this.#baseEstimate) {
      this.#sizeOverrides.delete(index);
    } else {
      this.#sizeOverrides.set(index, size);
    }
    this.#add(index, size - previousSize);
  }

  #sizeAt(index: number): number {
    return this.#sizeOverrides.get(index) ?? this.#baseSizeAt(index);
  }

  #baseOffsetOf(index: number): number {
    if (this.#itemSource === null) {
      return index * this.#baseEstimate;
    }
    const uniformEstimate = this.#itemSourceUniformEstimate;
    return uniformEstimate === null
      ? this.#itemSource.estimatedOffsetOf(index)
      : index * uniformEstimate;
  }

  #baseSizeAt(index: number): number {
    if (this.#itemSource === null) {
      return this.#baseEstimate;
    }
    return this.#itemSourceUniformEstimate ?? this.#itemSource.estimatedSizeAt(index);
  }

  #indexForKey(key: string): number | undefined {
    const source = this.#itemSource;
    if (source !== null) {
      const index = source.indexOf(key);
      return index !== null && index >= 0 && index < this.#itemCount && source.keyAt(index) === key
        ? index
        : undefined;
    }
    const cached = this.#indexByKey.get(key);
    if (cached !== undefined) {
      return cached;
    }
    return undefined;
  }

  #keyAt(index: number): string {
    const source = this.#itemSource;
    if (source === null) {
      const key = this.#keys[index];
      if (key === undefined) {
        throw new Error("Virtualized timeline keys must address every item.");
      }
      return key;
    }
    const key = source.keyAt(index);
    return key;
  }
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function highestPowerOfTwo(value: number): number {
  let power = 1;
  while (power * 2 <= value) {
    power *= 2;
  }
  return power;
}

function assertVirtualItemSource(
  source: VirtualItemSource,
  uniformEstimatedSize: number | null,
): void {
  if (!Number.isSafeInteger(source.count) || source.count < 0) {
    throw new Error("Virtual item sources require a non-negative safe item count.");
  }
  if (
    uniformEstimatedSize !== null &&
    (!Number.isFinite(uniformEstimatedSize) || uniformEstimatedSize <= 0)
  ) {
    throw new Error("Virtual item estimates must be positive finite numbers.");
  }
  const estimatedTotal =
    uniformEstimatedSize === null
      ? source.estimatedOffsetOf(source.count)
      : uniformEstimatedSize * source.count;
  if (!Number.isFinite(estimatedTotal) || estimatedTotal < 0) {
    throw new Error("Virtual item sources require a finite non-negative estimated size.");
  }
}
