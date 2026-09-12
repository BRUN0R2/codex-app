import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const tauriConfiguration = decodeRecord(
  JSON.parse(
    readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  ) as unknown,
);
const capability = decodeRecord(
  JSON.parse(
    readFileSync(
      new URL("../src-tauri/capabilities/notification-overlay.json", import.meta.url),
      "utf8",
    ),
  ) as unknown,
);

describe("notification window configuration", () => {
  it("owns one isolated window for each independently visible channel", () => {
    const app = decodeRecord(field(tauriConfiguration, "app"));
    const windows = decodeArray(field(app, "windows")).map(decodeRecord);
    const overlays = windows.filter((window) =>
      String(field(window, "label")).startsWith("notification-"),
    );

    expect(
      overlays.map((window) => ({
        label: field(window, "label"),
        url: field(window, "url"),
        visible: field(window, "visible"),
        alwaysOnTop: field(window, "alwaysOnTop"),
        transparent: field(window, "transparent"),
      })),
    ).toEqual([
      {
        label: "notification-priority-overlay",
        url: "index.html?surface=notification-overlay&channel=priority",
        visible: false,
        alwaysOnTop: true,
        transparent: true,
      },
      {
        label: "notification-transient-overlay",
        url: "index.html?surface=notification-overlay&channel=transient",
        visible: false,
        alwaysOnTop: true,
        transparent: true,
      },
    ]);
  });

  it("grants the same closed permission set to both overlay webviews", () => {
    expect(field(capability, "webviews")).toEqual([
      "notification-priority-overlay",
      "notification-transient-overlay",
    ]);
  });

  it("declares native window monitor lookup instead of center-point geometry reads", () => {
    const permissions = decodeArray(field(capability, "permissions"));
    expect(permissions).toContain("core:window:allow-current-monitor");
    expect(permissions).not.toContain("core:window:allow-monitor-from-point");
    expect(permissions).not.toContain("core:window:allow-outer-position");
    expect(permissions).not.toContain("core:window:allow-outer-size");
  });
});

function decodeRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON object in notification window configuration.");
  }
  return value as Record<string, unknown>;
}

function decodeArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected a JSON array in notification window configuration.");
  }
  return value;
}

function field(object: Readonly<Record<string, unknown>>, key: string): unknown {
  return object[key];
}
