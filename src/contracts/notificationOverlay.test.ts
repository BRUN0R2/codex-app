import { describe, expect, it } from "vitest";

import {
  decodeNotificationOverlayAction,
  decodeNotificationOverlayApprovalResult,
  decodeNotificationOverlayPayload,
} from "./notificationOverlay";

const notification = {
  id: "turn:1",
  event: "taskCompleted",
  tone: "success",
  title: "Task completed",
  message: "The task finished successfully.",
  createdAt: 1_800_000_000_000,
  approval: null,
  presentation: { type: "transient", durationSeconds: 8, position: "bottomRight" },
  target: { type: "thread", threadId: "thread-1" },
};

describe("notification overlay contracts", () => {
  it("decodes a complete presentation without repairing it", () => {
    expect(
      decodeNotificationOverlayPayload({ channel: "transient", notification, pendingCount: 2 }),
    ).toEqual({
      channel: "transient",
      notification,
      pendingCount: 2,
    });
  });

  it("rejects unknown presentation fields and out-of-range durations", () => {
    expect(() =>
      decodeNotificationOverlayPayload({
        channel: "transient",
        notification: {
          ...notification,
          presentation: { ...notification.presentation, durationSeconds: 31 },
        },
        pendingCount: 1,
      }),
    ).toThrow();
    expect(() =>
      decodeNotificationOverlayPayload({
        channel: "transient",
        notification: { ...notification, legacy: true },
        pendingCount: 1,
      }),
    ).toThrow();
  });

  it("rejects payloads whose queue count contradicts the active notification", () => {
    expect(() =>
      decodeNotificationOverlayPayload({
        channel: "transient",
        notification: null,
        pendingCount: 1,
      }),
    ).toThrow();
    expect(() =>
      decodeNotificationOverlayPayload({ channel: "transient", notification, pendingCount: 0 }),
    ).toThrow();
  });

  it("rejects a notification projected into the other presentation channel", () => {
    expect(() =>
      decodeNotificationOverlayPayload({ channel: "priority", notification, pendingCount: 1 }),
    ).toThrow("presentation must match");
  });

  it("decodes only identity-bound overlay actions", () => {
    expect(
      decodeNotificationOverlayAction({
        type: "dismiss",
        channel: "transient",
        notificationId: "turn:1",
      }),
    ).toEqual({ type: "dismiss", channel: "transient", notificationId: "turn:1" });
    expect(() => decodeNotificationOverlayAction({ type: "dismiss" })).toThrow();
  });

  it("decodes approval responses and their asynchronous result", () => {
    expect(
      decodeNotificationOverlayAction({
        type: "respondToApproval",
        channel: "priority",
        decision: "acceptForSession",
        notificationId: "approval-required:approval-1",
        requestId: "approval-1",
      }),
    ).toEqual({
      type: "respondToApproval",
      channel: "priority",
      decision: "acceptForSession",
      notificationId: "approval-required:approval-1",
      requestId: "approval-1",
    });
    expect(
      decodeNotificationOverlayApprovalResult({
        channel: "priority",
        notificationId: "approval-required:approval-1",
        requestId: "approval-1",
        succeeded: false,
      }).succeeded,
    ).toBe(false);
  });

  it("requires approval details to retain their owning task", () => {
    const approval = {
      id: "approval-1",
      method: "approval.command",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "pnpm test",
        cwd: "D:\\workspace",
        reason: "Run the tests",
      },
    };
    expect(
      decodeNotificationOverlayPayload({
        channel: "priority",
        notification: {
          ...notification,
          id: "approval-required:approval-1",
          event: "approvalRequired",
          approval,
          presentation: { type: "priority" },
        },
        pendingCount: 1,
      }).notification?.approval,
    ).toEqual(approval);
    expect(() =>
      decodeNotificationOverlayPayload({
        channel: "priority",
        notification: {
          ...notification,
          event: "approvalRequired",
          approval,
          presentation: { type: "priority" },
          target: { type: "thread", threadId: "thread-2" },
        },
        pendingCount: 1,
      }),
    ).toThrow("owning thread");
  });
});
