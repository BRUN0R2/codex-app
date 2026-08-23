import { describe, expect, it } from "vitest";

import type { AccountRateLimitsResponse, RateLimitSnapshot } from "../contracts/types";
import { presentUsageLimits, usagePercentLabel, usageWindowLabel } from "./usagePresentation";

function snapshot(overrides: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot {
  return {
    limitId: "codex",
    limitName: null,
    primary: null,
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: "plus",
    rateLimitReachedType: null,
    ...overrides,
  };
}

function response(
  primary: RateLimitSnapshot,
  additional: Readonly<Record<string, RateLimitSnapshot>> = {},
): AccountRateLimitsResponse {
  return {
    rateLimits: primary,
    rateLimitsByLimitId: { codex: primary, ...additional },
    planPrice: null,
  };
}

describe("usage limit presentation", () => {
  it("names common Codex windows by their actual duration", () => {
    expect(usageWindowLabel(300)).toBe("Limite de uso de 5 horas");
    expect(usageWindowLabel(1_440)).toBe("Limite de uso diário");
    expect(usageWindowLabel(10_080)).toBe("Limite de uso semanal");
    expect(usageWindowLabel(43_200)).toBe("Limite de uso mensal");
  });

  it("keeps uncommon windows explicit instead of assigning a false cycle", () => {
    expect(usageWindowLabel(90)).toBe("Limite de uso de 90 minutos");
    expect(usageWindowLabel(2_880)).toBe("Limite de uso de 2 dias");
    expect(usageWindowLabel(null)).toBe("Limite de uso");
  });

  it("uses remaining capacity for the meter", () => {
    const groups = presentUsageLimits(
      response(
        snapshot({
          primary: { usedPercent: 51, windowDurationMins: 43_200, resetsAt: 1_800_000_000_000 },
        }),
      ),
    );

    expect(groups[0]?.limits[0]).toMatchObject({
      label: "Limite de uso mensal",
      remainingPercent: 49,
      usedPercent: 51,
    });
    expect(usagePercentLabel(groups[0]?.limits[0]?.remainingPercent ?? 0)).toBe("49%");
  });

  it("lists Codex 5.3 Spark as an independent server-provided bucket", () => {
    const groups = presentUsageLimits(
      response(
        snapshot({
          primary: { usedPercent: 45, windowDurationMins: 300, resetsAt: 1_800_000_000_000 },
          secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 1_800_500_000_000 },
        }),
        {
          codex_spark: snapshot({
            limitId: "codex_spark",
            limitName: "Codex 5.3 Spark",
            primary: { usedPercent: 10, windowDurationMins: 1_440, resetsAt: 1_800_000_000_000 },
            secondary: {
              usedPercent: 51,
              windowDurationMins: 43_200,
              resetsAt: 1_802_600_000_000,
            },
          }),
        },
      ),
    );

    expect(groups).toEqual([
      {
        id: "codex",
        label: null,
        limits: [
          expect.objectContaining({ label: "Limite de uso de 5 horas" }),
          expect.objectContaining({ label: "Limite de uso semanal" }),
        ],
      },
      {
        id: "codex_spark",
        label: "Codex 5.3 Spark",
        limits: [
          expect.objectContaining({ label: "Limite de uso diário" }),
          expect.objectContaining({
            label: "Limite de uso mensal",
            remainingPercent: 49,
          }),
        ],
      },
    ]);
  });
});
