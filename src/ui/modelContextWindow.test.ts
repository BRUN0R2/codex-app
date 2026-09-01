import { describe, expect, it } from "vitest";

import type { CodexModel, ModelContextWindow } from "../contracts/types";
import {
  formatModelContextTokens,
  modelContextWindowOptions,
  modelContextWindowPreference,
  resolveModelContextWindow,
} from "./modelContextWindow";

const MODEL_CONTEXT_WINDOW = {
  tokens: 272_000,
  usableTokens: 258_400,
  usablePercent: 95,
  maximumTokens: 872_000,
} as const satisfies ModelContextWindow;

const MODEL: CodexModel = {
  id: "gpt-5.6-sol",
  model: "gpt-5.6-sol",
  displayName: "GPT-5.6 Sol",
  description: null,
  hidden: false,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: null,
  serviceTiers: [],
  defaultServiceTier: null,
  contextWindow: MODEL_CONTEXT_WINDOW,
  unsupportedRuntimeCapabilities: [],
  unsupportedReasoningEfforts: [],
  isDefault: true,
};

describe("model context-window preferences", () => {
  it("uses the live catalog maximum without hard-coding a model name", () => {
    expect(modelContextWindowOptions(MODEL)).toEqual([
      { preference: "default", tokens: 272_000 },
      { preference: "maximum", tokens: 872_000 },
    ]);
    expect(resolveModelContextWindow(MODEL, "maximum")).toEqual({
      ...MODEL.contextWindow,
      tokens: 872_000,
      usableTokens: 828_400,
    });
  });

  it("falls back to the default preference and formats large windows", () => {
    expect(modelContextWindowPreference({}, MODEL.id)).toBe("default");
    expect(formatModelContextTokens(272_000, "pt-BR")).toBe("272\u00a0mil");
    expect(formatModelContextTokens(1_050_000, "pt-BR")).toBe("1,05\u00a0mi");
    expect(formatModelContextTokens(272_000, "en")).toBe("272K");
    expect(formatModelContextTokens(1_050_000, "en")).toBe("1.05M");
  });

  it("omits context controls when the catalog has no larger window", () => {
    expect(
      modelContextWindowOptions({
        ...MODEL,
        contextWindow: {
          ...MODEL_CONTEXT_WINDOW,
          maximumTokens: MODEL_CONTEXT_WINDOW.tokens,
        },
      }),
    ).toEqual([]);
  });
});
