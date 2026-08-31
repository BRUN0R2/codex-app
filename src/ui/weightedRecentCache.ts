interface WeightedRecentEntry<Value extends object> {
  readonly value: Value;
  readonly weight: number;
}

export class WeightedRecentCache<Key, Value extends object> {
  readonly #entries = new Map<Key, WeightedRecentEntry<Value>>();
  readonly #maximumEntries: number;
  readonly #maximumWeight: number;
  #weight = 0;

  constructor(maximumEntries: number, maximumWeight: number) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error("The cache requires a positive integer maximum entry count.");
    }
    if (!Number.isSafeInteger(maximumWeight) || maximumWeight < 1) {
      throw new Error("The cache requires a positive integer maximum weight.");
    }
    this.#maximumEntries = maximumEntries;
    this.#maximumWeight = maximumWeight;
  }

  get size(): number {
    return this.#entries.size;
  }

  get weight(): number {
    return this.#weight;
  }

  read(key: Key): Value | null {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return null;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  write(key: Key, value: Value, weight: number): boolean {
    if (!Number.isSafeInteger(weight) || weight < 1) {
      throw new Error("A cache entry weight must be a positive integer.");
    }
    const previous = this.#entries.get(key);
    if (previous !== undefined) {
      this.#entries.delete(key);
      this.#weight -= previous.weight;
    }
    if (weight > this.#maximumWeight) {
      return false;
    }
    this.#entries.set(key, { value, weight });
    this.#weight += weight;
    this.#evictOverflow();
    return this.#entries.has(key);
  }

  clear(): void {
    this.#entries.clear();
    this.#weight = 0;
  }

  #evictOverflow(): void {
    while (this.#entries.size > this.#maximumEntries || this.#weight > this.#maximumWeight) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey === undefined) {
        throw new Error("The weighted cache lost its eviction candidate.");
      }
      const oldest = this.#entries.get(oldestKey);
      this.#entries.delete(oldestKey);
      this.#weight -= oldest?.weight ?? 0;
    }
  }
}
