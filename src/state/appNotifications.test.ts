import { describe, expect, it } from "vitest";

import { NOTIFICATION_QUEUE_CAPACITY } from "../contracts/notificationPolicy";
import { DEFAULT_APPLICATION_PREFERENCES } from "./applicationPreferences";
import { createAppNotificationCenter } from "./appNotifications";

const base = {
  approval: null,
  tone: "success" as const,
  title: "Complete",
  message: "The task completed.",
  target: null,
};

describe("app notification center", () => {
  it("resolves presentation from the event preference at enqueue time", () => {
    const center = createAppNotificationCenter(
      () => DEFAULT_APPLICATION_PREFERENCES.notifications,
      () => 1_800_000_000_000,
    );

    expect(center.enqueue({ ...base, id: "done:1", event: "taskCompleted" })).toBe(true);
    expect(center.transient.active()).toMatchObject({
      id: "done:1",
      presentation: { type: "transient", durationSeconds: 8, position: "bottomRight" },
    });
  });

  it("presents priority and transient work concurrently with independent FIFO order", () => {
    const center = createAppNotificationCenter(() => DEFAULT_APPLICATION_PREFERENCES.notifications);
    center.enqueue({ ...base, id: "done:1", event: "taskCompleted" });
    center.enqueue({ ...base, id: "failure:1", event: "taskFailed", tone: "error" });
    center.enqueue({ ...base, id: "failure:2", event: "taskFailed", tone: "error" });

    expect(center.priority.active()?.id).toBe("failure:1");
    expect(center.transient.active()?.id).toBe("done:1");
    expect(center.priority.pendingCount()).toBe(2);
    expect(center.transient.pendingCount()).toBe(1);
    center.dismiss("failure:1");
    expect(center.priority.active()?.id).toBe("failure:2");
    expect(center.transient.active()?.id).toBe("done:1");
    center.dismiss("failure:2");
    expect(center.priority.active()).toBeNull();
    expect(center.transient.active()?.id).toBe("done:1");
  });

  it("deduplicates identities and honors disabled event rules", () => {
    const center = createAppNotificationCenter(() => ({
      ...DEFAULT_APPLICATION_PREFERENCES.notifications,
      events: {
        ...DEFAULT_APPLICATION_PREFERENCES.notifications.events,
        taskCompleted: { enabled: false, priority: false },
      },
    }));

    expect(center.enqueue({ ...base, id: "done:1", event: "taskCompleted" })).toBe(false);
    expect(center.enqueue({ ...base, id: "failure:1", event: "taskFailed" })).toBe(true);
    center.dismiss("failure:1");
    expect(center.enqueue({ ...base, id: "failure:1", event: "taskFailed" })).toBe(false);
  });

  it("previews a disabled event with its configured presentation", () => {
    const center = createAppNotificationCenter(() => ({
      ...DEFAULT_APPLICATION_PREFERENCES.notifications,
      enabled: false,
      transientDurationSeconds: 17,
      transientPosition: "topLeft" as const,
      events: {
        ...DEFAULT_APPLICATION_PREFERENCES.notifications.events,
        taskCompleted: { enabled: false, priority: false },
      },
    }));

    expect(center.preview({ ...base, id: "preview:done:1", event: "taskCompleted" })).toBe(true);
    expect(center.transient.active()).toMatchObject({
      id: "preview:done:1",
      presentation: { type: "transient", durationSeconds: 17, position: "topLeft" },
    });
  });

  it("presents settings feedback as a basic transient notification", () => {
    const center = createAppNotificationCenter(() => ({
      ...DEFAULT_APPLICATION_PREFERENCES.notifications,
      events: {
        ...DEFAULT_APPLICATION_PREFERENCES.notifications.events,
        taskCompleted: { enabled: true, priority: true },
      },
    }));

    expect(center.enqueue({ ...base, id: "settings:1", event: "settingsSaved" })).toBe(true);
    expect(center.transient.active()?.presentation).toEqual({
      type: "transient",
      durationSeconds: 8,
      position: "bottomRight",
    });
  });

  it("reports saturation instead of remembering notifications that were not queued", () => {
    const center = createAppNotificationCenter(() => DEFAULT_APPLICATION_PREFERENCES.notifications);
    for (let index = 0; index < NOTIFICATION_QUEUE_CAPACITY; index += 1) {
      expect(
        center.enqueue({
          ...base,
          id: `failure:${index}`,
          event: "taskFailed",
          tone: "error",
        }),
      ).toBe(true);
    }

    expect(
      center.enqueue({ ...base, id: "failure:overflow", event: "taskFailed", tone: "error" }),
    ).toBe(false);
    center.dismiss("failure:0");
    expect(
      center.enqueue({ ...base, id: "failure:overflow", event: "taskFailed", tone: "error" }),
    ).toBe(true);
  });

  it("does not let a saturated priority lane suppress transient delivery", () => {
    const center = createAppNotificationCenter(() => DEFAULT_APPLICATION_PREFERENCES.notifications);
    for (let index = 0; index < NOTIFICATION_QUEUE_CAPACITY; index += 1) {
      expect(
        center.enqueue({
          ...base,
          id: `failure:${index}`,
          event: "taskFailed",
          tone: "error",
        }),
      ).toBe(true);
    }

    expect(center.enqueue({ ...base, id: "done:1", event: "taskCompleted" })).toBe(true);
    expect(center.priority.pendingCount()).toBe(NOTIFICATION_QUEUE_CAPACITY);
    expect(center.transient.active()?.id).toBe("done:1");
  });

  it("retains and removes an identity-bound approval independently of its task card", () => {
    const center = createAppNotificationCenter(() => DEFAULT_APPLICATION_PREFERENCES.notifications);
    const approval = {
      id: "approval-1",
      method: "approval.command",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "pnpm verify",
        cwd: "D:\\workspace",
        reason: "Verify the change",
      },
    } as const;
    expect(
      center.enqueue({
        ...base,
        approval,
        id: "approval-required:approval-1",
        event: "approvalRequired",
        target: { type: "thread", threadId: "thread-1" },
      }),
    ).toBe(true);

    expect(center.approvalFor("approval-required:approval-1")).toEqual(approval);
    expect(center.remove("approval-required:approval-1")).toBe(true);
    expect(center.priority.active()).toBeNull();
    expect(center.remove("approval-required:approval-1")).toBe(false);
  });
});
