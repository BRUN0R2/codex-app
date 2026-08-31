import type { AppConfig, ConfigReadResponse, ConfigUpdate } from "../contracts/types";

export function updatePreviewConfig(
  current: ConfigReadResponse,
  expectedVersion: number,
  update: ConfigUpdate,
): ConfigReadResponse {
  if (current.version !== expectedVersion) {
    throw new Error(
      `The preview configuration changed from version ${expectedVersion} to ${current.version}.`,
    );
  }
  return {
    config: applyPreviewConfigUpdate(current.config, update),
    version: current.version + 1,
  };
}

function applyPreviewConfigUpdate(config: AppConfig, update: ConfigUpdate): AppConfig {
  switch (update.type) {
    case "desktop":
      return { ...config, desktop: update.value };
    case "developerInstructions":
      return { ...config, developerInstructions: update.value };
    case "modelContextWindow": {
      const preferences = { ...config.modelContextWindowPreferences };
      if (update.value === "default") {
        delete preferences[update.model];
      } else {
        preferences[update.model] = update.value;
      }
      return { ...config, modelContextWindowPreferences: preferences };
    }
    case "modelDefaults":
      return {
        ...config,
        model: update.value.model,
        modelReasoningEffort: update.value.reasoningEffort,
        serviceTier: update.value.serviceTier,
      };
    case "modelVerbosity":
      return { ...config, modelVerbosity: update.value };
    case "permissionProfile":
      return { ...config, permissionProfile: update.value };
    case "personality":
      return { ...config, personality: update.value };
    case "webSearch":
      return { ...config, webSearch: update.value };
  }
}
