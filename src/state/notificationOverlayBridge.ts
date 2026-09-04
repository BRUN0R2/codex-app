import { type Accessor, createEffect, createSignal, onCleanup, onMount } from "solid-js";

import { approvalDecisionsFor } from "../contracts/approval";
import type {
  AppNotification,
  NotificationChannel,
  NotificationOverlayAction,
  NotificationTarget,
} from "../contracts/notificationOverlay";
import type { ApprovalDecision, EngineServerRequest } from "../contracts/types";
import {
  publishNotificationApprovalResult,
  publishNotificationPresentation,
  restoreMainApplicationWindow,
  subscribeToNotificationOverlay,
} from "../infrastructure/notificationOverlayClient";
import { isDesktopRuntime } from "../platform/desktopRuntime";

interface NotificationOverlayBridgeOptions {
  readonly approvalFor: (notificationId: string) => EngineServerRequest | null;
  readonly priority: NotificationOverlayLane;
  readonly transient: NotificationOverlayLane;
  readonly dismiss: (notificationId: string) => boolean;
  readonly targetFor: (notificationId: string) => NotificationTarget | null;
  readonly onActivate: (target: NotificationTarget) => void;
  readonly reportError: (reason: unknown) => void;
  readonly respondToApproval: (requestId: string, decision: ApprovalDecision) => Promise<boolean>;
}

interface NotificationOverlayLane {
  readonly active: Accessor<AppNotification | null>;
  readonly pendingCount: Accessor<number>;
}

export function createNotificationOverlayBridge(options: NotificationOverlayBridgeOptions): void {
  if (!isDesktopRuntime()) return;

  const [readyChannels, setReadyChannels] = createSignal<readonly NotificationChannel[]>([]);
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  const publishQueues: Record<NotificationChannel, Promise<void>> = {
    priority: Promise.resolve(),
    transient: Promise.resolve(),
  };

  function handleAction(action: NotificationOverlayAction): void {
    if (action.type === "failure") {
      options.reportError(new Error(action.message));
      return;
    }
    const lane = action.channel === "priority" ? options.priority : options.transient;
    if (lane.active()?.id !== action.notificationId) return;
    if (action.type === "respondToApproval") {
      const request = options.approvalFor(action.notificationId);
      if (
        request === null ||
        request.id !== action.requestId ||
        !approvalDecisionsFor(request).includes(action.decision)
      ) {
        options.reportError(new Error("The notification approval action is not valid."));
        void publishApprovalResult(action, false);
        return;
      }
      void options.respondToApproval(action.requestId, action.decision).then(
        (succeeded) => publishApprovalResult(action, succeeded),
        (reason) => {
          options.reportError(reason);
          return publishApprovalResult(action, false);
        },
      );
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

  function publishApprovalResult(
    action: Extract<NotificationOverlayAction, { readonly type: "respondToApproval" }>,
    succeeded: boolean,
  ): Promise<void> {
    return publishNotificationApprovalResult({
      channel: action.channel,
      notificationId: action.notificationId,
      requestId: action.requestId,
      succeeded,
    }).catch(options.reportError);
  }

  onMount(() => {
    void subscribeToNotificationOverlay(
      handleAction,
      (channel) =>
        setReadyChannels((current) =>
          current.includes(channel) ? current : [...current, channel],
        ),
      options.reportError,
    )
      .then((dispose) => {
        if (disposed) dispose();
        else unsubscribe = dispose;
      })
      .catch(options.reportError);
  });

  projectLane("priority", options.priority);
  projectLane("transient", options.transient);

  function projectLane(channel: NotificationChannel, lane: NotificationOverlayLane): void {
    createEffect(() => {
      if (!readyChannels().includes(channel)) return;
      const payload = {
        channel,
        notification: lane.active(),
        pendingCount: lane.pendingCount(),
      };
      publishQueues[channel] = publishQueues[channel]
        .then(() => publishNotificationPresentation(payload))
        .catch(options.reportError);
    });
  }

  onCleanup(() => {
    disposed = true;
    unsubscribe?.();
  });
}
