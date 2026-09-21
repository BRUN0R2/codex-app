import { describe, expect, it } from "vitest";

import type { AccountRateLimitsResponse, RateLimitSnapshot } from "../contracts/types";
import { presentLunaReserveUsage } from "./lunaReserve";

function snapshot(overrides: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot {
  return {
    limitId: "base_model_inference",
    limitName: "gpt-reserve",
    primary: null,
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: "pro",
    rateLimitReachedType: null,
    ...overrides,
  };
}

function response(
  reserve: RateLimitSnapshot,
  lunaReserveAvailable = true,
): AccountRateLimitsResponse {
  return {
    generalRateLimit: {
      ...snapshot(),
      limitId: "codex",
      limitName: null,
    },
    additionalRateLimitsByLimitId: {
      base_model_inference: reserve,
    },
    planPrices: [],
    lunaReserveAvailable,
  };
}

describe("Luna Reserve usage", () => {
  it("uses the longest server-provided window for the account card", () => {
    expect(
      presentLunaReserveUsage(
        response(
          snapshot({
            primary: { usedPercent: 48, windowDurationMins: 300, resetsAt: 1_000 },
            secondary: { usedPercent: 14, windowDurationMins: 10_080, resetsAt: 2_000 },
          }),
        ),
      ),
    ).toEqual({
      remainingPercent: 86,
      resetAt: 2_000,
      windowDurationMins: 10_080,
    });
  });

  it("does not invent a reserve card when the bucket has no usable window", () => {
    expect(presentLunaReserveUsage(response(snapshot()))).toBeNull();
    expect(presentLunaReserveUsage(null)).toBeNull();
  });

  it("keeps a historical reserve bucket hidden while reserve is not active", () => {
    expect(
      presentLunaReserveUsage(
        response(
          snapshot({
            secondary: { usedPercent: 14, windowDurationMins: 10_080, resetsAt: 2_000 },
          }),
          false,
        ),
      ),
    ).toBeNull();
  });

  it("does not confuse another additional bucket with Luna Reserve", () => {
    expect(
      presentLunaReserveUsage(
        response(
          snapshot({
            limitName: "GPT-5.3-Codex-Spark",
            primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_000 },
          }),
        ),
      ),
    ).toBeNull();
  });
});
