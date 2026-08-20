import type { ApplicationPreferences } from "../contracts/types";

export const DEFAULT_APPLICATION_PREFERENCES = {
  schemaVersion: 1,
  startWithWindows: false,
  startMinimized: false,
  closeToTray: false,
} as const satisfies ApplicationPreferences;

export function mergeApplicationPreferences(
  current: ApplicationPreferences,
  patch: Partial<ApplicationPreferences>,
): ApplicationPreferences {
  const merged = { ...current, ...patch };
  return merged.startWithWindows ? merged : { ...merged, startMinimized: false };
}
