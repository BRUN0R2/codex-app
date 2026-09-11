import type { NotificationPresentation } from "../contracts/notificationOverlay";

export const NOTIFICATION_SCREEN_MARGIN_PX = 20;
export const PRIORITY_NOTIFICATION_WIDTH_PX = 460;
export const TRANSIENT_NOTIFICATION_WIDTH_PX = 390;

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Size {
  readonly height: number;
  readonly width: number;
}

export function resolveNotificationOverlaySize(
  presentation: NotificationPresentation,
  contentHeight: number,
  workAreaHeight: number,
): Size {
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) {
    throw new Error("Notification content height must be a positive finite number.");
  }
  if (!Number.isFinite(workAreaHeight) || workAreaHeight <= NOTIFICATION_SCREEN_MARGIN_PX * 2) {
    throw new Error("Notification work area height is invalid.");
  }
  return {
    width:
      presentation.type === "priority"
        ? PRIORITY_NOTIFICATION_WIDTH_PX
        : TRANSIENT_NOTIFICATION_WIDTH_PX,
    height: Math.min(
      Math.ceil(contentHeight),
      Math.floor(workAreaHeight - NOTIFICATION_SCREEN_MARGIN_PX * 2),
    ),
  };
}

export function resolveNotificationOverlayPosition(
  presentation: NotificationPresentation,
  workAreaPosition: Point,
  workAreaSize: Size,
  overlaySize: Size,
): Point {
  if (presentation.type === "priority") {
    return {
      x: Math.round(workAreaPosition.x + (workAreaSize.width - overlaySize.width) / 2),
      y: Math.round(workAreaPosition.y + (workAreaSize.height - overlaySize.height) / 2),
    };
  }

  const left = presentation.position.endsWith("Left");
  const top = presentation.position.startsWith("top");
  return {
    x: Math.round(
      left
        ? workAreaPosition.x + NOTIFICATION_SCREEN_MARGIN_PX
        : workAreaPosition.x +
            workAreaSize.width -
            overlaySize.width -
            NOTIFICATION_SCREEN_MARGIN_PX,
    ),
    y: Math.round(
      top
        ? workAreaPosition.y + NOTIFICATION_SCREEN_MARGIN_PX
        : workAreaPosition.y +
            workAreaSize.height -
            overlaySize.height -
            NOTIFICATION_SCREEN_MARGIN_PX,
    ),
  };
}
