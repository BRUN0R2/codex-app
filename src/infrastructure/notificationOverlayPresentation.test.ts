import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppNotification, NotificationChannel } from "../contracts/notificationOverlay";
import {
  presentNotificationOverlay,
  restoreMainApplicationWindow,
} from "./notificationOverlayClient";

const primaryMonitor = {
  name: "Primary display",
  position: { x: 0, y: 0 },
  size: { width: 1_920, height: 1_080 },
  workArea: {
    position: { x: 0, y: 0 },
    size: { width: 1_920, height: 1_040 },
  },
  scaleFactor: 1,
};
const secondaryMonitor = {
  ...primaryMonitor,
  name: "Secondary display",
  position: { x: -1_920, y: 0 },
  workArea: {
    ...primaryMonitor.workArea,
    position: { x: -1_920, y: 0 },
  },
};

beforeEach(() => vi.stubGlobal("window", {}));
afterEach(() => vi.unstubAllGlobals());

describe("native notification overlay presentation", () => {
  it.each(["priority", "transient"] as const)(
    "keeps the %s notification on the main window's monitor across minimize and restore",
    async (channel) => {
      const overlayLabel = `notification-${channel}-overlay`;
      mockWindows(overlayLabel);
      let minimized = true;
      const invoke = vi.fn<Parameters<typeof mockIPC>[0]>((command, args) => {
        switch (command) {
          case "plugin:window|get_all_windows":
            return ["main", overlayLabel];
          case "plugin:window|outer_position":
            return minimized ? { x: -32_000, y: -32_000 } : { x: -1_800, y: 100 };
          case "plugin:window|outer_size":
            return minimized ? { width: 160, height: 28 } : { width: 1_200, height: 800 };
          case "plugin:window|monitor_from_point":
            return minimized ? null : secondaryMonitor;
          case "plugin:window|current_monitor":
            return args !== undefined && Reflect.get(args, "label") === "main"
              ? secondaryMonitor
              : primaryMonitor;
          case "plugin:window|is_minimized":
            return minimized;
          case "plugin:window|unminimize":
            minimized = false;
            return;
          case "plugin:window|set_size":
          case "plugin:window|set_position":
          case "plugin:window|set_always_on_top":
          case "plugin:window|show":
          case "plugin:window|set_focus":
            return;
          default:
            throw new Error(`Unexpected native command: ${command}`);
        }
      });
      mockIPC(invoke);

      await presentNotificationOverlay(notificationFor(channel), 120, true);
      await restoreMainApplicationWindow();
      expect(minimized).toBe(false);
      await presentNotificationOverlay(notificationFor(channel), 120, true);

      const positions = invoke.mock.calls
        .filter(([command]) => command === "plugin:window|set_position")
        .map(([, args]) => JSON.parse(JSON.stringify(args)) as unknown);
      const expectedPosition = {
        label: overlayLabel,
        value: { Logical: channel === "priority" ? { x: -1_190, y: 460 } : { x: -410, y: 900 } },
      };
      expect(positions).toEqual([expectedPosition, expectedPosition]);
      expect(
        invoke.mock.calls.filter(([command]) => command === "plugin:window|current_monitor"),
      ).toEqual([
        ["plugin:window|current_monitor", { label: "main" }],
        ["plugin:window|current_monitor", { label: "main" }],
      ]);
      for (const command of ["outer_position", "outer_size", "monitor_from_point"]) {
        expect(invoke.mock.calls.some(([name]) => name === `plugin:window|${command}`)).toBe(false);
      }
    },
  );

  it("reads the current native monitor again after the main window moves", async () => {
    mockWindows("notification-transient-overlay");
    const invoke = vi.fn<Parameters<typeof mockIPC>[0]>();
    mockIPC(invoke);
    invoke.mockImplementation((command) =>
      command === "plugin:window|current_monitor" ? secondaryMonitor : undefined,
    );
    await presentNotificationOverlay(notificationFor("transient"), 120, false);

    invoke.mockImplementation((command) =>
      command === "plugin:window|current_monitor" ? primaryMonitor : undefined,
    );
    await presentNotificationOverlay(notificationFor("transient"), 120, false);

    const positions = invoke.mock.calls
      .filter(([command]) => command === "plugin:window|set_position")
      .map(([, args]) => JSON.parse(JSON.stringify(args)) as unknown);
    expect(positions).toEqual([
      { label: "notification-transient-overlay", value: { Logical: { x: -410, y: 900 } } },
      { label: "notification-transient-overlay", value: { Logical: { x: 1_510, y: 900 } } },
    ]);
  });

  it.each([
    ["missing monitor", null, "The monitor containing the main window is unavailable."],
    ["invalid scale", { ...secondaryMonitor, scaleFactor: 0 }, "$.scaleFactor"],
    [
      "invalid work area",
      {
        ...secondaryMonitor,
        workArea: { position: { x: 0, y: 0 }, size: { width: 0, height: 0 } },
      },
      "$.workArea.size",
    ],
  ] as const)("rejects %s before changing the overlay", async (_name, response, message) => {
    mockWindows("notification-transient-overlay");
    const invoke = vi.fn<Parameters<typeof mockIPC>[0]>(() => response);
    mockIPC(invoke);

    await expect(
      presentNotificationOverlay(notificationFor("transient"), 120, false),
    ).rejects.toThrow(message);
    expect(invoke.mock.calls).toEqual([["plugin:window|current_monitor", { label: "main" }]]);
  });

  it("preserves a failed native lookup without substituting another monitor", async () => {
    mockWindows("notification-transient-overlay");
    const failure = new Error("The main window no longer exists.");
    const invoke = vi.fn<Parameters<typeof mockIPC>[0]>(() => {
      throw failure;
    });
    mockIPC(invoke);

    await expect(presentNotificationOverlay(notificationFor("transient"), 120, false)).rejects.toBe(
      failure,
    );
    expect(invoke.mock.calls).toEqual([["plugin:window|current_monitor", { label: "main" }]]);
  });
});

function notificationFor(channel: NotificationChannel): AppNotification {
  return {
    id: "notification-1",
    event: "taskCompleted",
    tone: "success",
    title: "Task completed",
    message: "The task has completed.",
    createdAt: 1,
    approval: null,
    target: null,
    presentation:
      channel === "priority"
        ? { type: "priority" }
        : { type: "transient", durationSeconds: 8, position: "bottomRight" },
  };
}
