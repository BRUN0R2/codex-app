import type { TranslationMessages } from "../i18n/messages";
import type { AppController } from "../state/appController";

export type SettingsDialogController = Pick<
  AppController,
  | "account"
  | "accountProfile"
  | "accountProfileError"
  | "accountProfileLoading"
  | "applicationPreferences"
  | "applicationPreferencesError"
  | "applicationPreferencesLoaded"
  | "applicationPreferencesSaving"
  | "archivedThreads"
  | "archivedThreadsLoaded"
  | "archivedThreadsLoading"
  | "archivedThreadsNextCursor"
  | "config"
  | "deleteThread"
  | "diagnostics"
  | "engine"
  | "loadMoreArchivedThreads"
  | "logout"
  | "previewNotification"
  | "rateLimits"
  | "rateLimitsError"
  | "rateLimitsLoading"
  | "refreshRateLimits"
  | "refreshRateLimitsIfStale"
  | "usageResets"
  | "usageResetsError"
  | "usageResetsLoading"
  | "usageResetRedeemingId"
  | "refreshUsageResets"
  | "redeemUsageReset"
  | "autoTopUpSettings"
  | "autoTopUpError"
  | "autoTopUpLoading"
  | "refreshAutoTopUpSettings"
  | "refreshAccountProfile"
  | "enableAutoTopUp"
  | "updateAutoTopUp"
  | "disableAutoTopUp"
  | "reportError"
  | "unarchiveThread"
  | "saveSetting"
  | "updateApplicationPreferences"
>;

export type SettingsPage =
  | "archived"
  | "diagnostics"
  | "general"
  | "notifications"
  | "personalization"
  | "profile"
  | "shortcuts"
  | "usage";

export type SettingsMessages = TranslationMessages["settings"];

export const AUTO_TOP_UP_DEFAULT_RECHARGE_TARGET: string = "250";
export const AUTO_TOP_UP_DEFAULT_RECHARGE_THRESHOLD: string = "125";
export const DEVELOPER_INSTRUCTIONS_MAXIMUM_BYTES: number = 262_144;
export const OUTPUT_DETAIL_MENU_ESTIMATED_HEIGHT_PX: number = 224;
export const SETTINGS_SAVE_CONFIRMATION_DURATION_MS: number = 1_800;
