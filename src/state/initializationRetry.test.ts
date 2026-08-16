import { describe, expect, it } from "vitest";

import {
  InitializationTimeoutError,
  initializationRetryDelay,
  isRetryableInitializationFailure,
} from "./initializationRetry";

describe("initialization retry", () => {
  it("backs off exponentially without ever giving up or exceeding one minute", () => {
    expect(initializationRetryDelay(0)).toBe(1_000);
    expect(initializationRetryDelay(1)).toBe(2_000);
    expect(initializationRetryDelay(5)).toBe(32_000);
    expect(initializationRetryDelay(100)).toBe(60_000);
  });

  it("retries timeouts, event registration, and retryable native failures", () => {
    expect(
      isRetryableInitializationFailure(new InitializationTimeoutError("timeout"), "engine"),
    ).toBe(true);
    expect(isRetryableInitializationFailure(new Error("bridge unavailable"), "events")).toBe(true);
    expect(
      isRetryableInitializationFailure(
        { code: "providerUnavailable", message: "offline", retryable: true },
        "account",
      ),
    ).toBe(true);
  });

  it("does not loop forever on permanent contract or storage failures", () => {
    expect(isRetryableInitializationFailure(new Error("invalid contract"), "engine")).toBe(false);
    expect(
      isRetryableInitializationFailure(
        { code: "storageFailed", message: "corrupt database", retryable: false },
        "engine",
      ),
    ).toBe(false);
  });
});
