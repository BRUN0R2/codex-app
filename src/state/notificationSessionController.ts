import { type Accessor, createEffect, createRoot } from "solid-js";

import type {
  ConfigurableNotificationEventKind,
  NotificationTarget,
} from "../contracts/notificationOverlay";
import type {
  ApplicationPreferences,
  EngineNotification,
  EngineServerRequest,
  ThreadSummary,
} from "../contracts/types";
import { formatMessage, type TranslationMessages } from "../i18n/messages";
import {
  type AppNotificationInput,
  type AppNotificationLane,
  createAppNotificationCenter,
} from "./appNotifications";
import { createNotificationPreview } from "./notificationPreview";
import { notificationTaskLabel } from "./notificationTransitions";

type TurnCompletedNotification = Extract<EngineNotification, { readonly method: "turn.completed" }>;

export interface NotificationSessionController {
  readonly dispose: () => void;
  readonly priority: AppNotificationLane;
  readonly transient: AppNotificationLane;
  readonly approvalFor: (notificationId: string) => EngineServerRequest | null;
  readonly dismiss: (notificationId: string) => boolean;
  readonly enqueue: (input: AppNotificationInput) => boolean;
  readonly notifyApprovalRequired: (request: EngineServerRequest) => void;
  readonly notifySettingsSaved: () => void;
  readonly notifyTurnCompletion: (notification: TurnCompletedNotification) => void;
  readonly preview: (event: ConfigurableNotificationEventKind) => boolean;
  readonly removeApprovalNotification: (requestId: string) => void;
  readonly targetFor: (notificationId: string) => NotificationTarget | null;
}

export interface NotificationSessionDependencies {
  readonly applicationPreferences: Accessor<ApplicationPreferences>;
  readonly applicationPreferencesLoaded: Accessor<boolean>;
  readonly localization: {
    readonly notifications: Accessor<TranslationMessages["notifications"]>;
  };
  readonly taskLabels: () => readonly ThreadSummary[];
}

export function createNotificationSessionController(
  dependencies: NotificationSessionDependencies,
): NotificationSessionController {
  const { applicationPreferences, applicationPreferencesLoaded, localization, taskLabels } =
    dependencies;
  const center = createAppNotificationCenter(() => applicationPreferences().notifications);
  let notificationSequence = 0;

  function enqueue(input: AppNotificationInput): boolean {
    return applicationPreferencesLoaded() && center.enqueue(input);
  }

  const dispose = createRoot((release) => {
    createEffect(() => {
      if (!applicationPreferences().notifications.enabled) center.clear();
    });
    return release;
  });

  function notifySettingsSaved(): void {
    notificationSequence += 1;
    enqueue({
      approval: null,
      id: `settings-saved:${notificationSequence}`,
      event: "settingsSaved",
      tone: "success",
      title: localization.notifications().settingsSavedTitle,
      message: localization.notifications().settingsSavedMessage,
      target: null,
    });
  }

  function preview(event: ConfigurableNotificationEventKind): boolean {
    if (!applicationPreferencesLoaded()) return false;
    notificationSequence += 1;
    return center.preview(
      createNotificationPreview(event, localization.notifications(), notificationSequence),
    );
  }

  function notifyTurnCompletion(notification: TurnCompletedNotification): void {
    if (notification.params.turn.status === "interrupted") return;
    const task = taskLabel(notification.params.threadId);
    const failed =
      notification.params.turn.status === "failed" || notification.params.error !== null;
    enqueue({
      approval: null,
      id: `task-${failed ? "failed" : "completed"}:${notification.params.turn.id}`,
      event: failed ? "taskFailed" : "taskCompleted",
      tone: failed ? "error" : "success",
      title: failed
        ? localization.notifications().taskFailedTitle
        : localization.notifications().taskCompletedTitle,
      message: formatMessage(
        failed
          ? localization.notifications().taskFailedMessage
          : localization.notifications().taskCompletedMessage,
        { task },
      ),
      target: { type: "thread", threadId: notification.params.threadId },
    });
  }

  function notifyApprovalRequired(request: EngineServerRequest): void {
    enqueue({
      approval: request,
      id: `approval-required:${request.id}`,
      event: "approvalRequired",
      tone: "attention",
      title: localization.notifications().approvalTitle,
      message: formatMessage(localization.notifications().approvalMessage, {
        task: taskLabel(request.params.threadId),
      }),
      target: { type: "thread", threadId: request.params.threadId },
    });
  }

  function taskLabel(threadId: string): string {
    return notificationTaskLabel(threadId, taskLabels(), localization.notifications().untitledTask);
  }

  return {
    approvalFor: center.approvalFor,
    dispose: () => {
      dispose();
      center.dispose();
    },
    dismiss: center.dismiss,
    enqueue,
    notifyApprovalRequired,
    notifySettingsSaved,
    notifyTurnCompletion,
    preview,
    priority: center.priority,
    removeApprovalNotification: (requestId) => {
      center.remove(`approval-required:${requestId}`);
    },
    targetFor: center.targetFor,
    transient: center.transient,
  };
}
