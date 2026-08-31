import { describe, expect, it } from "vitest";

import type {
  AccountRateLimitsResponse,
  RateLimitSnapshot,
  RateLimitUpdateSnapshot,
} from "../contracts/types";
import { mergeRateLimitUpdate } from "./rateLimits";

const primary: RateLimitSnapshot = {
  limitId: "codex",
  limitName: "Codex",
  primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_000 },
  secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 2_000 },
  credits: { hasCredits: true, unlimited: false, balance: "25" },
  individualLimit: { limit: "100", used: "20", remainingPercent: 80, resetsAt: 3_000 },
  spendControlReached: false,
  planType: "pro",
  rateLimitReachedType: null,
};

function response(): AccountRateLimitsResponse {
  return {
    rateLimits: primary,
    rateLimitsByLimitId: { codex: primary },
    planPrice: { amount: 2000, currency: "USD", minorUnitExponent: 2 },
  };
}

function bucket(value: AccountRateLimitsResponse, limitId: string): RateLimitSnapshot | undefined {
  return value.rateLimitsByLimitId[limitId];
}

describe("atualizações incrementais de limite de uso", () => {
  it("substitui somente os campos presentes e preserva metadados da leitura completa", () => {
    const update: RateLimitUpdateSnapshot = {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 4_000 },
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: null,
      rateLimitReachedType: null,
    };

    const merged = mergeRateLimitUpdate(response(), update);

    expect(merged.rateLimits).toEqual({
      ...primary,
      primary: update.primary,
    });
    expect(bucket(merged, "codex")).toEqual(merged.rateLimits);
    expect(merged.planPrice).toEqual(response().planPrice);
  });

  it("insere um novo bucket sem substituir o limite principal", () => {
    const update: RateLimitUpdateSnapshot = {
      limitId: "codex_bengalfox",
      limitName: null,
      primary: { usedPercent: 8, windowDurationMins: 60, resetsAt: 5_000 },
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: null,
      rateLimitReachedType: null,
    };

    const merged = mergeRateLimitUpdate(response(), update);

    expect(merged.rateLimits).toBe(primary);
    expect(bucket(merged, "codex_bengalfox")).toEqual(update);
  });
});
