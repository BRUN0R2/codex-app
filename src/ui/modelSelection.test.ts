import { describe, expect, it } from "vitest";

import type { CodexModel, ConfigUpdate } from "../contracts/types";
import {
  persistModelDefaults,
  reasoningEffortIsRuntimeCompatible,
  resolveRuntimeCompatibleModelSelection,
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

  it("keeps Code Mode models selectable while multi-agent execution is unavailable", () => {
    const codeMode = modelFixture({
      id: "code-mode-only",
      model: "code-mode-only",
      unsupportedRuntimeCapabilities: ["multiAgent"],
      unsupportedReasoningEfforts: ["ultra"],
    });
    const fallback = modelFixture({ id: "direct", isDefault: true, model: "direct" });

    expect(selectRuntimeCompatibleModel([codeMode, fallback], codeMode.id, fallback.id)).toBe(
      codeMode,
    );
    expect(selectRuntimeCompatibleReasoningEffort(codeMode, "ultra")).toBe("max");
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

  it("persists model, reasoning, and speed as one backend-owned preference", async () => {
    const model = modelFixture({
      id: "gpt-selected",
      model: "gpt-selected",
      serviceTiers: [{ id: "priority", name: "Priority", description: "Menor latência" }],
    });
    const updates: ConfigUpdate[] = [];
    const selection = resolveRuntimeCompatibleModelSelection(
      [model],
      model.id,
      "ultra",
      "priority",
    );

    await expect(
      persistModelDefaults(async (update) => {
        updates.push(update);
        return true;
      }, selection),
    ).resolves.toBe(true);
    expect(updates).toEqual([
      {
        type: "modelDefaults",
        value: {
          model: "gpt-selected",
          reasoningEffort: "ultra",
          serviceTier: "priority",
        },
      },
    ]);
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
