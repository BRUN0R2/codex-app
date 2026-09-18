import { describeError } from "../infrastructure/codexClient";
import { InitializationTimeoutError } from "./initializationTimeout";
import type { SingleFlightOperations } from "./singleFlightOperations";
import type { UiError } from "./uiError";

export type CapturedInitialization<T> =
  | { readonly value: T; readonly failure: undefined }
  | { readonly value: undefined; readonly failure: Error };

export function captureInitialization<T>(load: () => T): CapturedInitialization<T> {
  try {
    return { value: load(), failure: undefined };
  } catch (reason) {
    return { value: undefined, failure: asError(reason) };
  }
}

export function settledQueueTail(operation: Promise<unknown>): Promise<void> {
  return operation.then(
    () => undefined,
    () => undefined,
  );
}

export function withBootTimeout<T>(
  label: string,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new InitializationTimeoutError(
          `Initialization did not complete the "${label}" step within ${timeoutMs / 1000} seconds. Try again.`,
        ),
      );
    }, timeoutMs);
  });
  return Promise.race([operation(), timeout]).finally(() => clearTimeout(timer));
}

export interface SessionControllerHost {
  readonly isDisposed: () => boolean;
  readonly reportError: (reason: unknown) => void;
  readonly setError: (error: UiError | null) => void;
  readonly singleFlight: SingleFlightOperations<string, boolean>;
  readonly withPending: <T>(operation: () => Promise<T>) => Promise<T>;
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(describeError(reason));
}
