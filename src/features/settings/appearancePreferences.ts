import { isJsonObject, type ConfigReadResponse } from "../../shared/codex/types";

export const APPEARANCE_SETTING_PATHS = {
  diffDisplay: "desktop.codexDesktopNext.appearance.diffDisplay",
  motion: "desktop.codexDesktopNext.appearance.motion",
  pointerCursor: "desktop.codexDesktopNext.appearance.pointerCursor",
  uiFontSize: "desktop.codexDesktopNext.appearance.uiFontSize",
} as const;

export const UI_FONT_SIZES = [13, 14, 15, 16, 17] as const;

export type DiffDisplayPreference = "color" | "markers";
export type MotionPreference = "full" | "reduce" | "system";
export type UiFontSize = (typeof UI_FONT_SIZES)[number];

export interface AppearancePreferences {
  diffDisplay: DiffDisplayPreference;
  motion: MotionPreference;
  pointerCursor: boolean;
  uiFontSize: UiFontSize;
}

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  diffDisplay: "color",
  motion: "system",
  pointerCursor: true,
  uiFontSize: 15,
};

export function readAppearancePreferences(
  snapshot: ConfigReadResponse | null,
): AppearancePreferences {
  const desktop = snapshot?.config.desktop;
  if (!isJsonObject(desktop)) {
    return DEFAULT_APPEARANCE_PREFERENCES;
  }
  const application = desktop.codexDesktopNext;
  if (!isJsonObject(application) || !isJsonObject(application.appearance)) {
    return DEFAULT_APPEARANCE_PREFERENCES;
  }

  const appearance = application.appearance;
  return {
    diffDisplay: readEnum(appearance.diffDisplay, ["color", "markers"])
      ?? DEFAULT_APPEARANCE_PREFERENCES.diffDisplay,
    motion: readEnum(appearance.motion, ["full", "reduce", "system"])
      ?? DEFAULT_APPEARANCE_PREFERENCES.motion,
    pointerCursor:
      typeof appearance.pointerCursor === "boolean"
        ? appearance.pointerCursor
        : DEFAULT_APPEARANCE_PREFERENCES.pointerCursor,
    uiFontSize: isUiFontSize(appearance.uiFontSize)
      ? appearance.uiFontSize
      : DEFAULT_APPEARANCE_PREFERENCES.uiFontSize,
  };
}

export function applyAppearancePreferences(preferences: AppearancePreferences) {
  const root = document.documentElement;
  root.style.setProperty("--ui-font-size", `${preferences.uiFontSize}px`);
  root.dataset.diffDisplay = preferences.diffDisplay;
  root.dataset.motion = preferences.motion;
  root.dataset.pointerCursor = String(preferences.pointerCursor);
}

export function parseUiFontSize(value: string): UiFontSize | null {
  const parsed = Number(value);
  return isUiFontSize(parsed) ? parsed : null;
}

function isUiFontSize(value: unknown): value is UiFontSize {
  return (
    typeof value === "number"
    && UI_FONT_SIZES.some((candidate) => candidate === value)
  );
}

function readEnum<const Value extends string>(
  value: unknown,
  supported: readonly Value[],
): Value | null {
  return typeof value === "string"
    ? supported.find((candidate) => candidate === value) ?? null
    : null;
}
