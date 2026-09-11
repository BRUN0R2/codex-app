import { TRANSIENT_NOTIFICATION_DEFAULT_DURATION_SECONDS } from "../contracts/notificationPolicy";
import type {
  ApplicationPreferences,
  NotificationEventPreferences,
  NotificationPreferences,
} from "../contracts/types";

export const DEFAULT_APPLICATION_PREFERENCES = {
  schemaVersion: 2,
  startWithWindows: false,
  startMinimized: false,
  closeToTray: false,
  notifications: {
    enabled: true,
    transientPosition: "bottomRight",
    transientDurationSeconds: TRANSIENT_NOTIFICATION_DEFAULT_DURATION_SECONDS,
    events: {
      approvalRequired: { enabled: true, priority: true },
      taskCompleted: { enabled: true, priority: false },
      taskFailed: { enabled: true, priority: true },
      usageLimitReset: { enabled: true, priority: false },
      usageResetAvailable: { enabled: true, priority: true },
      lunaReserveAvailable: { enabled: true, priority: true },
    },
  },
} as const satisfies ApplicationPreferences;

export type NotificationEventPreferencePatch = Partial<NotificationEventPreferences>;

export interface NotificationPreferencesPatch
  extends Partial<Omit<NotificationPreferences, "events">> {
  readonly events?: NotificationEventPreferencePatch;
}

export interface ApplicationPreferencesPatch
  extends Partial<Omit<ApplicationPreferences, "notifications" | "schemaVersion">> {
  readonly notifications?: NotificationPreferencesPatch;
}

export function mergeApplicationPreferences(
  current: ApplicationPreferences,
  patch: ApplicationPreferencesPatch,
): ApplicationPreferences {
  const merged: ApplicationPreferences = {
    ...current,
    ...patch,
    notifications:
      patch.notifications === undefined
        ? current.notifications
        : {
            ...current.notifications,
            ...patch.notifications,
            events:
              patch.notifications.events === undefined
                ? current.notifications.events
                : { ...current.notifications.events, ...patch.notifications.events },
          },
  };
  return merged.startWithWindows ? merged : { ...merged, startMinimized: false };
}
