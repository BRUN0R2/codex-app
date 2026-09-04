import { type Accessor, createEffect, createSignal, onCleanup, onMount } from "solid-js";

import type {
  AppNotification,
  NotificationOverlayAction,
  NotificationTarget,
} from "../contracts/notificationOverlay";
import {
  publishNotificationPresentation,
  restoreMainApplicationWindow,
  subscribeToNotificationOverlay,
} from "../infrastructure/notificationOverlayClient";
import { isDesktopRuntime } from "../platform/desktopRuntime";

interface NotificationOverlayBridgeOptions {
  readonly active: Accessor<AppNotification | null>;
  readonly pendingCount: Accessor<number>;
  readonly dismiss: (notificationId: string) => boolean;
  readonly targetFor: (notificationId: string) => NotificationTarget | null;
  readonly onActivate: (target: NotificationTarget) => void;
  readonly reportError: (reason: unknown) => void;
}

export function createNotificationOverlayBridge(options: NotificationOverlayBridgeOptions): void {
  if (!isDesktopRuntime()) return;

  const [readyRevision, setReadyRevision] = createSignal(0);
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let publishQueue: Promise<void> = Promise.resolve();

  function handleAction(action: NotificationOverlayAction): void {
    if (action.type === "failure") {
      options.reportError(new Error(action.message));
      return;
    }
    if (action.type === "activate") {
      const target = options.targetFor(action.notificationId);
      if (target !== null && options.dismiss(action.notificationId)) {
        void restoreMainApplicationWindow()
          .then(() => options.onActivate(target))
          .catch(options.reportError);
      }
      return;
    }
    options.dismiss(action.notificationId);
  }

  onMount(() => {
    void subscribeToNotificationOverlay(
      handleAction,
      () => setReadyRevision((revision) => revision + 1),
      options.reportError,
    )
      .then((dispose) => {
        if (disposed) dispose();
        else unsubscribe = dispose;
      })
      .catch(options.reportError);
  });

  createEffect(() => {
    if (readyRevision() === 0) return;
    const payload = {
      notification: options.active(),
      pendingCount: options.pendingCount(),
    };
    publishQueue = publishQueue
      .then(() => publishNotificationPresentation(payload))
      .catch(options.reportError);
  });

  onCleanup(() => {
    disposed = true;
    unsubscribe?.();
  });
}
