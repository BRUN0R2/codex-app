import { describe, expect, it } from "vitest";

import { calculateTimelineScrollbar, isTimelineNearEnd } from "./timelineScroll";

describe("timeline scroll metrics", () => {
  it("maps the real conversation bottom to the end of the custom track", () => {
    const metrics = calculateTimelineScrollbar({
      clientHeight: 800,
      scrollHeight: 4_000,
      scrollTop: 3_200,
      trackHeight: 792,
    });

    expect(metrics.scrollable).toBe(true);
    expect(metrics.thumbTop + metrics.thumbHeight).toBeCloseTo(792);
    expect(isTimelineNearEnd({ clientHeight: 800, scrollHeight: 4_000, scrollTop: 3_200 })).toBe(
      true,
    );
  });

  it("does not expose a false scrollbar when the content fits", () => {
    const metrics = calculateTimelineScrollbar({
      clientHeight: 800,
      scrollHeight: 801,
      scrollTop: 1,
      trackHeight: 792,
    });

    expect(metrics.maximumScroll).toBe(1);
    expect(metrics.scrollable).toBe(false);
    expect(metrics.thumbTop + metrics.thumbHeight).toBeCloseTo(792);
  });
});
