import type { ContextUsageItem } from "../contracts/types";

const COMPACT_TOKEN_THRESHOLD = 100_000;
const THOUSAND_DIVISOR = 1_000;

export interface ContextWindowMetrics {
  readonly usableContextWindow: number;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly usedTokens: number;
  readonly cachedInputTokens: number;
  readonly cachedPercent: number;
}

export function calculateContextWindowMetrics(
  usage: ContextUsageItem | null,
): ContextWindowMetrics | null {
  const usableContextWindow = usage?.contextWindow?.usableTokens ?? null;
  const totalTokens = usage?.usage.totalTokens ?? null;
  if (
    usableContextWindow === null ||
    usableContextWindow <= 0 ||
    totalTokens === null ||
    totalTokens < 0
  ) {
    return null;
  }

  const usedTokens = Math.min(totalTokens, usableContextWindow);
  const usedPercent = Math.max(0, Math.min((usedTokens / usableContextWindow) * 100, 100));
  if (!Number.isFinite(usedPercent)) {
    return null;
  }

  const cachedInputTokens = Math.max(0, usage?.usage.cachedInputTokens ?? 0);
  const inputTokens = Math.max(0, usage?.usage.inputTokens ?? 0);
  const cachedPercent =
    inputTokens === 0 ? 0 : Math.max(0, Math.min((cachedInputTokens / inputTokens) * 100, 100));
  if (!Number.isFinite(cachedPercent)) {
    return null;
  }

  const roundedUsedPercent = Math.round(usedPercent);
  return {
    usableContextWindow,
    usedPercent,
    remainingPercent: Math.max(0, 100 - roundedUsedPercent),
    usedTokens,
    cachedInputTokens,
    cachedPercent,
  };
}

export function formatContextTokens(tokens: number): string {
  const formatted = new Intl.NumberFormat("pt-BR", {
    maximumFractionDigits:
      tokens < COMPACT_TOKEN_THRESHOLD && tokens % THOUSAND_DIVISOR !== 0 ? 1 : 0,
  }).format(tokens / THOUSAND_DIVISOR);
  return `${formatted}k`;
}
