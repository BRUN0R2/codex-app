import type { AccountRateLimitsResponse, RateLimitWindow } from "../contracts/types";

export interface UsageLimitResetTransition {
  readonly limitId: string;
  readonly resetsAt: number;
  readonly availablePercent: number;
}

export function findUsageLimitReset(
  previous: AccountRateLimitsResponse,
  next: AccountRateLimitsResponse,
): UsageLimitResetTransition | null {
  const transitions: UsageLimitResetTransition[] = [];
  for (const [limitId, nextSnapshot] of Object.entries(next.rateLimitsByLimitId)) {
    const previousSnapshot = previous.rateLimitsByLimitId[limitId];
    if (previousSnapshot === undefined) continue;
    collectWindowReset(transitions, limitId, previousSnapshot.primary, nextSnapshot.primary);
    collectWindowReset(transitions, limitId, previousSnapshot.secondary, nextSnapshot.secondary);
  }
  return (
    transitions.toSorted((left, right) => right.availablePercent - left.availablePercent)[0] ?? null
  );
}

function collectWindowReset(
  output: UsageLimitResetTransition[],
  limitId: string,
  previous: RateLimitWindow | null,
  next: RateLimitWindow | null,
): void {
  if (
    previous?.resetsAt === null ||
    previous?.resetsAt === undefined ||
    next?.resetsAt === null ||
    next?.resetsAt === undefined ||
    next.resetsAt <= previous.resetsAt ||
    next.usedPercent >= previous.usedPercent
  ) {
    return;
  }
  output.push({
    limitId,
    resetsAt: next.resetsAt,
    availablePercent: Math.round(Math.max(0, Math.min(100, 100 - next.usedPercent))),
  });
}

export function notificationTaskLabel(
  threadId: string,
  threads: readonly {
    readonly id: string;
    readonly name: string | null;
    readonly preview: string;
  }[],
  fallback: string,
): string {
  const thread = threads.find((candidate) => candidate.id === threadId);
  const name = thread?.name?.trim();
  if (name !== undefined && name.length > 0) return name;
  const preview = thread?.preview.trim();
  return preview !== undefined && preview.length > 0 ? preview : fallback;
}
