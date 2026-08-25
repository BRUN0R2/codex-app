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
      throw new Error("A cache exige uma quantidade máxima inteira e positiva de entradas.");
    }
    if (!Number.isSafeInteger(maximumWeight) || maximumWeight < 1) {
      throw new Error("A cache exige um peso máximo inteiro e positivo.");
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
      throw new Error("O peso de uma entrada da cache deve ser um inteiro positivo.");
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
        throw new Error("A cache ponderada perdeu o candidato à expulsão.");
      }
      const oldest = this.#entries.get(oldestKey);
      this.#entries.delete(oldestKey);
      this.#weight -= oldest?.weight ?? 0;
    }
  }
}
