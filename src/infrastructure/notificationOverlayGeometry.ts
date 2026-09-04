import type { NotificationPresentation } from "../contracts/notificationOverlay";

export const NOTIFICATION_SCREEN_MARGIN_PX = 20;

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Size {
  readonly height: number;
  readonly width: number;
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
