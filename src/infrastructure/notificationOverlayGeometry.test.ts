import { describe, expect, it } from "vitest";

import type { NotificationPresentation } from "../contracts/notificationOverlay";
import {
  resolveNotificationOverlayPosition,
  resolveNotificationOverlaySize,
} from "./notificationOverlayGeometry";

const workAreaPosition = { x: -1_920, y: 0 };
const workAreaSize = { width: 1_920, height: 1_080 };

describe("notification overlay geometry", () => {
  it("sizes each channel to intrinsic content without reserving unused height", () => {
    expect(resolveNotificationOverlaySize({ type: "priority" }, 237.2, 1_080)).toEqual({
      width: 460,
      height: 238,
    });
    expect(
      resolveNotificationOverlaySize(
        { type: "transient", durationSeconds: 8, position: "bottomRight" },
        91,
        1_080,
      ),
    ).toEqual({ width: 390, height: 91 });
  });

  it("bounds tall content to the selected monitor work area", () => {
    expect(resolveNotificationOverlaySize({ type: "priority" }, 2_000, 1_080)).toEqual({
      width: 460,
      height: 1_040,
    });
    expect(() => resolveNotificationOverlaySize({ type: "priority" }, 0, 1_080)).toThrow(
      "positive finite",
    );
  });

  it("centers priority notifications on the selected monitor", () => {
    expect(
      resolveNotificationOverlayPosition({ type: "priority" }, workAreaPosition, workAreaSize, {
        width: 460,
        height: 180,
      }),
    ).toEqual({ x: -1_190, y: 450 });
  });

  it.each([
    ["topLeft", { x: -1_900, y: 20 }],
    ["topRight", { x: -410, y: 20 }],
    ["bottomLeft", { x: -1_900, y: 940 }],
    ["bottomRight", { x: -410, y: 940 }],
  ] as const)("anchors transient notifications at %s", (position, expected) => {
    const presentation: NotificationPresentation = {
      type: "transient",
      durationSeconds: 8,
      position,
    };
    expect(
      resolveNotificationOverlayPosition(presentation, workAreaPosition, workAreaSize, {
        width: 390,
        height: 120,
      }),
    ).toEqual(expected);
  });
});
