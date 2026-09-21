import { describe, expect, it } from "vitest";

import type { ContextUsageItem } from "../contracts/types";
import { calculateContextWindowMetrics, formatContextTokens } from "./contextWindowMetrics";

describe("context window metrics", () => {
  it("stays hidden until the provider reports usage and a model window", () => {
    expect(calculateContextWindowMetrics(null)).toBeNull();
    expect(calculateContextWindowMetrics(usage(10, null))).toBeNull();
  });

  it("uses the usable window attached to the measured model execution", () => {
    expect(calculateContextWindowMetrics(usage(174_000, 272_000, 258_400))).toEqual({
      usableContextWindow: 258_400,
      usedPercent: (174_000 / 258_400) * 100,
      remainingPercent: 33,
      usedTokens: 174_000,
      cachedInputTokens: 0,
      cachedPercent: 0,
    });
  });

  it("matches the desktop projection at the automatic compaction threshold", () => {
    expect(calculateContextWindowMetrics(usage(244_800, 272_000, 258_400))).toEqual({
      usableContextWindow: 258_400,
      usedPercent: (244_800 / 258_400) * 100,
      remainingPercent: 5,
      usedTokens: 244_800,
      cachedInputTokens: 0,
      cachedPercent: 0,
    });
  });

  it("clamps over-reported usage to a complete donut", () => {
    expect(calculateContextWindowMetrics(usage(300_000, 272_000, 258_400))).toEqual({
      usableContextWindow: 258_400,
      usedPercent: 100,
      remainingPercent: 0,
      usedTokens: 258_400,
      cachedInputTokens: 0,
      cachedPercent: 0,
    });
  });

  it("computes cache hit rate from provider cached input tokens", () => {
    const metrics = calculateContextWindowMetrics(usage(174_000, 272_000, 258_400, 120_000));
    expect(metrics?.cachedInputTokens).toBe(120_000);
    expect(metrics?.cachedPercent).toBeCloseTo((120_000 / 174_000) * 100, 10);
  });

  it("keeps useful precision for small token totals without cluttering the model limit", () => {
    expect(formatContextTokens(8_500, "en")).toBe("8.5k");
    expect(formatContextTokens(8_500, "pt-BR")).toBe("8,5k");
    expect(formatContextTokens(258_400, "en")).toBe("258k");
    expect(formatContextTokens(258_400, "pt-BR")).toBe("258k");
  });
});

function usage(
  totalTokens: number,
  tokens: number | null,
  usableTokens = tokens ?? 0,
  cachedInputTokens = 0,
): ContextUsageItem {
  return {
    type: "contextUsage",
    id: "context-test",
    model: "test-model",
    usage: {
      inputTokens: totalTokens,
      cachedInputTokens,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens,
    },
    contextWindow:
      tokens === null
        ? null
        : {
            tokens,
            usableTokens,
            usablePercent: 95,
            maximumTokens: null,
          },
  };
}
