import { describe, expect, it } from "vitest";

import type { ContextUsageItem } from "../contracts/types";
import { calculateContextWindowMetrics, formatContextTokens } from "./contextWindowMetrics";

describe("context window metrics", () => {
  it("stays hidden until the provider reports usage and a model window", () => {
    expect(calculateContextWindowMetrics(null)).toBeNull();
    expect(calculateContextWindowMetrics(usage(10, null))).toBeNull();
  });

  it("uses the full model context window like the official desktop", () => {
    expect(calculateContextWindowMetrics(usage(174_000, 272_000, 258_400))).toEqual({
      contextWindow: 272_000,
      percent: (174_000 / 272_000) * 100,
      remainingPercent: 36,
      usedTokens: 174_000,
    });
  });

  it("clamps over-reported usage to a complete donut", () => {
    expect(calculateContextWindowMetrics(usage(300_000, 272_000))).toEqual({
      contextWindow: 272_000,
      percent: 100,
      remainingPercent: 0,
      usedTokens: 272_000,
    });
  });

  it("keeps useful precision for small token totals without cluttering the model limit", () => {
    expect(formatContextTokens(8_500)).toBe("8,5");
    expect(formatContextTokens(258_400)).toBe("258");
  });
});

function usage(
  totalTokens: number,
  tokens: number | null,
  usableTokens = tokens ?? 0,
): ContextUsageItem {
  return {
    type: "contextUsage",
    id: "context-test",
    model: "test-model",
    usage: {
      inputTokens: totalTokens,
      cachedInputTokens: 0,
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
