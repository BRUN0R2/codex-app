export interface VirtualRange {
  readonly end: number;
  readonly start: number;
}

export interface MeasurementChange {
  readonly delta: number;
  readonly index: number;
}

export interface VirtualMeasurement {
  readonly key: string;
  readonly size: number;
}

export interface MeasurementBatch {
  readonly anchorDelta: number;
  readonly changed: boolean;
}

export class VariableSizeVirtualizer {
  readonly #estimate: number;
  #keys: readonly string[] = [];
  #sourceKeys: readonly string[] | null = null;
  #indexByKey = new Map<string, number>();
  #measuredByKey = new Map<string, number>();
  #sizes = new Float64Array(0);
  #tree = new Float64Array(1);

  constructor(estimatedSize: number) {
    if (!Number.isFinite(estimatedSize) || estimatedSize <= 0) {
      throw new Error("The virtual item estimate must be a positive finite number.");
    }
    this.#estimate = estimatedSize;
  }

  setKeys(keys: readonly string[]): boolean {
    if (this.#sourceKeys === keys) {
      return false;
    }
    if (sameKeys(this.#keys, keys)) {
      this.#sourceKeys = keys;
      return false;
    }
    const unique = new Set(keys);
    if (unique.size !== keys.length) {
      throw new Error("Virtualized timeline keys must be unique.");
    }
    for (const key of this.#measuredByKey.keys()) {
      if (!unique.has(key)) {
        this.#measuredByKey.delete(key);
      }
    }
    this.#keys = [...keys];
    this.#sourceKeys = keys;
    this.#indexByKey = new Map(keys.map((key, index) => [key, index]));
    this.#sizes = Float64Array.from(keys, (key) => this.#measuredByKey.get(key) ?? this.#estimate);
    this.#tree = new Float64Array(keys.length + 1);
    for (let index = 0; index < this.#sizes.length; index += 1) {
      const cursor = index + 1;
      this.#tree[cursor] = (this.#tree[cursor] ?? 0) + (this.#sizes[index] ?? this.#estimate);
      const parent = cursor + (cursor & -cursor);
      if (parent < this.#tree.length) {
        this.#tree[parent] = (this.#tree[parent] ?? 0) + (this.#tree[cursor] ?? 0);
      }
    }
    return true;
  }

  measure(key: string, size: number): MeasurementChange | null {
    const index = this.#indexByKey.get(key);
    if (index === undefined || !Number.isFinite(size) || size <= 0) {
      return null;
    }
    const normalized = Math.max(1, Math.round(size));
    const previous = this.#sizes[index];
    if (previous === undefined || previous === normalized) {
      return null;
    }
    const delta = normalized - previous;
    this.#sizes[index] = normalized;
    this.#measuredByKey.set(key, normalized);
    this.#add(index, delta);
    return { delta, index };
  }

  measureBatch(
    measurements: readonly VirtualMeasurement[],
    anchorOffset: number,
  ): MeasurementBatch {
    const ordered = measurements
      .map((measurement) => ({
        ...measurement,
        index: this.#indexByKey.get(measurement.key),
      }))
      .filter(
        (measurement): measurement is VirtualMeasurement & { readonly index: number } =>
          measurement.index !== undefined,
      )
      .sort((left, right) => left.index - right.index);
    const safeAnchorOffset = Number.isFinite(anchorOffset) ? Math.max(0, anchorOffset) : 0;
    let anchorDelta = 0;
    let changed = false;

    for (const measurement of ordered) {
      const change = this.measure(measurement.key, measurement.size);
      if (change === null) {
        continue;
      }
      changed = true;
      const previousBottom = this.offsetOf(change.index + 1) - change.delta;
      if (previousBottom <= safeAnchorOffset + anchorDelta) {
        anchorDelta += change.delta;
      }
    }

    return { anchorDelta, changed };
  }

  offsetOf(index: number): number {
    const bounded = Math.min(this.#keys.length, Math.max(0, Math.trunc(index)));
    let sum = 0;
    for (let cursor = bounded; cursor > 0; cursor -= cursor & -cursor) {
      sum += this.#tree[cursor] ?? 0;
    }
    return sum;
  }

  totalSize(): number {
    return this.offsetOf(this.#keys.length);
  }

  range(scrollOffset: number, viewportSize: number, overscan: number): VirtualRange {
    if (this.#keys.length === 0) {
      return { start: 0, end: 0 };
    }
    const safeOffset = Number.isFinite(scrollOffset) ? Math.max(0, scrollOffset) : 0;
    const safeViewport = Number.isFinite(viewportSize) ? Math.max(1, viewportSize) : 1;
    const safeOverscan = Number.isFinite(overscan) ? Math.max(0, overscan) : 0;
    const start = this.#indexAt(Math.max(0, safeOffset - safeOverscan));
    const endOffset = Math.min(this.totalSize(), safeOffset + safeViewport + safeOverscan);
    return {
      start,
      end: Math.min(this.#keys.length, this.#indexAt(endOffset) + 1),
    };
  }

  #add(index: number, delta: number): void {
    for (let cursor = index + 1; cursor < this.#tree.length; cursor += cursor & -cursor) {
      this.#tree[cursor] = (this.#tree[cursor] ?? 0) + delta;
    }
  }

  #indexAt(offset: number): number {
    let index = 0;
    let prefix = 0;
    let bit = highestPowerOfTwo(this.#keys.length);
    while (bit !== 0) {
      const candidate = index + bit;
      const candidateValue = this.#tree[candidate];
      if (
        candidate <= this.#keys.length &&
        candidateValue !== undefined &&
        prefix + candidateValue <= offset
      ) {
        index = candidate;
        prefix += candidateValue;
      }
      bit >>= 1;
    }
    return Math.min(index, this.#keys.length - 1);
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
