import { describe, expect, it } from "vitest";

import {
  calculateTimelineScrollbar,
  findTimelineAnchorIndex,
  hasRecentTimelineUserScrollIntent,
  isTimelineNearEnd,
  resolveTimelineFollowing,
  revealExpandedDisclosureScrollTop,
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

  it("makes newly expanded details reachable inside the bounded activity viewport", () => {
    expect(
      revealExpandedDisclosureScrollTop({
        clientHeight: 224,
        detailsBottom: 480,
        detailsTop: 160,
        scrollHeight: 620,
        scrollTop: 120,
        summaryBottom: 250,
        viewportTop: 40,
      }),
    ).toBeCloseTo(259.6);

    expect(
      revealExpandedDisclosureScrollTop({
        clientHeight: 224,
        detailsBottom: 220,
        detailsTop: 80,
        scrollHeight: 620,
        scrollTop: 120,
        summaryBottom: 100,
        viewportTop: 40,
      }),
    ).toBe(120);
  });

  it("revela o painel inteiro quando ele cabe na viewport limitada", () => {
    expect(
      revealExpandedDisclosureScrollTop({
        clientHeight: 224,
        detailsBottom: 505,
        detailsTop: 294,
        scrollHeight: 524,
        scrollTop: 188,
        summaryBottom: 320,
        viewportTop: 248,
      }),
    ).toBe(221);
  });
});
