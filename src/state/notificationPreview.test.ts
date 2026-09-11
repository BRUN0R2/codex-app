import { describe, expect, it } from "vitest";

import { CONFIGURABLE_NOTIFICATION_EVENT_KINDS } from "../contracts/notificationOverlay";
import { resolveCatalog, translationCatalogs } from "../i18n/catalog";
import { createNotificationPreview } from "./notificationPreview";

const messages = resolveCatalog(translationCatalogs, ["en"]).messages.notifications;

describe("notification previews", () => {
  it("builds a complete localized preview for every configurable event", () => {
    const previews = CONFIGURABLE_NOTIFICATION_EVENT_KINDS.map((event, index) =>
      createNotificationPreview(event, messages, index + 1),
    );

    expect(previews.map((preview) => preview.event)).toEqual(CONFIGURABLE_NOTIFICATION_EVENT_KINDS);
    expect(new Set(previews.map((preview) => preview.id)).size).toBe(previews.length);
    expect(
      previews.every(
        (preview) =>
          preview.title.length > 0 && preview.message.length > 0 && preview.target === null,
      ),
    ).toBe(true);
    expect(previews.find((preview) => preview.event === "taskCompleted")?.tone).toBe("success");
    expect(previews.find((preview) => preview.event === "taskFailed")?.tone).toBe("error");
  });
});
