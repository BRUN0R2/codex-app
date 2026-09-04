import { describe, expect, it } from "vitest";

import {
  decodeNotificationOverlayAction,
  decodeNotificationOverlayPayload,
} from "./notificationOverlay";

const notification = {
  id: "turn:1",
  event: "taskCompleted",
  tone: "success",
  title: "Task completed",
  message: "The task finished successfully.",
  createdAt: 1_800_000_000_000,
  presentation: { type: "transient", durationSeconds: 8, position: "bottomRight" },
  target: { type: "thread", threadId: "thread-1" },
};

describe("notification overlay contracts", () => {
  it("decodes a complete presentation without repairing it", () => {
    expect(decodeNotificationOverlayPayload({ notification, pendingCount: 2 })).toEqual({
      notification,
      pendingCount: 2,
    });
  });

  it("rejects unknown presentation fields and out-of-range durations", () => {
    expect(() =>
      decodeNotificationOverlayPayload({
        notification: {
          ...notification,
          presentation: { ...notification.presentation, durationSeconds: 31 },
        },
        pendingCount: 1,
      }),
    ).toThrow();
    expect(() =>
      decodeNotificationOverlayPayload({
        notification: { ...notification, legacy: true },
        pendingCount: 1,
      }),
    ).toThrow();
  });

  it("rejects payloads whose queue count contradicts the active notification", () => {
    expect(() =>
      decodeNotificationOverlayPayload({ notification: null, pendingCount: 1 }),
    ).toThrow();
    expect(() => decodeNotificationOverlayPayload({ notification, pendingCount: 0 })).toThrow();
  });

  it("decodes only identity-bound overlay actions", () => {
    expect(decodeNotificationOverlayAction({ type: "dismiss", notificationId: "turn:1" })).toEqual({
      type: "dismiss",
      notificationId: "turn:1",
    });
    expect(() => decodeNotificationOverlayAction({ type: "dismiss" })).toThrow();
  });
});
