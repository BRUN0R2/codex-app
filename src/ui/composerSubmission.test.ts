import { describe, expect, it } from "vitest";

import { canSubmitComposerMessage, shouldWarmComposerModelCatalog } from "./composerSubmission";

describe("composer submission", () => {
  it("waits for model selection before starting a new turn", () => {
    expect(
      canSubmitComposerMessage({
        hasDraft: true,
        modelSelectionRequired: true,
        modelSelectionReady: false,
        sending: false,
      }),
    ).toBe(false);
    expect(
      canSubmitComposerMessage({
        hasDraft: true,
        modelSelectionRequired: true,
        modelSelectionReady: true,
        sending: false,
      }),
    ).toBe(true);
  });

  it("keeps steering an active turn independent from catalog loading", () => {
    expect(
      canSubmitComposerMessage({
        hasDraft: true,
        modelSelectionRequired: false,
        modelSelectionReady: false,
        sending: false,
      }),
    ).toBe(true);
  });

  it("waits for model selection when an active turn queues the message", () => {
    expect(
      canSubmitComposerMessage({
        hasDraft: true,
        modelSelectionRequired: true,
        modelSelectionReady: false,
        sending: false,
      }),
    ).toBe(false);
  });

  it("rejects empty or already-submitting drafts", () => {
    expect(
      canSubmitComposerMessage({
        hasDraft: false,
        modelSelectionRequired: true,
        modelSelectionReady: true,
        sending: false,
      }),
    ).toBe(false);
    expect(
      canSubmitComposerMessage({
        hasDraft: true,
        modelSelectionRequired: true,
        modelSelectionReady: true,
        sending: true,
      }),
    ).toBe(false);
  });

  it("warms the authoritative model catalog as soon as drafting can hide its latency", () => {
    expect(shouldWarmComposerModelCatalog({ engineReady: true, hasDraft: true })).toBe(true);
    expect(shouldWarmComposerModelCatalog({ engineReady: false, hasDraft: true })).toBe(false);
    expect(shouldWarmComposerModelCatalog({ engineReady: true, hasDraft: false })).toBe(false);
  });
});
