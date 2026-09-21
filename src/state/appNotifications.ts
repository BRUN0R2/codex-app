import {
  type Accessor,
  createMemo,
  createRoot,
  createSignal,
  getOwner,
  runWithOwner,
} from "solid-js";
import type {
  AppNotification,
  ConfigurableNotificationEventKind,
  NotificationEventKind,
  NotificationTarget,
  NotificationTone,
} from "../contracts/notificationOverlay";
import { NOTIFICATION_QUEUE_CAPACITY } from "../contracts/notificationPolicy";
import type {
  EngineServerRequest,
  NotificationPreferences,
  NotificationRule,
} from "../contracts/types";

const MAX_REMEMBERED_NOTIFICATION_IDS = 128;
const BASIC_NOTIFICATION_RULE = {
  enabled: true,
  priority: false,
} as const satisfies NotificationRule;

export interface AppNotificationInput {
  readonly approval: EngineServerRequest | null;
  readonly id: string;
  readonly event: NotificationEventKind;
  readonly tone: NotificationTone;
  readonly title: string;
  readonly message: string;
  readonly target: NotificationTarget | null;
}

export interface AppNotificationCenter {
  readonly dispose: () => void;
  readonly approvalFor: (notificationId: string) => EngineServerRequest | null;
  readonly priority: AppNotificationLane;
  readonly transient: AppNotificationLane;
  readonly clear: () => void;
  readonly dismiss: (notificationId: string) => boolean;
  readonly enqueue: (input: AppNotificationInput) => boolean;
  readonly preview: (
    input: AppNotificationInput & { readonly event: ConfigurableNotificationEventKind },
  ) => boolean;
  readonly reset: () => void;
  readonly remove: (notificationId: string) => boolean;
  readonly targetFor: (notificationId: string) => NotificationTarget | null;
}

export interface AppNotificationLane {
  readonly active: Accessor<AppNotification | null>;
  readonly pendingCount: Accessor<number>;
}

export function createAppNotificationCenter(
  preferences: Accessor<NotificationPreferences>,
  now: () => number = Date.now,
): AppNotificationCenter {
  const lifecycle = createRoot((dispose) => ({ dispose, owner: getOwner() }));
  const [priorityQueue, setPriorityQueue] = createSignal<readonly AppNotification[]>([]);
  const [transientQueue, setTransientQueue] = createSignal<readonly AppNotification[]>([]);
  const rememberedIds = new Set<string>();
  const rememberedOrder: string[] = [];
  const priority = runWithOwner(lifecycle.owner, () => createNotificationLane(priorityQueue));
  const transient = runWithOwner(lifecycle.owner, () => createNotificationLane(transientQueue));
  if (priority === undefined || transient === undefined) {
    lifecycle.dispose();
    throw new Error("Notification center could not establish its reactive owner.");
  }
  const priorityLane = priority;
  const transientLane = transient;

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
    const [current, setCurrent] =
      notification.presentation.type === "priority"
        ? [priorityQueue, setPriorityQueue]
        : [transientQueue, setTransientQueue];
    const next = insertNotification(current(), notification);
    if (next === null) return false;
    remember(input.id);
    setCurrent(next);
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
    if (priorityLane.active()?.id === notificationId) {
      setPriorityQueue((current) => current.slice(1));
      return true;
    }
    if (transientLane.active()?.id === notificationId) {
      setTransientQueue((current) => current.slice(1));
      return true;
    }
    return false;
  }

  function targetFor(notificationId: string): NotificationTarget | null {
    const notification = activeNotification(notificationId, priorityLane, transientLane);
    return notification?.target ?? null;
  }

  function approvalFor(notificationId: string): EngineServerRequest | null {
    const notification = activeNotification(notificationId, priorityLane, transientLane);
    return notification?.approval ?? null;
  }

  function remove(notificationId: string): boolean {
    const nextPriority = removeNotification(priorityQueue(), notificationId);
    const nextTransient = removeNotification(transientQueue(), notificationId);
    if (nextPriority !== null) setPriorityQueue(nextPriority);
    if (nextTransient !== null) setTransientQueue(nextTransient);
    return nextPriority !== null || nextTransient !== null;
  }

  return {
    approvalFor,
    dispose: lifecycle.dispose,
    priority: priorityLane,
    transient: transientLane,
    clear: () => {
      setPriorityQueue([]);
      setTransientQueue([]);
    },
    dismiss,
    enqueue,
    preview,
    remove,
    reset: () => {
      setPriorityQueue([]);
      setTransientQueue([]);
      rememberedIds.clear();
      rememberedOrder.length = 0;
    },
    targetFor,
  };
}

function removeNotification(
  queue: readonly AppNotification[],
  notificationId: string,
): readonly AppNotification[] | null {
  const index = queue.findIndex((entry) => entry.id === notificationId);
  if (index < 0) return null;
  return [...queue.slice(0, index), ...queue.slice(index + 1)];
}

function insertNotification(
  current: readonly AppNotification[],
  notification: AppNotification,
): readonly AppNotification[] | null {
  if (current.length >= NOTIFICATION_QUEUE_CAPACITY) return null;
  return [...current, notification];
}

function createNotificationLane(queue: Accessor<readonly AppNotification[]>): AppNotificationLane {
  return {
    active: createMemo(() => queue()[0] ?? null),
    pendingCount: createMemo(() => queue().length),
  };
}

function activeNotification(
  notificationId: string,
  priority: AppNotificationLane,
  transient: AppNotificationLane,
): AppNotification | null {
  for (const lane of [priority, transient] as const satisfies readonly AppNotificationLane[]) {
    const notification = lane.active();
    if (notification?.id === notificationId) return notification;
  }
  return null;
}

function notificationRule(
  preferences: NotificationPreferences,
  event: NotificationEventKind,
): NotificationRule {
  return event === "settingsSaved" ? BASIC_NOTIFICATION_RULE : preferences.events[event];
}
