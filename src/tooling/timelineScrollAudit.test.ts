import { afterEach, describe, expect, it, vi } from "vitest";

import { settleTimelineScrollBeforeMeasurement } from "./timelineScrollAudit";

describe("timeline scroll audit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resets the scroll origin and waits for two settled animation frames", async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const timeline = { scrollTop: 768 } as HTMLElement;

    const settled = settleTimelineScrollBeforeMeasurement(timeline);

    expect(timeline.scrollTop).toBe(0);
    expect(callbacks).toHaveLength(1);
    const advanceFrame = async () => {
      const callback = callbacks.shift();
      expect(callback).toBeDefined();
      callback?.(0);
      await Promise.resolve();
    };

    await advanceFrame();
    expect(callbacks).toHaveLength(1);
    await advanceFrame();
    await expect(settled).resolves.toBeUndefined();
  });
});
