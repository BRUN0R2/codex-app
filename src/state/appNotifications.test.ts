import { describe, expect, it } from "vitest";

import { NOTIFICATION_QUEUE_CAPACITY } from "../contracts/notificationPolicy";
import { DEFAULT_APPLICATION_PREFERENCES } from "./applicationPreferences";
import { createAppNotificationCenter } from "./appNotifications";

const base = {
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
    expect(center.active()).toMatchObject({
      id: "done:1",
      presentation: { type: "transient", durationSeconds: 8, position: "bottomRight" },
    });
  });

  it("places priority work before transient work while preserving FIFO within each class", () => {
    const center = createAppNotificationCenter(() => DEFAULT_APPLICATION_PREFERENCES.notifications);
    center.enqueue({ ...base, id: "done:1", event: "taskCompleted" });
    center.enqueue({ ...base, id: "failure:1", event: "taskFailed", tone: "error" });
    center.enqueue({ ...base, id: "failure:2", event: "taskFailed", tone: "error" });

    expect(center.active()?.id).toBe("failure:1");
    center.dismiss("failure:1");
    expect(center.active()?.id).toBe("failure:2");
    center.dismiss("failure:2");
    expect(center.active()?.id).toBe("done:1");
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
});
