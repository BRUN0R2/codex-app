export class TimelineLayoutMeasurement {
  readonly #measure: () => void;
  #generation = 0;
  #scheduledGeneration: number | undefined;

  constructor(measure: () => void) {
    this.#measure = measure;
  }

  request(): void {
    if (this.#scheduledGeneration !== undefined) return;
    const generation = ++this.#generation;
    this.#scheduledGeneration = generation;
    queueMicrotask(() => {
      if (this.#scheduledGeneration !== generation) return;
      this.#scheduledGeneration = undefined;
      this.#measure();
    });
  }

  cancel(): void {
    this.#scheduledGeneration = undefined;
  }
}
