import { type Accessor, createSignal, onCleanup, onMount } from "solid-js";

import type {
  AppNotification,
  NotificationOverlayAction,
  NotificationOverlayPayload,
} from "../contracts/notificationOverlay";
import {
  hideNotificationOverlay,
  presentNotificationOverlay,
  sendNotificationOverlayAction,
  signalNotificationOverlayReady,
  startNotificationOverlayDrag,
  subscribeToNotificationPresentations,
} from "../infrastructure/notificationOverlayClient";

export interface NotificationOverlayController {
  readonly notification: Accessor<AppNotification | null>;
  readonly pendingCount: Accessor<number>;
  readonly activate: (notificationId: string) => void;
  readonly dismiss: (notificationId: string) => void;
  readonly startDrag: () => void;
  readonly synchronizePresentation: (element: HTMLElement) => void;
}

export function createNotificationOverlayController(): NotificationOverlayController {
  const [payload, setPayload] = createSignal<NotificationOverlayPayload>({
    notification: null,
    pendingCount: 0,
  });
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let timerNotificationId: string | null = null;
  let presentedPriorityId: string | null = null;
  let operationQueue: Promise<void> = Promise.resolve();

  function reportFailure(reason: unknown): void {
    const message = reason instanceof Error ? reason.message : String(reason);
    void sendNotificationOverlayAction({ type: "failure", message }).catch((reportingFailure) => {
      console.error("Could not report a notification overlay failure.", reportingFailure);
    });
  }

  function applyPresentation(next: NotificationOverlayPayload): void {
    const previousNotificationId = payload().notification?.id ?? null;
    const nextNotificationId = next.notification?.id ?? null;
    if (previousNotificationId !== nextNotificationId) clearTimer();
    setPayload(next);
    const notification = next.notification;
    if (notification === null) {
      presentedPriorityId = null;
      enqueueOperation(hideNotificationOverlay);
    }
  }

  function synchronizePresentation(element: HTMLElement): void {
    const notification = payload().notification;
    if (notification === null) return;
    const recenterPriority =
      notification.presentation.type === "priority" && presentedPriorityId !== notification.id;
    if (notification.presentation.type === "priority") presentedPriorityId = notification.id;
    else presentedPriorityId = null;
    enqueueOperation(async () => {
      await presentNotificationOverlay(
        notification,
        Math.ceil(element.getBoundingClientRect().height),
        recenterPriority,
      );
      const current = payload().notification;
      if (
        disposed ||
        current?.id !== notification.id ||
        current.presentation.type !== "transient" ||
        timerNotificationId === notification.id
      ) {
        return;
      }
      timerNotificationId = notification.id;
      timeout = setTimeout(
        () => dismiss(notification.id),
        notification.presentation.type === "transient"
          ? notification.presentation.durationSeconds * 1_000
          : 0,
      );
    });
  }

  function dispatch(action: NotificationOverlayAction): void {
    clearTimer();
    enqueueOperation(() => sendNotificationOverlayAction(action));
  }

  function dismiss(notificationId: string): void {
    if (payload().notification?.id === notificationId) {
      dispatch({ type: "dismiss", notificationId });
    }
  }

  function activate(notificationId: string): void {
    if (payload().notification?.id === notificationId) {
      dispatch({ type: "activate", notificationId });
    }
  }

  function enqueueOperation(operation: () => Promise<void>): void {
    const next = operationQueue.then(operation);
    operationQueue = next.catch(() => undefined);
    void next.catch(reportFailure);
  }

  function clearTimer(): void {
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
    timerNotificationId = null;
  }

  onMount(() => {
    void subscribeToNotificationPresentations(applyPresentation, reportFailure)
      .then(async (dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unsubscribe = dispose;
        await signalNotificationOverlayReady();
      })
      .catch(reportFailure);
  });

  onCleanup(() => {
    disposed = true;
    clearTimer();
    unsubscribe?.();
  });

  return {
    notification: () => payload().notification,
    pendingCount: () => payload().pendingCount,
    activate,
    dismiss,
    startDrag: () => enqueueOperation(startNotificationOverlayDrag),
    synchronizePresentation,
  };
}
