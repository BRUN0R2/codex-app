import { describe, expect, it } from "vitest";

import type {
  AccountRateLimitsResponse,
  RateLimitSnapshot,
  RateLimitUpdateSnapshot,
} from "../contracts/types";
import { generalRateLimitSnapshot, mergeRateLimitUpdate } from "./rateLimits";

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
    generalRateLimit: primary,
    additionalRateLimitsByLimitId: {},
    planPrices: [{ planType: "pro", amount: 2000, currency: "USD", minorUnitExponent: 2 }],
    lunaReserveAvailable: false,
  };
}

function bucket(value: AccountRateLimitsResponse, limitId: string): RateLimitSnapshot | undefined {
  return value.additionalRateLimitsByLimitId[limitId];
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

    expect(merged.generalRateLimit).toEqual({
      ...primary,
      primary: update.primary,
    });
    expect(merged.planPrices).toEqual(response().planPrices);
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

    expect(merged.generalRateLimit).toBe(primary);
    expect(bucket(merged, "codex_bengalfox")).toEqual(update);
  });

  it("atualiza o reserva sem substituir o limite geral", () => {
    const reserve: RateLimitSnapshot = {
      ...primary,
      limitId: "base_model_inference",
      limitName: "gpt-reserve",
      primary: { usedPercent: 1, windowDurationMins: 10_080, resetsAt: 6_000 },
      secondary: null,
    };
    const current: AccountRateLimitsResponse = {
      ...response(),
      additionalRateLimitsByLimitId: { base_model_inference: reserve },
    };
    const update: RateLimitUpdateSnapshot = {
      ...reserve,
      limitId: "base_model_inference",
      primary: { usedPercent: 2, windowDurationMins: 10_080, resetsAt: 7_000 },
    };

    const merged = mergeRateLimitUpdate(current, update);

    expect(generalRateLimitSnapshot(merged)).toBe(primary);
    expect(merged.generalRateLimit).toBe(primary);
    expect(bucket(merged, "base_model_inference")).toEqual(update);
  });
});
