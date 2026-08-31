import { describe, expect, it } from "vitest";

import type { ConfigReadResponse } from "../contracts/types";
import { updatePreviewConfig } from "./previewConfig";

const INITIAL_CONFIG = {
  config: {
    model: "gpt-default",
    modelReasoningEffort: "medium",
    serviceTier: null,
    modelContextWindowPreferences: {},
    permissionProfile: { sandbox: "workspace-write", approvals: "on-request" },
    webSearch: "disabled",
    modelVerbosity: null,
    personality: "pragmatic",
    developerInstructions: null,
    desktop: {
      uiFontSize: 15,
      motion: "full",
      pointerCursor: true,
      diffDisplay: "unified",
    },
  },
  version: 4,
} as const satisfies ConfigReadResponse;

describe("browser preview configuration", () => {
  it("applies model defaults atomically and advances the persisted version", () => {
    const updated = updatePreviewConfig(INITIAL_CONFIG, INITIAL_CONFIG.version, {
      type: "modelDefaults",
      value: {
        model: "gpt-selected",
        reasoningEffort: "high",
        serviceTier: "priority",
      },
    });

    expect(updated).toEqual({
      config: {
        ...INITIAL_CONFIG.config,
        model: "gpt-selected",
        modelReasoningEffort: "high",
        serviceTier: "priority",
      },
      version: 5,
    });
    expect(INITIAL_CONFIG.config.model).toBe("gpt-default");
  });

  it("rejects a stale update without changing the current configuration", () => {
    expect(() =>
      updatePreviewConfig(INITIAL_CONFIG, INITIAL_CONFIG.version - 1, {
        type: "modelVerbosity",
        value: "high",
      }),
    ).toThrow("changed from version 3 to 4");
    expect(INITIAL_CONFIG.config.modelVerbosity).toBeNull();
  });
});
