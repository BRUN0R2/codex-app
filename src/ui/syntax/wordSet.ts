export function unionWords(...sets: readonly ReadonlySet<string>[]): ReadonlySet<string> {
  return new LazyUnionWordSet(sets);
}

export function words(value: string): ReadonlySet<string> {
  return new LazyWordSet(value);
}

class LazyWordSet extends Set<string> {
  #source: string | null;

  constructor(source: string) {
    super();
    this.#source = source;
  }

  override get size(): number {
    this.#materialize();
    return super.size;
  }

  override entries(): SetIterator<[string, string]> {
    this.#materialize();
    return super.entries();
  }

  override forEach(
    callbackfn: (value: string, value2: string, set: Set<string>) => void,
    thisArg?: unknown,
  ): void {
    this.#materialize();
    super.forEach(callbackfn, thisArg);
  }

  override has(value: string): boolean {
    this.#materialize();
    return super.has(value);
  }

  override keys(): SetIterator<string> {
    this.#materialize();
    return super.keys();
  }

  override values(): SetIterator<string> {
    this.#materialize();
    return super.values();
  }

  override [Symbol.iterator](): SetIterator<string> {
    return this.values();
  }

  #materialize(): void {
    if (this.#source === null) {
      return;
    }
    for (const word of this.#source.split(/\s+/u)) {
      if (word.length > 0) {
        super.add(word);
      }
    }
    this.#source = null;
  }
}

class LazyUnionWordSet extends Set<string> {
  readonly #sources: readonly ReadonlySet<string>[];
  #materialized = false;

  constructor(sources: readonly ReadonlySet<string>[]) {
    super();
    this.#sources = sources;
  }

  override get size(): number {
    this.#materialize();
    return super.size;
  }

  override entries(): SetIterator<[string, string]> {
    this.#materialize();
    return super.entries();
  }

  override forEach(
    callbackfn: (value: string, value2: string, set: Set<string>) => void,
    thisArg?: unknown,
  ): void {
    this.#materialize();
    super.forEach(callbackfn, thisArg);
  }

  override has(value: string): boolean {
    return this.#materialized
      ? super.has(value)
      : this.#sources.some((source) => source.has(value));
  }

  override keys(): SetIterator<string> {
    this.#materialize();
    return super.keys();
  }

  override values(): SetIterator<string> {
    this.#materialize();
    return super.values();
  }

  override [Symbol.iterator](): SetIterator<string> {
    return this.values();
  }

  #materialize(): void {
    if (this.#materialized) {
      return;
    }
    for (const source of this.#sources) {
      for (const word of source) {
        super.add(word);
      }
    }
    this.#materialized = true;
  }
}
