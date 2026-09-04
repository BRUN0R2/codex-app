import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { emitTo } from "@tauri-apps/api/event";
import {
  getAllWindows,
  getCurrentWindow,
  type Monitor,
  monitorFromPoint,
  type Window as TauriWindow,
} from "@tauri-apps/api/window";

import {
  type AppNotification,
  decodeNotificationChannel,
  decodeNotificationOverlayAction,
  decodeNotificationOverlayApprovalResult,
  decodeNotificationOverlayPayload,
  type NotificationChannel,
  type NotificationOverlayAction,
  type NotificationOverlayApprovalResult,
  type NotificationOverlayPayload,
} from "../contracts/notificationOverlay";
import {
  resolveNotificationOverlayPosition,
  resolveNotificationOverlaySize,
} from "./notificationOverlayGeometry";
import { listenRuntime } from "./runtimeBridge";

const MAIN_WINDOW_LABEL = "main";
const NOTIFICATION_OVERLAY_LABELS = {
  priority: "notification-priority-overlay",
  transient: "notification-transient-overlay",
} as const satisfies Readonly<Record<NotificationChannel, string>>;
const PRESENTATION_EVENT = "notification-overlay:presentation";
const ACTION_EVENT = "notification-overlay:action";
const APPROVAL_RESULT_EVENT = "notification-overlay:approval-result";
const READY_EVENT = "notification-overlay:ready";

interface OverlayReadyPayload {
  readonly schemaVersion: 1;
  readonly channel: NotificationChannel;
}

export function subscribeToNotificationOverlay(
  onAction: (action: NotificationOverlayAction) => void,
  onReady: (channel: NotificationChannel) => void,
  onBoundaryError: (reason: unknown) => void,
): Promise<() => void> {
  return subscribeAtomically([
    () =>
      listenRuntime<unknown>(ACTION_EVENT, ({ payload }) => {
        try {
          onAction(decodeNotificationOverlayAction(payload));
        } catch (reason) {
          onBoundaryError(reason);
        }
      }),
    () =>
      listenRuntime<unknown>(READY_EVENT, ({ payload }) => {
        try {
          onReady(decodeReadyPayload(payload).channel);
        } catch (reason) {
          onBoundaryError(reason);
        }
      }),
  ]);
}

export function subscribeToNotificationOverlaySurface(
  onPresentation: (payload: NotificationOverlayPayload) => void,
  onApprovalResult: (result: NotificationOverlayApprovalResult) => void,
  onBoundaryError: (reason: unknown) => void,
): Promise<() => void> {
  return subscribeAtomically([
    () =>
      listenRuntime<unknown>(PRESENTATION_EVENT, ({ payload }) => {
        try {
          onPresentation(decodeNotificationOverlayPayload(payload));
        } catch (reason) {
          onBoundaryError(reason);
        }
      }),
    () =>
      listenRuntime<unknown>(APPROVAL_RESULT_EVENT, ({ payload }) => {
        try {
          onApprovalResult(decodeNotificationOverlayApprovalResult(payload));
        } catch (reason) {
          onBoundaryError(reason);
        }
      }),
  ]);
}

export function publishNotificationPresentation(
  payload: NotificationOverlayPayload,
): Promise<void> {
  return emitTo(NOTIFICATION_OVERLAY_LABELS[payload.channel], PRESENTATION_EVENT, payload);
}

export function signalNotificationOverlayReady(channel: NotificationChannel): Promise<void> {
  return emitTo(MAIN_WINDOW_LABEL, READY_EVENT, {
    schemaVersion: 1,
    channel,
  } satisfies OverlayReadyPayload);
}

export function sendNotificationOverlayAction(action: NotificationOverlayAction): Promise<void> {
  return emitTo(MAIN_WINDOW_LABEL, ACTION_EVENT, action);
}

export function publishNotificationApprovalResult(
  result: NotificationOverlayApprovalResult,
): Promise<void> {
  return emitTo(NOTIFICATION_OVERLAY_LABELS[result.channel], APPROVAL_RESULT_EVENT, result);
}

export async function presentNotificationOverlay(
  notification: AppNotification,
  contentHeight: number,
  recenterPriority: boolean,
): Promise<void> {
  const overlay = getCurrentWindow();
  const monitor = await mainWindowMonitor();
  const area = monitor.workArea;
  const areaPosition = area.position.toLogical(monitor.scaleFactor);
  const areaSize = area.size.toLogical(monitor.scaleFactor);
  const overlaySize = resolveNotificationOverlaySize(
    notification.presentation,
    contentHeight,
    areaSize.height,
  );
  await overlay.setSize(new LogicalSize(overlaySize.width, overlaySize.height));

  if (notification.presentation.type === "transient" || recenterPriority) {
    const position = resolveNotificationOverlayPosition(
      notification.presentation,
      areaPosition,
      areaSize,
      overlaySize,
    );
    await overlay.setPosition(new LogicalPosition(position.x, position.y));
  }

  await overlay.setAlwaysOnTop(true);
  await overlay.show();
  if (notification.presentation.type === "priority") {
    await overlay.setFocus();
  }
}

export async function hideNotificationOverlay(): Promise<void> {
  await getCurrentWindow().hide();
}

export async function startNotificationOverlayDrag(): Promise<void> {
  await getCurrentWindow().startDragging();
}

export async function restoreMainApplicationWindow(): Promise<void> {
  const main = await requiredWindow(MAIN_WINDOW_LABEL);
  await main.show();
  if (await main.isMinimized()) await main.unminimize();
  await main.setFocus();
}

async function mainWindowMonitor(): Promise<Monitor> {
  const main = await requiredWindow(MAIN_WINDOW_LABEL);
  const [position, size] = await Promise.all([main.outerPosition(), main.outerSize()]);
  const monitor = await monitorFromPoint(
    position.x + Math.round(size.width / 2),
    position.y + Math.round(size.height / 2),
  );
  if (monitor === null) throw new Error("The monitor containing the main window is unavailable.");
  return monitor;
}

async function requiredWindow(label: string): Promise<TauriWindow> {
  const window = (await getAllWindows()).find((candidate) => candidate.label === label);
  if (window === undefined) throw new Error(`The ${label} window is unavailable.`);
  return window;
}

function decodeReadyPayload(value: unknown): OverlayReadyPayload {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    (value as { readonly schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    throw new Error("The notification overlay ready payload is invalid.");
  }
  const channel = decodeNotificationChannel(
    (value as { readonly channel?: unknown }).channel,
    "$.channel",
  );
  return { schemaVersion: 1, channel };
}

async function subscribeAtomically(
  subscriptions: readonly (() => Promise<() => void>)[],
): Promise<() => void> {
  const active: Array<() => void> = [];
  try {
    for (const subscribe of subscriptions) active.push(await subscribe());
  } catch (reason) {
    for (const unsubscribe of active) unsubscribe();
    throw reason;
  }
  return () => {
    for (const unsubscribe of active) unsubscribe();
  };
}
