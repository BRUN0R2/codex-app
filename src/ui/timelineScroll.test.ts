import { describe, expect, it } from "vitest";

import {
  calculateTimelineScrollbar,
  findTimelineAnchorIndex,
  hasReachedTimelineWheelHandoffTarget,
  isTimelineNearEnd,
  normalizeTimelineWheelDelta,
  resolveNestedTimelineWheelTransfer,
  resolveTimelineAnchorCorrection,
  resolveTimelineFollowing,
  resolveTimelineMessageOffset,
  resolveTimelineRestorationTop,
  resolveTimelineWheelHandoffTarget,
  shouldMeasureTimelineScrollAsUserInitiated,
  shouldPreserveTimelineAnchor,
  shouldSynchronizeTimelineToEnd,
  TimelineProgrammaticScrollTracker,
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

  it("does not classify layout anchoring as user scroll without explicit input", () => {
    expect(
      shouldMeasureTimelineScrollAsUserInitiated({
        explicitUserInput: false,
        layoutRequested: true,
        unownedScroll: true,
      }),
    ).toBe(false);
    expect(
      shouldMeasureTimelineScrollAsUserInitiated({
        explicitUserInput: true,
        layoutRequested: true,
        unownedScroll: true,
      }),
    ).toBe(true);
    expect(
      shouldMeasureTimelineScrollAsUserInitiated({
        explicitUserInput: false,
        layoutRequested: false,
        unownedScroll: true,
      }),
    ).toBe(true);
  });

  it("synchronizes layout changes only while following the latest content", () => {
    expect(
      shouldSynchronizeTimelineToEnd({
        followingLatest: true,
        layoutRequested: true,
      }),
    ).toBe(true);
    expect(
      shouldSynchronizeTimelineToEnd({
        followingLatest: false,
        layoutRequested: true,
      }),
    ).toBe(false);
  });

  it("preserves the visual anchor during manual scroll but not during navigation", () => {
    expect(
      shouldPreserveTimelineAnchor({
        anchorDelta: 240,
        followingLatest: false,
        programmaticNavigationActive: false,
      }),
    ).toBe(true);
    expect(
      shouldPreserveTimelineAnchor({
        anchorDelta: 240,
        followingLatest: false,
        programmaticNavigationActive: true,
      }),
    ).toBe(false);
    expect(
      shouldPreserveTimelineAnchor({
        anchorDelta: 240,
        followingLatest: true,
        programmaticNavigationActive: false,
      }),
    ).toBe(false);
  });

  it("adds layout compensation to the user's latest position instead of stale input", () => {
    expect(
      resolveTimelineAnchorCorrection({
        currentScrollTop: 180,
        nextAnchorOffset: 720,
        previousAnchorOffset: 400,
      }),
    ).toBe(500);
  });

  it("classifies programmatic scroll by explicit target rather than elapsed time", () => {
    const tracker = new TimelineProgrammaticScrollTracker();

    tracker.begin("instant", 320);
    expect(tracker.consume(320)).toBe(true);
    expect(tracker.consume(280)).toBe(false);

    tracker.begin("smooth", 900);
    expect(tracker.smoothActive()).toBe(true);
    expect(tracker.consume(540)).toBe(true);
    expect(tracker.consume(900)).toBe(true);
    expect(tracker.smoothActive()).toBe(false);

    tracker.begin("smooth", 1_200);
    tracker.cancel();
    expect(tracker.consume(1_000)).toBe(false);
  });

  it("normalizes pixel, line, and page wheel deltas", () => {
    expect(normalizeTimelineWheelDelta({ deltaMode: 0, deltaY: -12, viewportHeight: 800 })).toBe(
      -12,
    );
    expect(normalizeTimelineWheelDelta({ deltaMode: 1, deltaY: 3, viewportHeight: 800 })).toBe(48);
    expect(normalizeTimelineWheelDelta({ deltaMode: 2, deltaY: -1, viewportHeight: 720 })).toBe(
      -720,
    );
  });

  it("leaves wheel movement that fits inside a nested viewport to the native scroller", () => {
    expect(
      resolveNestedTimelineWheelTransfer({
        clientHeight: 200,
        delta: -80,
        scrollHeight: 1_000,
        scrollTop: 400,
      }),
    ).toBeNull();
  });

  it("transfers only the exact nested wheel overflow to the timeline", () => {
    expect(
      resolveNestedTimelineWheelTransfer({
        clientHeight: 200,
        delta: -100,
        scrollHeight: 1_000,
        scrollTop: 40,
      }),
    ).toEqual({ nestedScrollTop: 0, timelineDelta: -60 });
    expect(
      resolveNestedTimelineWheelTransfer({
        clientHeight: 200,
        delta: 90,
        scrollHeight: 1_000,
        scrollTop: 760,
      }),
    ).toEqual({ nestedScrollTop: 800, timelineDelta: 50 });
  });

  it("routes the whole wheel delta when nested content has no vertical range", () => {
    expect(
      resolveNestedTimelineWheelTransfer({
        clientHeight: 200,
        delta: -120,
        scrollHeight: 200,
        scrollTop: 0,
      }),
    ).toEqual({ nestedScrollTop: 0, timelineDelta: -120 });
  });

  it("ignores only a wheel event with no vertical movement", () => {
    expect(
      resolveNestedTimelineWheelTransfer({
        clientHeight: 200,
        delta: 0,
        scrollHeight: 1_000,
        scrollTop: 400,
      }),
    ).toBeNull();
  });

  it("accumulates smooth handoff deltas against the pending destination", () => {
    expect(
      resolveTimelineWheelHandoffTarget({
        currentScrollTop: 100,
        delta: 40,
        maximumScroll: 500,
        pendingTarget: null,
      }),
    ).toBe(140);
    expect(
      resolveTimelineWheelHandoffTarget({
        currentScrollTop: 112,
        delta: 40,
        maximumScroll: 500,
        pendingTarget: 140,
      }),
    ).toBe(180);
  });

  it("clamps a pending smooth handoff after the timeline range changes", () => {
    expect(
      resolveTimelineWheelHandoffTarget({
        currentScrollTop: 480,
        delta: 80,
        maximumScroll: 500,
        pendingTarget: 560,
      }),
    ).toBe(500);
    expect(
      resolveTimelineWheelHandoffTarget({
        currentScrollTop: 20,
        delta: -80,
        maximumScroll: 500,
        pendingTarget: null,
      }),
    ).toBe(0);
  });

  it("reverses from the current position instead of a stale smooth destination", () => {
    expect(
      resolveTimelineWheelHandoffTarget({
        currentScrollTop: 112,
        delta: -40,
        maximumScroll: 500,
        pendingTarget: 180,
      }),
    ).toBe(72);
    expect(
      resolveTimelineWheelHandoffTarget({
        currentScrollTop: 112,
        delta: 0,
        maximumScroll: 500,
        pendingTarget: 180,
      }),
    ).toBe(112);
  });

  it("ignores stale scrollend events until a wheel handoff reaches its destination", () => {
    expect(
      hasReachedTimelineWheelHandoffTarget({
        currentScrollTop: 320,
        maximumScroll: 1_000,
        target: 260,
      }),
    ).toBe(false);
    expect(
      hasReachedTimelineWheelHandoffTarget({
        currentScrollTop: 260.5,
        maximumScroll: 1_000,
        target: 260,
      }),
    ).toBe(true);
    expect(
      hasReachedTimelineWheelHandoffTarget({
        currentScrollTop: 800,
        maximumScroll: 800,
        target: 900,
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

  it("uses the current message anchor instead of the turn start after expansion", () => {
    expect(resolveTimelineMessageOffset(780, 120)).toBe(780);
    expect(resolveTimelineMessageOffset(null, 120)).toBe(120);
    expect(() => resolveTimelineMessageOffset(-1, 120)).toThrow("Mounted timeline message offset");
  });
});
