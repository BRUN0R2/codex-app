import type { ContextUsageItem } from "../contracts/types";

export interface ContextWindowMetrics {
  readonly contextWindow: number;
  readonly percent: number;
  readonly remainingPercent: number;
  readonly usedTokens: number;
}

export function calculateContextWindowMetrics(
  usage: ContextUsageItem | null,
): ContextWindowMetrics | null {
  const contextWindow = usage?.contextWindow?.tokens ?? null;
  const totalTokens = usage?.usage.totalTokens ?? null;
  if (contextWindow === null || contextWindow <= 0 || totalTokens === null || totalTokens < 0) {
    return null;
  }

  const usedTokens = Math.min(totalTokens, contextWindow);
  const percent = Math.max(0, Math.min((usedTokens / contextWindow) * 100, 100));
  if (!Number.isFinite(percent)) {
    return null;
  }

  const roundedPercent = Math.round(percent);
  return {
    contextWindow,
    percent,
    remainingPercent: Math.max(0, 100 - roundedPercent),
    usedTokens,
  };
}

export function formatContextTokens(tokens: number): string {
  return new Intl.NumberFormat("pt-BR", {
    maximumFractionDigits: tokens < 100_000 ? 1 : 0,
  }).format(tokens / 1_000);
}
