import { describe, expect, it } from "vitest";

import type { CodexModel } from "../contracts/types";
import {
  formatModelContextTokens,
  modelContextWindowPreference,
  modelSupportsMaximumContext,
  resolveModelContextWindow,
} from "./modelContextWindow";

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
  contextWindow: {
    tokens: 272_000,
    usableTokens: 258_400,
    usablePercent: 95,
    maximumTokens: 872_000,
  },
  isDefault: true,
};

describe("model context-window preferences", () => {
  it("uses the live catalog maximum without hard-coding a model name", () => {
    expect(modelSupportsMaximumContext(MODEL)).toBe(true);
    expect(resolveModelContextWindow(MODEL, "maximum")).toEqual({
      ...MODEL.contextWindow,
      tokens: 872_000,
      usableTokens: 828_400,
    });
  });

  it("falls back to the default preference and formats large windows", () => {
    expect(modelContextWindowPreference({}, MODEL.id)).toBe("default");
    expect(formatModelContextTokens(272_000)).toBe("272 mil");
    expect(formatModelContextTokens(1_050_000)).toBe("1,05 mi");
  });
});
