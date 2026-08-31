import { describe, expect, it } from "vitest";

import type { AccountRateLimitsResponse, RateLimitSnapshot } from "../contracts/types";
import { findCatalog, translationCatalogs } from "../i18n/catalog";
import { presentUsageLimits, usagePercentLabel, usageWindowLabel } from "./usagePresentation";

const english = findCatalog(translationCatalogs, "en")?.messages.settings;
if (english === undefined) throw new Error("The English translation catalog is unavailable.");

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
    expect(usageWindowLabel(300, english)).toBe("5-hour usage limit");
    expect(usageWindowLabel(1_440, english)).toBe("Daily usage limit");
    expect(usageWindowLabel(10_080, english)).toBe("Weekly usage limit");
    expect(usageWindowLabel(43_200, english)).toBe("Monthly usage limit");
  });

  it("keeps uncommon windows explicit instead of assigning a false cycle", () => {
    expect(usageWindowLabel(90, english)).toBe("90-minute usage limit");
    expect(usageWindowLabel(2_880, english)).toBe("2-day usage limit");
    expect(usageWindowLabel(null, english)).toBe("Usage limit");
  });

  it("uses remaining capacity for the meter", () => {
    const groups = presentUsageLimits(
      response(
        snapshot({
          primary: { usedPercent: 51, windowDurationMins: 43_200, resetsAt: 1_800_000_000_000 },
        }),
      ),
      english,
      "en",
    );

    expect(groups[0]?.limits[0]).toMatchObject({
      label: "Monthly usage limit",
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
      english,
      "en",
    );

    expect(groups).toEqual([
      {
        id: "codex",
        label: null,
        limits: [
          expect.objectContaining({ label: "5-hour usage limit" }),
          expect.objectContaining({ label: "Weekly usage limit" }),
        ],
      },
      {
        id: "codex_spark",
        label: "Codex 5.3 Spark",
        limits: [
          expect.objectContaining({ label: "Daily usage limit" }),
          expect.objectContaining({
            label: "Monthly usage limit",
            remainingPercent: 49,
          }),
        ],
      },
    ]);
  });
});
