import { For, Show } from "solid-js";

import {
  TRANSIENT_NOTIFICATION_MAXIMUM_DURATION_SECONDS,
  TRANSIENT_NOTIFICATION_MINIMUM_DURATION_SECONDS,
} from "../contracts/notificationPolicy";
import type {
  NotificationEventPreferences,
  NotificationRule,
  TransientNotificationPosition,
} from "../contracts/types";
import { useI18n } from "../i18n/context";
import type { AppController } from "../state/appController";
import type { NotificationEventPreferencePatch } from "../state/applicationPreferences";
import { Icon } from "./Icon";
import {
  PreferenceCheckbox,
  SettingsHeading,
  SettingsRow,
  SettingsSection,
} from "./SettingsPrimitives";

type NotificationSettingsController = Pick<
  AppController,
  | "applicationPreferences"
  | "applicationPreferencesError"
  | "applicationPreferencesLoaded"
  | "applicationPreferencesSaving"
  | "updateApplicationPreferences"
>;

type NotificationEvent = keyof NotificationEventPreferences;

export function NotificationSettings(props: {
  readonly controller: NotificationSettingsController;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().settings;
  const preferences = () => props.controller.applicationPreferences().notifications;
  const controlsDisabled = () => !props.controller.applicationPreferencesLoaded();
  const eventRows = () => [
    {
      event: "approvalRequired" as const,
      label: messages().notificationApprovalRequired,
      description: messages().notificationApprovalRequiredDescription,
    },
    {
      event: "taskCompleted" as const,
      label: messages().notificationTaskCompleted,
      description: messages().notificationTaskCompletedDescription,
    },
    {
      event: "taskFailed" as const,
      label: messages().notificationTaskFailed,
      description: messages().notificationTaskFailedDescription,
    },
    {
      event: "usageLimitReset" as const,
      label: messages().notificationUsageLimitReset,
      description: messages().notificationUsageLimitResetDescription,
    },
    {
      event: "usageResetAvailable" as const,
      label: messages().notificationUsageResetAvailable,
      description: messages().notificationUsageResetAvailableDescription,
    },
    {
      event: "lunaReserveAvailable" as const,
      label: messages().notificationLunaReserveAvailable,
      description: messages().notificationLunaReserveAvailableDescription,
    },
  ];

  function updateRule(event: NotificationEvent, patch: Partial<NotificationRule>): void {
    const rule = { ...preferences().events[event], ...patch };
    void props.controller.updateApplicationPreferences({
      notifications: { events: notificationEventPatch(event, rule) },
    });
  }

  return (
    <div class="settings-page notification-settings-page">
      <SettingsHeading
        title={messages().notifications}
        description={messages().notificationsDescription}
      />
      <SettingsSection title={messages().notificationDelivery}>
        <PreferenceCheckbox
          checked={preferences().enabled}
          description={messages().notificationsEnabledDescription}
          disabled={controlsDisabled()}
          label={messages().notificationsEnabled}
          onChange={(enabled) =>
            void props.controller.updateApplicationPreferences({ notifications: { enabled } })
          }
        />
      </SettingsSection>
      <SettingsSection
        description={messages().notificationPresentationDescription}
        title={messages().notificationPresentation}
      >
        <SettingsRow
          label={messages().notificationPosition}
          description={messages().notificationPositionDescription}
        >
          <select
            aria-label={messages().notificationPosition}
            disabled={controlsDisabled() || !preferences().enabled}
            onChange={(event) => {
              const transientPosition = parsePosition(event.currentTarget.value);
              if (transientPosition !== undefined) {
                void props.controller.updateApplicationPreferences({
                  notifications: { transientPosition },
                });
              }
            }}
            value={preferences().transientPosition}
          >
            <option value="topLeft">{messages().notificationTopLeft}</option>
            <option value="topRight">{messages().notificationTopRight}</option>
            <option value="bottomLeft">{messages().notificationBottomLeft}</option>
            <option value="bottomRight">{messages().notificationBottomRight}</option>
          </select>
        </SettingsRow>
        <SettingsRow
          label={messages().notificationDuration}
          description={messages().notificationDurationDescription}
        >
          <label class="notification-duration-control">
            <input
              aria-label={messages().notificationDuration}
              disabled={controlsDisabled() || !preferences().enabled}
              max={TRANSIENT_NOTIFICATION_MAXIMUM_DURATION_SECONDS}
              min={TRANSIENT_NOTIFICATION_MINIMUM_DURATION_SECONDS}
              onChange={(event) => {
                const transientDurationSeconds = Number(event.currentTarget.value);
                if (
                  Number.isInteger(transientDurationSeconds) &&
                  transientDurationSeconds >= TRANSIENT_NOTIFICATION_MINIMUM_DURATION_SECONDS &&
                  transientDurationSeconds <= TRANSIENT_NOTIFICATION_MAXIMUM_DURATION_SECONDS
                ) {
                  void props.controller.updateApplicationPreferences({
                    notifications: { transientDurationSeconds },
                  });
                }
              }}
              type="range"
              value={preferences().transientDurationSeconds}
            />
            <span>{preferences().transientDurationSeconds}s</span>
          </label>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        description={messages().notificationEventsDescription}
        title={messages().notificationEvents}
      >
        <For each={eventRows()}>
          {(row) => (
            <div class="notification-event-row">
              <span>
                <strong>{row.label}</strong>
                <small>{row.description}</small>
              </span>
              <div class="notification-event-controls">
                <label>
                  <input
                    checked={preferences().events[row.event].enabled}
                    disabled={controlsDisabled() || !preferences().enabled}
                    onChange={(event) =>
                      updateRule(row.event, { enabled: event.currentTarget.checked })
                    }
                    type="checkbox"
                  />
                  <span>{messages().notificationEventEnabled}</span>
                </label>
                <label>
                  <input
                    checked={preferences().events[row.event].priority}
                    disabled={
                      controlsDisabled() ||
                      !preferences().enabled ||
                      !preferences().events[row.event].enabled
                    }
                    onChange={(event) =>
                      updateRule(row.event, { priority: event.currentTarget.checked })
                    }
                    type="checkbox"
                  />
                  <Icon name="pin" size={13} />
                  <span>{messages().notificationEventPriority}</span>
                </label>
              </div>
            </div>
          )}
        </For>
      </SettingsSection>
      <span aria-live="polite" class="visually-hidden">
        {props.controller.applicationPreferencesSaving() ? messages().savingAppPreferences : ""}
      </span>
      <Show when={props.controller.applicationPreferencesError()}>
        {(error) => (
          <p aria-live="polite" class="application-preferences-status error">
            {error()}
          </p>
        )}
      </Show>
    </div>
  );
}

function parsePosition(value: string): TransientNotificationPosition | undefined {
  return value === "bottomLeft" ||
    value === "bottomRight" ||
    value === "topLeft" ||
    value === "topRight"
    ? value
    : undefined;
}

function notificationEventPatch(
  event: NotificationEvent,
  rule: NotificationRule,
): NotificationEventPreferencePatch {
  switch (event) {
    case "approvalRequired":
      return { approvalRequired: rule };
    case "taskCompleted":
      return { taskCompleted: rule };
    case "taskFailed":
      return { taskFailed: rule };
    case "usageLimitReset":
      return { usageLimitReset: rule };
    case "usageResetAvailable":
      return { usageResetAvailable: rule };
    case "lunaReserveAvailable":
      return { lunaReserveAvailable: rule };
  }
}
