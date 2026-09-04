import { type Accessor, createMemo, createSignal } from "solid-js";
import type {
  AppNotification,
  ConfigurableNotificationEventKind,
  NotificationEventKind,
  NotificationTarget,
  NotificationTone,
} from "../contracts/notificationOverlay";
import { NOTIFICATION_QUEUE_CAPACITY } from "../contracts/notificationPolicy";
import type { NotificationPreferences, NotificationRule } from "../contracts/types";

const MAX_REMEMBERED_NOTIFICATION_IDS = 128;
const BASIC_NOTIFICATION_RULE = {
  enabled: true,
  priority: false,
} as const satisfies NotificationRule;

export interface AppNotificationInput {
  readonly id: string;
  readonly event: NotificationEventKind;
  readonly tone: NotificationTone;
  readonly title: string;
  readonly message: string;
  readonly target: NotificationTarget | null;
}

export interface AppNotificationCenter {
  readonly active: Accessor<AppNotification | null>;
  readonly pendingCount: Accessor<number>;
  readonly clear: () => void;
  readonly dismiss: (notificationId: string) => boolean;
  readonly enqueue: (input: AppNotificationInput) => boolean;
  readonly preview: (
    input: AppNotificationInput & { readonly event: ConfigurableNotificationEventKind },
  ) => boolean;
  readonly reset: () => void;
  readonly targetFor: (notificationId: string) => NotificationTarget | null;
}

export function createAppNotificationCenter(
  preferences: Accessor<NotificationPreferences>,
  now: () => number = Date.now,
): AppNotificationCenter {
  const [queue, setQueue] = createSignal<readonly AppNotification[]>([]);
  const rememberedIds = new Set<string>();
  const rememberedOrder: string[] = [];
  const active = createMemo(() => queue()[0] ?? null);
  const pendingCount = createMemo(() => queue().length);

  function enqueue(input: AppNotificationInput): boolean {
    const currentPreferences = preferences();
    const rule = notificationRule(currentPreferences, input.event);
    if (!currentPreferences.enabled || !rule.enabled || rememberedIds.has(input.id)) {
      return false;
    }

    return insert(input, rule, currentPreferences);
  }

  function preview(
    input: AppNotificationInput & { readonly event: ConfigurableNotificationEventKind },
  ): boolean {
    const currentPreferences = preferences();
    return insert(input, notificationRule(currentPreferences, input.event), currentPreferences);
  }

  function insert(
    input: AppNotificationInput,
    rule: NotificationRule,
    currentPreferences: NotificationPreferences,
  ): boolean {
    if (rememberedIds.has(input.id)) return false;
    const notification: AppNotification = {
      ...input,
      createdAt: now(),
      presentation: rule.priority
        ? { type: "priority" }
        : {
            type: "transient",
            durationSeconds: currentPreferences.transientDurationSeconds,
            position: currentPreferences.transientPosition,
          },
    };
    const next = insertNotification(queue(), notification);
    if (!next.some((entry) => entry.id === notification.id)) return false;
    remember(input.id);
    setQueue(next);
    return true;
  }

  function remember(id: string): void {
    rememberedIds.add(id);
    rememberedOrder.push(id);
    const expired = rememberedOrder.splice(
      0,
      Math.max(0, rememberedOrder.length - MAX_REMEMBERED_NOTIFICATION_IDS),
    );
    for (const previousId of expired) rememberedIds.delete(previousId);
  }

  function dismiss(notificationId: string): boolean {
    if (active()?.id !== notificationId) return false;
    setQueue((current) => current.slice(1));
    return true;
  }

  function targetFor(notificationId: string): NotificationTarget | null {
    const notification = active();
    return notification?.id === notificationId ? notification.target : null;
  }

  return {
    active,
    pendingCount,
    clear: () => setQueue([]),
    dismiss,
    enqueue,
    preview,
    reset: () => {
      setQueue([]);
      rememberedIds.clear();
      rememberedOrder.length = 0;
    },
    targetFor,
  };
}

function insertNotification(
  current: readonly AppNotification[],
  notification: AppNotification,
): readonly AppNotification[] {
  const next = [...current];
  if (notification.presentation.type === "priority") {
    const firstTransient = next.findIndex((entry) => entry.presentation.type === "transient");
    next.splice(firstTransient < 0 ? next.length : firstTransient, 0, notification);
  } else {
    next.push(notification);
  }
  return next.slice(0, NOTIFICATION_QUEUE_CAPACITY);
}

function notificationRule(
  preferences: NotificationPreferences,
  event: NotificationEventKind,
): NotificationRule {
  return event === "settingsSaved" ? BASIC_NOTIFICATION_RULE : preferences.events[event];
}
