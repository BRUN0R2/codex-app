export function assertNever(value: never): never {
  throw new Error(`Unhandled contract state: ${JSON.stringify(value)}`);
}
