import { describe, expect, it } from "vitest";

import {
  calculateTimelineScrollbar,
  findTimelineAnchorIndex,
  hasRecentTimelineUserScrollIntent,
  isTimelineNearEnd,
  resolveTimelineFollowing,
  resolveTimelineRestorationTop,
  shouldSynchronizeTimelineToEnd,
} from "./timelineScroll";

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

  it("does not detach from the latest message after a layout-driven scroll", () => {
    expect(
      resolveTimelineFollowing({
        followingLatest: true,
        nearEnd: false,
        userInitiated: false,
      }),
    ).toBe(true);
    expect(
      resolveTimelineFollowing({
        followingLatest: true,
        nearEnd: false,
        userInitiated: true,
      }),
    ).toBe(false);
  });

  it("recognizes only recent user scroll input", () => {
    expect(hasRecentTimelineUserScrollIntent(1_000, 1_500)).toBe(true);
    expect(hasRecentTimelineUserScrollIntent(1_000, 1_601)).toBe(false);
    expect(hasRecentTimelineUserScrollIntent(Number.NEGATIVE_INFINITY, 1_000)).toBe(false);
  });

  it("never lets a layout frame fight recent user scroll intent", () => {
    expect(
      shouldSynchronizeTimelineToEnd({
        followingLatest: true,
        layoutRequested: true,
        recentUserIntent: true,
      }),
    ).toBe(false);
    expect(
      shouldSynchronizeTimelineToEnd({
        followingLatest: true,
        layoutRequested: true,
        recentUserIntent: false,
      }),
    ).toBe(true);
  });

  it("restores either the saved viewport or the exact end deterministically", () => {
    expect(
      resolveTimelineRestorationTop({
        followingLatest: false,
        maximumScroll: 1_000,
        savedScrollTop: 320,
      }),
    ).toBe(320);
    expect(
      resolveTimelineRestorationTop({
        followingLatest: false,
        maximumScroll: 200,
        savedScrollTop: 320,
      }),
    ).toBe(200);
    expect(
      resolveTimelineRestorationTop({
        followingLatest: true,
        maximumScroll: 1_000,
        savedScrollTop: 320,
      }),
    ).toBe(1_000);
  });

  it("finds the active message with logarithmic ordered anchor reads", () => {
    const anchorTops = [80, 260, 480, 720, 980, 1_260, 1_580, 1_920];
    let reads = 0;

    const activeIndex = findTimelineAnchorIndex(
      anchorTops.length,
      (index) => {
        reads += 1;
        return anchorTops[index] ?? Number.POSITIVE_INFINITY;
      },
      1_000,
    );

    expect(activeIndex).toBe(4);
    expect(reads).toBeLessThanOrEqual(4);
  });

  it("keeps the first message active before its anchor reaches the viewport", () => {
    expect(findTimelineAnchorIndex(3, (index) => [100, 200, 300][index] ?? 0, 20)).toBe(0);
  });
});
