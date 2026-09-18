import { describe, expect, it } from "vitest";

import type { AccountRateLimitsResponse, RateLimitSnapshot } from "../contracts/types";
import { findUsageLimitReset, notificationTaskLabel } from "./notificationTransitions";

function snapshot(usedPercent: number, resetsAt: number): RateLimitSnapshot {
  return {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent, windowDurationMins: 300, resetsAt },
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: "pro",
    rateLimitReachedType: null,
  };
}

function response(usedPercent: number, resetsAt: number): AccountRateLimitsResponse {
  const rateLimits = snapshot(usedPercent, resetsAt);
  return {
    generalRateLimit: rateLimits,
    additionalRateLimitsByLimitId: {},
    planPrices: [],
    lunaReserveAvailable: false,
  };
}

describe("notification transitions", () => {
  it("detects a server-confirmed reset from a newer window and reports available capacity", () => {
    expect(findUsageLimitReset(response(100, 1_000), response(0, 2_000))).toEqual({
      limitId: "codex",
      resetsAt: 2_000,
      availablePercent: 100,
    });
  });

  it("does not infer a reset from usage movement without a newer deadline", () => {
    expect(findUsageLimitReset(response(80, 1_000), response(10, 1_000))).toBeNull();
    expect(findUsageLimitReset(response(10, 1_000), response(20, 2_000))).toBeNull();
  });

  it("tracks resets for an additional bucket without relabeling the general bucket", () => {
    const previous = response(50, 1_000);
    const next = response(50, 1_000);
    const reserve = (usedPercent: number, resetsAt: number): RateLimitSnapshot => ({
      ...snapshot(usedPercent, resetsAt),
      limitId: "base_model_inference",
      limitName: "gpt-reserve",
    });

    expect(
      findUsageLimitReset(
        {
          ...previous,
          additionalRateLimitsByLimitId: {
            base_model_inference: reserve(100, 1_000),
          },
        },
        {
          ...next,
          additionalRateLimitsByLimitId: {
            base_model_inference: reserve(0, 2_000),
          },
        },
      ),
    ).toEqual({
      limitId: "base_model_inference",
      resetsAt: 2_000,
      availablePercent: 100,
    });
  });

  it("uses validated thread content with an explicit fallback", () => {
    expect(
      notificationTaskLabel("thread-1", [{ id: "thread-1", name: " Named ", preview: "" }], "Task"),
    ).toBe("Named");
    expect(notificationTaskLabel("missing", [], "Task")).toBe("Task");
  });
});
