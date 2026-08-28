import { describe, expect, it } from "vitest";

import type { CodexModel } from "../contracts/types";
import {
  modelIsRuntimeCompatible,
  reasoningEffortIsRuntimeCompatible,
  selectRuntimeCompatibleModel,
  selectRuntimeCompatibleReasoningEffort,
  selectRuntimeCompatibleServiceTier,
} from "./modelSelection";

describe("model selection", () => {
  it("preserves a requested model that the runtime can execute", () => {
    const requested = modelFixture({ id: "requested", model: "requested" });
    const fallback = modelFixture({ id: "fallback", isDefault: true, model: "fallback" });

    expect(selectRuntimeCompatibleModel([requested, fallback], requested.id, fallback.id)).toBe(
      requested,
    );
  });

  it("reconciles a stale Code Mode selection with the compatible default", () => {
    const unavailable = modelFixture({
      id: "code-mode-only",
      model: "code-mode-only",
      unsupportedRuntimeCapabilities: ["codeMode", "multiAgent"],
    });
    const fallback = modelFixture({ id: "direct", isDefault: true, model: "direct" });

    expect(modelIsRuntimeCompatible(unavailable)).toBe(false);
    expect(
      selectRuntimeCompatibleModel([unavailable, fallback], unavailable.id, unavailable.id),
    ).toBe(fallback);
  });

  it("falls back from Ultra without affecting supported reasoning efforts", () => {
    const model = modelFixture({
      defaultReasoningEffort: "max",
      unsupportedReasoningEfforts: ["ultra"],
    });

    expect(reasoningEffortIsRuntimeCompatible(model, "max")).toBe(true);
    expect(reasoningEffortIsRuntimeCompatible(model, "ultra")).toBe(false);
    expect(selectRuntimeCompatibleReasoningEffort(model, "ultra")).toBe("max");
  });

  it("discards a service tier that belongs to the stale model", () => {
    const model = modelFixture({
      defaultServiceTier: "priority",
      serviceTiers: [{ id: "priority", name: "Priority", description: "Menor latência" }],
    });

    expect(selectRuntimeCompatibleServiceTier(model, "unknown")).toBe("priority");
  });
});

function modelFixture(overrides: Partial<CodexModel> = {}): CodexModel {
  return {
    id: "model",
    model: "model",
    displayName: "Model",
    description: null,
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "max", description: "Máximo" },
      { reasoningEffort: "ultra", description: "Ultra" },
    ],
    defaultReasoningEffort: "max",
    serviceTiers: [],
    defaultServiceTier: null,
    contextWindow: null,
    unsupportedRuntimeCapabilities: [],
    unsupportedReasoningEfforts: [],
    isDefault: false,
    ...overrides,
  };
}
