import type { ContextUsageItem, ModelContextWindow } from "../contracts/types";

export interface ContextWindowMetrics {
  readonly contextWindow: number;
  readonly percent: number;
  readonly remainingPercent: number;
  readonly usedTokens: number;
}

export function calculateContextWindowMetrics(
  usage: ContextUsageItem | null,
  contextWindow: ModelContextWindow | null = null,
): ContextWindowMetrics | null {
  const window = (contextWindow ?? usage?.contextWindow)?.tokens ?? null;
  const totalTokens = usage?.usage.totalTokens ?? null;
  if (window === null || window <= 0 || totalTokens === null || totalTokens < 0) {
    return null;
  }

  const usedTokens = Math.min(totalTokens, window);
  const percent = Math.max(0, Math.min((usedTokens / window) * 100, 100));
  if (!Number.isFinite(percent)) {
    return null;
  }

  const roundedPercent = Math.round(percent);
  return {
    contextWindow: window,
    percent,
    remainingPercent: Math.max(0, 100 - roundedPercent),
    usedTokens,
  };
}

export function formatContextTokens(tokens: number): string {
  const formatted = new Intl.NumberFormat("pt-BR", {
    maximumFractionDigits: tokens < 100_000 && tokens % 1000 !== 0 ? 1 : 0,
  }).format(tokens / 1_000);
  return `${formatted}k`;
}
