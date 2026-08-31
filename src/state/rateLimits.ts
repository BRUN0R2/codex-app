import type {
  AccountRateLimitsResponse,
  RateLimitSnapshot,
  RateLimitUpdateSnapshot,
} from "../contracts/types";

/** Merges a sparse provider update without clearing metadata absent from the stream event. */
export function mergeRateLimitUpdate(
  current: AccountRateLimitsResponse,
  update: RateLimitUpdateSnapshot,
): AccountRateLimitsResponse {
  const currentBucket = current.rateLimitsByLimitId[update.limitId];
  const mergedBucket = mergeSnapshot(currentBucket, update);
  const updatesPrimary =
    update.limitId === "codex" || current.rateLimits.limitId === update.limitId;

  return {
    ...current,
    rateLimits: updatesPrimary ? mergeSnapshot(current.rateLimits, update) : current.rateLimits,
    rateLimitsByLimitId: {
      ...current.rateLimitsByLimitId,
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
