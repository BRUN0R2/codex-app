import type {
  AccountRateLimitsResponse,
  RateLimitSnapshot,
  RateLimitUpdateSnapshot,
} from "../contracts/types";

export const GENERAL_RATE_LIMIT_ID = "codex";

export function generalRateLimitSnapshot(
  response: AccountRateLimitsResponse | null | undefined,
): RateLimitSnapshot | null {
  return response?.generalRateLimit ?? null;
}

/** Merges a sparse provider update without clearing metadata absent from the stream event. */
export function mergeRateLimitUpdate(
  current: AccountRateLimitsResponse,
  update: RateLimitUpdateSnapshot,
): AccountRateLimitsResponse {
  const currentBucket =
    update.limitId === GENERAL_RATE_LIMIT_ID
      ? current.generalRateLimit
      : current.additionalRateLimitsByLimitId[update.limitId];
  const mergedBucket = mergeSnapshot(currentBucket, update);

  return update.limitId === GENERAL_RATE_LIMIT_ID
    ? { ...current, generalRateLimit: mergedBucket }
    : {
        ...current,
        additionalRateLimitsByLimitId: {
          ...current.additionalRateLimitsByLimitId,
          [update.limitId]: mergedBucket,
        },
      };
}

function mergeSnapshot(
  current: RateLimitSnapshot | undefined,
  update: RateLimitUpdateSnapshot,
): RateLimitUpdateSnapshot {
  return {
    limitId: update.limitId,
    limitName: update.limitName ?? current?.limitName ?? null,
    primary: update.primary ?? current?.primary ?? null,
    secondary: update.secondary ?? current?.secondary ?? null,
    credits: update.credits ?? current?.credits ?? null,
    individualLimit: update.individualLimit ?? current?.individualLimit ?? null,
    spendControlReached: update.spendControlReached ?? current?.spendControlReached ?? null,
    planType: update.planType ?? current?.planType ?? null,
    rateLimitReachedType: update.rateLimitReachedType ?? current?.rateLimitReachedType ?? null,
  };
}
