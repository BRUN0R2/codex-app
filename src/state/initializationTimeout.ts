export class InitializationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitializationTimeoutError";
  }
}
