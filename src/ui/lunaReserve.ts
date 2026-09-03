import type {
  AccountRateLimitsResponse,
  RateLimitSnapshot,
  RateLimitWindow,
} from "../contracts/types";

export const LUNA_RESERVE_LIMIT_NAME = "gpt-reserve";

export interface LunaReserveUsage {
  readonly remainingPercent: number;
  readonly resetAt: number | null;
  readonly windowDurationMins: number | null;
}

export function presentLunaReserveUsage(
  response: AccountRateLimitsResponse | null | undefined,
): LunaReserveUsage | null {
  if (response === null || response === undefined) {
    return null;
  }

  const snapshot = Object.values(response.rateLimitsByLimitId).find(
    (candidate) => candidate.limitName === LUNA_RESERVE_LIMIT_NAME,
  );
  if (snapshot === undefined) {
    return null;
  }

  const window = selectLunaReserveWindow(snapshot);
  if (window === null) {
    return null;
  }

  return {
    remainingPercent: Math.round(clampPercent(100 - window.usedPercent)),
    resetAt: window.resetsAt,
    windowDurationMins: window.windowDurationMins,
  };
}

function selectLunaReserveWindow(snapshot: RateLimitSnapshot): RateLimitWindow | null {
  return [snapshot.primary, snapshot.secondary]
    .filter((window): window is RateLimitWindow => window !== null)
    .reduce<RateLimitWindow | null>((selected, candidate) => {
      if (selected === null) {
        return candidate;
      }
      return (candidate.windowDurationMins ?? 0) > (selected.windowDurationMins ?? 0)
        ? candidate
        : selected;
    }, null);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
