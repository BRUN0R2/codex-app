import {
  TRANSIENT_NOTIFICATION_MAXIMUM_DURATION_SECONDS,
  TRANSIENT_NOTIFICATION_MINIMUM_DURATION_SECONDS,
} from "../notificationPolicy";
import type {
  AppConfig,
  ApplicationPreferences,
  ConfigReadResponse,
  ConfigUpdate,
  ConfigUpdateResponse,
  DesktopPreferences,
  PermissionProfile,
} from "../types";
import {
  APPROVAL_POLICIES,
  DIFF_DISPLAYS,
  MODEL_CONTEXT_WINDOW_PREFERENCES,
  MODEL_VERBOSITIES,
  MOTION_PREFERENCES,
  PERSONALITIES,
  REASONING_EFFORTS,
  SANDBOX_MODES,
  WEB_SEARCH_MODES,
} from "./constants";
import { decodeModelContextWindowPreferences } from "./models";
import {
  booleanValue,
  ContractError,
  exactRecord,
  field,
  identifier,
  integer,
  literal,
  nullableText,
  record,
  text,
  UI_FONT_SIZE_MAXIMUM,
  UI_FONT_SIZE_MINIMUM,
} from "./primitives";

export function decodeApplicationPreferences(value: unknown): ApplicationPreferences {
  const object = exactRecord(value, "$", [
    "closeToTray",
    "notifications",
    "schemaVersion",
    "startMinimized",
    "startWithWindows",
  ]);
  const preferences: ApplicationPreferences = {
    schemaVersion: literal(object.schemaVersion, "$.schemaVersion", [2] as const),
    startWithWindows: booleanValue(object.startWithWindows, "$.startWithWindows"),
    startMinimized: booleanValue(object.startMinimized, "$.startMinimized"),
    closeToTray: booleanValue(object.closeToTray, "$.closeToTray"),
    notifications: decodeNotificationPreferences(object.notifications, "$.notifications"),
  };
  if (preferences.startMinimized && !preferences.startWithWindows) {
    throw new ContractError(
      "$.startMinimized",
      "starting minimized requires Windows startup to be enabled",
    );
  }
  return preferences;
}

export function decodeNotificationPreferences(
  value: unknown,
  path: string,
): ApplicationPreferences["notifications"] {
  const object = exactRecord(value, path, [
    "enabled",
    "events",
    "transientDurationSeconds",
    "transientPosition",
  ]);
  const events = exactRecord(object.events, `${path}.events`, [
    "approvalRequired",
    "lunaReserveAvailable",
    "taskCompleted",
    "taskFailed",
    "usageLimitReset",
    "usageResetAvailable",
  ]);
  return {
    enabled: booleanValue(object.enabled, `${path}.enabled`),
    transientPosition: literal(object.transientPosition, `${path}.transientPosition`, [
      "bottomLeft",
      "bottomRight",
      "topLeft",
      "topRight",
    ] as const),
    transientDurationSeconds: integer(
      object.transientDurationSeconds,
      `${path}.transientDurationSeconds`,
      TRANSIENT_NOTIFICATION_MINIMUM_DURATION_SECONDS,
      TRANSIENT_NOTIFICATION_MAXIMUM_DURATION_SECONDS,
    ),
    events: {
      approvalRequired: decodeNotificationRule(
        events.approvalRequired,
        `${path}.events.approvalRequired`,
      ),
      taskCompleted: decodeNotificationRule(events.taskCompleted, `${path}.events.taskCompleted`),
      taskFailed: decodeNotificationRule(events.taskFailed, `${path}.events.taskFailed`),
      usageLimitReset: decodeNotificationRule(
        events.usageLimitReset,
        `${path}.events.usageLimitReset`,
      ),
      usageResetAvailable: decodeNotificationRule(
        events.usageResetAvailable,
        `${path}.events.usageResetAvailable`,
      ),
      lunaReserveAvailable: decodeNotificationRule(
        events.lunaReserveAvailable,
        `${path}.events.lunaReserveAvailable`,
      ),
    },
  };
}

export function decodeNotificationRule(
  value: unknown,
  path: string,
): ApplicationPreferences["notifications"]["events"]["approvalRequired"] {
  const object = exactRecord(value, path, ["enabled", "priority"]);
  return {
    enabled: booleanValue(object.enabled, `${path}.enabled`),
    priority: booleanValue(object.priority, `${path}.priority`),
  };
}

export function decodeConfigReadResponse(value: unknown): ConfigReadResponse {
  const object = exactRecord(value, "$", ["config", "version"]);
  return {
    config: decodeAppConfig(object.config, "$.config"),
    version: integer(object.version, "$.version", 1, Number.MAX_SAFE_INTEGER),
  };
}

export function decodeConfigUpdateResponse(value: unknown): ConfigUpdateResponse {
  return decodeConfigReadResponse(value);
}

export function decodeConfigUpdate(value: unknown): ConfigUpdate {
  const object = record(value, "$");
  const type = text(field(object, "type"), "$.type", 64);
  switch (type) {
    case "desktop": {
      const update = exactRecord(object, "$", ["type", "value"]);
      return { type, value: decodeDesktopPreferences(update.value, "$.value") };
    }
    case "developerInstructions": {
      const update = exactRecord(object, "$", ["type", "value"]);
      return { type, value: nullableText(update.value, "$.value") };
    }
    case "modelContextWindow": {
      const update = exactRecord(object, "$", ["model", "type", "value"]);
      return {
        type,
        model: identifier(update.model, "$.model"),
        value: literal(update.value, "$.value", MODEL_CONTEXT_WINDOW_PREFERENCES),
      };
    }
    case "modelDefaults": {
      const update = exactRecord(object, "$", ["type", "value"]);
      const defaults = exactRecord(update.value, "$.value", [
        "model",
        "reasoningEffort",
        "serviceTier",
      ]);
      return {
        type,
        value: {
          model: nullableText(defaults.model, "$.value.model"),
          reasoningEffort:
            defaults.reasoningEffort === null
              ? null
              : literal(defaults.reasoningEffort, "$.value.reasoningEffort", REASONING_EFFORTS),
          serviceTier: nullableText(defaults.serviceTier, "$.value.serviceTier"),
        },
      };
    }
    case "modelVerbosity": {
      const update = exactRecord(object, "$", ["type", "value"]);
      return {
        type,
        value: update.value === null ? null : literal(update.value, "$.value", MODEL_VERBOSITIES),
      };
    }
    case "permissionProfile": {
      const update = exactRecord(object, "$", ["type", "value"]);
      return { type, value: decodePermissionProfile(update.value, "$.value") };
    }
    case "personality": {
      const update = exactRecord(object, "$", ["type", "value"]);
      return { type, value: literal(update.value, "$.value", PERSONALITIES) };
    }
    case "webSearch": {
      const update = exactRecord(object, "$", ["type", "value"]);
      return { type, value: literal(update.value, "$.value", WEB_SEARCH_MODES) };
    }
    default:
      throw new ContractError("$.type", `unsupported config update ${JSON.stringify(type)}`);
  }
}

export function decodePermissionProfile(value: unknown, path: string): PermissionProfile {
  const object = exactRecord(value, path, ["approvals", "sandbox"]);
  const profile = {
    sandbox: literal(object.sandbox, `${path}.sandbox`, SANDBOX_MODES),
    approvals: literal(object.approvals, `${path}.approvals`, APPROVAL_POLICIES),
  } satisfies PermissionProfile;
  const supported =
    (profile.sandbox === "read-only" && profile.approvals === "untrusted") ||
    (profile.sandbox === "workspace-write" && profile.approvals === "on-request") ||
    (profile.sandbox === "danger-full-access" && profile.approvals === "never");
  if (!supported) {
    throw new ContractError(path, "contains an unsupported permission pairing");
  }
  return profile;
}

export function decodeAppConfig(value: unknown, path: string): AppConfig {
  const object = exactRecord(value, path, [
    "desktop",
    "developerInstructions",
    "model",
    "modelContextWindowPreferences",
    "modelReasoningEffort",
    "modelVerbosity",
    "permissionProfile",
    "personality",
    "serviceTier",
    "webSearch",
  ]);
  return {
    model: nullableText(object.model, `${path}.model`),
    modelContextWindowPreferences: decodeModelContextWindowPreferences(
      object.modelContextWindowPreferences,
      `${path}.modelContextWindowPreferences`,
    ),
    modelReasoningEffort:
      object.modelReasoningEffort === null
        ? null
        : literal(object.modelReasoningEffort, `${path}.modelReasoningEffort`, REASONING_EFFORTS),
    serviceTier: nullableText(object.serviceTier, `${path}.serviceTier`),
    permissionProfile: decodePermissionProfile(
      object.permissionProfile,
      `${path}.permissionProfile`,
    ),
    webSearch: literal(object.webSearch, `${path}.webSearch`, WEB_SEARCH_MODES),
    modelVerbosity:
      object.modelVerbosity === null
        ? null
        : literal(object.modelVerbosity, `${path}.modelVerbosity`, MODEL_VERBOSITIES),
    personality: literal(object.personality, `${path}.personality`, PERSONALITIES),
    developerInstructions: nullableText(
      object.developerInstructions,
      `${path}.developerInstructions`,
    ),
    desktop: decodeDesktopPreferences(object.desktop, `${path}.desktop`),
  };
}

export function decodeDesktopPreferences(value: unknown, path: string): DesktopPreferences {
  const object = exactRecord(value, path, ["diffDisplay", "motion", "pointerCursor", "uiFontSize"]);
  return {
    uiFontSize: integer(
      object.uiFontSize,
      `${path}.uiFontSize`,
      UI_FONT_SIZE_MINIMUM,
      UI_FONT_SIZE_MAXIMUM,
    ),
    motion: literal(object.motion, `${path}.motion`, MOTION_PREFERENCES),
    pointerCursor: booleanValue(object.pointerCursor, `${path}.pointerCursor`),
    diffDisplay: literal(object.diffDisplay, `${path}.diffDisplay`, DIFF_DISPLAYS),
  };
}
