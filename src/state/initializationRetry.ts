import { decodeCommandError } from "../contracts/decode";

const MAX_INITIALIZATION_RETRY_DELAY_MS = 60_000;

export type InitializationStage = "account" | "authenticatedState" | "engine" | "events";

export class InitializationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitializationTimeoutError";
  }
}

export function initializationRetryDelay(attempt: number): number {
  const normalizedAttempt = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 0;
  const exponent = Math.min(normalizedAttempt, 6);
  return Math.min(1_000 * 2 ** exponent, MAX_INITIALIZATION_RETRY_DELAY_MS);
}

export function isRetryableInitializationFailure(
  reason: unknown,
  stage: InitializationStage,
): boolean {
  if (reason instanceof InitializationTimeoutError) {
    return true;
  }
  const commandError = decodeCommandError(reason);
  if (commandError !== null) {
    return commandError.retryable;
  }
  return stage === "events";
}
