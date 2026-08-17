import type { DesktopPreferences } from "../contracts/types";

export function applyDesktopAppearance(preferences: DesktopPreferences): void {
  document.documentElement.style.setProperty("--ui-font-size", `${preferences.uiFontSize}px`);
  document.documentElement.setAttribute("data-motion", preferences.motion);
  document.documentElement.setAttribute(
    "data-pointer",
    preferences.pointerCursor ? "pointer" : "default",
  );
  document.documentElement.setAttribute("data-diff", preferences.diffDisplay);
}
