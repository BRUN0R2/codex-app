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
    rateLimits,
    rateLimitsByLimitId: { codex: rateLimits },
    planPrice: null,
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

  it("uses validated thread content with an explicit fallback", () => {
    expect(
      notificationTaskLabel("thread-1", [{ id: "thread-1", name: " Named ", preview: "" }], "Task"),
    ).toBe("Named");
    expect(notificationTaskLabel("missing", [], "Task")).toBe("Task");
  });
});
