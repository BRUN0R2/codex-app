export class SingleFlightOperations<Key, Result> {
  readonly #active = new Map<Key, Promise<Result>>();

  run(key: Key, operation: () => Promise<Result>): Promise<Result> {
    const active = this.#active.get(key);
    if (active !== undefined) {
      return active;
    }

    let request: Promise<Result>;
    request = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.#active.get(key) === request) {
          this.#active.delete(key);
        }
      });
    this.#active.set(key, request);
    return request;
  }
}
