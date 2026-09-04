import { type Accessor, createSignal, onCleanup, onMount } from "solid-js";

import type {
  AppNotification,
  NotificationChannel,
  NotificationOverlayAction,
  NotificationOverlayApprovalResult,
  NotificationOverlayPayload,
} from "../contracts/notificationOverlay";
import type { ApprovalDecision } from "../contracts/types";
import {
  hideNotificationOverlay,
  presentNotificationOverlay,
  sendNotificationOverlayAction,
  signalNotificationOverlayReady,
  startNotificationOverlayDrag,
  subscribeToNotificationOverlaySurface,
} from "../infrastructure/notificationOverlayClient";

export interface NotificationOverlayController {
  readonly notification: Accessor<AppNotification | null>;
  readonly pendingCount: Accessor<number>;
  readonly approvalResponseFailed: Accessor<boolean>;
  readonly approvalResponding: Accessor<boolean>;
  readonly activate: (notificationId: string) => void;
  readonly dismiss: (notificationId: string) => void;
  readonly respondToApproval: (
    notificationId: string,
    requestId: string,
    decision: ApprovalDecision,
  ) => void;
  readonly startDrag: () => void;
  readonly synchronizePresentation: (contentHeight: number) => void;
}

export function createNotificationOverlayController(
  channel: NotificationChannel,
): NotificationOverlayController {
  const [payload, setPayload] = createSignal<NotificationOverlayPayload>({
    channel,
    notification: null,
    pendingCount: 0,
  });
  const [approvalResponding, setApprovalResponding] = createSignal(false);
  const [approvalResponseFailed, setApprovalResponseFailed] = createSignal(false);
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let timerNotificationId: string | null = null;
  let presentedPriorityId: string | null = null;
  let synchronizedNotificationId: string | null = null;
  let synchronizedContentHeight: number | null = null;
  let operationQueue: Promise<void> = Promise.resolve();

  function reportFailure(reason: unknown): void {
    const message = reason instanceof Error ? reason.message : String(reason);
    void sendNotificationOverlayAction({ type: "failure", channel, message }).catch(
      (reportingFailure) => {
        console.error("Could not report a notification overlay failure.", reportingFailure);
      },
    );
  }

  function applyPresentation(next: NotificationOverlayPayload): void {
    if (next.channel !== channel) {
      reportFailure(new Error(`Received ${next.channel} content in the ${channel} overlay.`));
      return;
    }
    const previousNotificationId = payload().notification?.id ?? null;
    const nextNotificationId = next.notification?.id ?? null;
    if (previousNotificationId !== nextNotificationId) {
      clearTimer();
      setApprovalResponding(false);
      setApprovalResponseFailed(false);
    }
    setPayload(next);
    const notification = next.notification;
    if (notification === null) {
      presentedPriorityId = null;
      enqueueOperation(hideNotificationOverlay);
    }
  }

  function applyApprovalResult(result: NotificationOverlayApprovalResult): void {
    if (result.channel !== channel) {
      reportFailure(new Error(`Received a ${result.channel} result in the ${channel} overlay.`));
      return;
    }
    const notification = payload().notification;
    if (
      notification?.id !== result.notificationId ||
      notification.approval?.id !== result.requestId
    ) {
      return;
    }
    if (!result.succeeded) {
      setApprovalResponding(false);
      setApprovalResponseFailed(true);
    }
  }

  function synchronizePresentation(contentHeight: number): void {
    const notification = payload().notification;
    if (notification === null) return;
    const roundedContentHeight = Math.ceil(contentHeight);
    if (
      synchronizedNotificationId === notification.id &&
      synchronizedContentHeight === roundedContentHeight
    ) {
      return;
    }
    synchronizedNotificationId = notification.id;
    synchronizedContentHeight = roundedContentHeight;
    const recenterPriority =
      notification.presentation.type === "priority" && presentedPriorityId !== notification.id;
    if (notification.presentation.type === "priority") presentedPriorityId = notification.id;
    else presentedPriorityId = null;
    enqueueOperation(async () => {
      await presentNotificationOverlay(notification, roundedContentHeight, recenterPriority);
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
      dispatch({ type: "dismiss", channel, notificationId });
    }
  }

  function activate(notificationId: string): void {
    if (payload().notification?.id === notificationId) {
      dispatch({ type: "activate", channel, notificationId });
    }
  }

  function respondToApproval(
    notificationId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): void {
    const notification = payload().notification;
    if (notification?.id !== notificationId || notification.approval?.id !== requestId) return;
    clearTimer();
    setApprovalResponding(true);
    setApprovalResponseFailed(false);
    void enqueueOperation(() =>
      sendNotificationOverlayAction({
        type: "respondToApproval",
        channel,
        decision,
        notificationId,
        requestId,
      }),
    ).catch(() => {
      if (payload().notification?.id === notificationId) {
        setApprovalResponding(false);
        setApprovalResponseFailed(true);
      }
    });
  }

  function enqueueOperation(operation: () => Promise<void>): Promise<void> {
    const next = operationQueue.then(operation);
    operationQueue = next.catch(() => undefined);
    void next.catch(reportFailure);
    return next;
  }

  function clearTimer(): void {
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
    timerNotificationId = null;
  }

  onMount(() => {
    void subscribeToNotificationOverlaySurface(
      channel,
      applyPresentation,
      applyApprovalResult,
      reportFailure,
    )
      .then(async (dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unsubscribe = dispose;
        await signalNotificationOverlayReady(channel);
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
    approvalResponseFailed,
    approvalResponding,
    activate,
    dismiss,
    respondToApproval,
    startDrag: () => enqueueOperation(startNotificationOverlayDrag),
    synchronizePresentation,
  };
}
