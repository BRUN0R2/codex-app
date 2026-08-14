const TIMELINE_END_THRESHOLD_PX = 24;
const SCROLLBAR_MIN_THUMB_PX = 84;
const SCROLLBAR_OVERFLOW_EPSILON_PX = 2;
const TIMELINE_USER_SCROLL_INTENT_WINDOW_MS = 600;

export interface ScrollbarMetrics {
  readonly maximumScroll: number;
  readonly scrollable: boolean;
  readonly thumbHeight: number;
  readonly thumbTop: number;
}

export function calculateTimelineScrollbar(input: {
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly trackHeight: number;
}): ScrollbarMetrics {
  const clientHeight = Math.max(0, input.clientHeight);
  const scrollHeight = Math.max(clientHeight, input.scrollHeight);
  const trackHeight = Math.max(0, input.trackHeight);
  const maximumScroll = Math.max(0, scrollHeight - clientHeight);
  const thumbHeight =
    maximumScroll === 0 || trackHeight === 0
      ? trackHeight
      : Math.min(
          trackHeight,
          Math.max(SCROLLBAR_MIN_THUMB_PX, (trackHeight * clientHeight) / scrollHeight),
        );
  const maximumThumbTop = Math.max(0, trackHeight - thumbHeight);
  const scrollTop = Math.min(maximumScroll, Math.max(0, input.scrollTop));
  return {
    maximumScroll,
    scrollable: maximumScroll > SCROLLBAR_OVERFLOW_EPSILON_PX && maximumThumbTop > 0,
    thumbHeight,
    thumbTop: maximumScroll === 0 ? 0 : (scrollTop / maximumScroll) * maximumThumbTop,
  };
}

export function isTimelineNearEnd(input: {
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly scrollTop: number;
}): boolean {
  const distanceToEnd = Math.max(0, input.scrollHeight - input.clientHeight - input.scrollTop);
  return distanceToEnd <= TIMELINE_END_THRESHOLD_PX;
}

export function hasRecentTimelineUserScrollIntent(
  lastUserScrollIntentAt: number,
  now: number,
): boolean {
  return (
    Number.isFinite(lastUserScrollIntentAt) &&
    now >= lastUserScrollIntentAt &&
    now - lastUserScrollIntentAt <= TIMELINE_USER_SCROLL_INTENT_WINDOW_MS
  );
}

export function resolveTimelineFollowing(input: {
  readonly followingLatest: boolean;
  readonly nearEnd: boolean;
  readonly userInitiated: boolean;
}): boolean {
  return input.userInitiated ? input.nearEnd : input.followingLatest;
}

export function findTimelineAnchorIndex(
  anchorCount: number,
  readAnchorTop: (index: number) => number,
  viewportTop: number,
): number {
  if (anchorCount <= 1) {
    return 0;
  }

  let lowerBound = 0;
  let upperBound = anchorCount - 1;
  let activeIndex = 0;
  while (lowerBound <= upperBound) {
    const midpoint = lowerBound + Math.floor((upperBound - lowerBound) / 2);
    if (readAnchorTop(midpoint) <= viewportTop) {
      activeIndex = midpoint;
      lowerBound = midpoint + 1;
    } else {
      upperBound = midpoint - 1;
    }
  }
  return activeIndex;
}

export function revealExpandedDisclosureScrollTop(input: {
  readonly clientHeight: number;
  readonly detailsBottom: number;
  readonly detailsTop: number;
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly summaryBottom: number;
  readonly viewportTop: number;
}): number {
  const clientHeight = Math.max(0, input.clientHeight);
  const maximumScroll = Math.max(0, input.scrollHeight - clientHeight);
  const currentScroll = Math.min(maximumScroll, Math.max(0, input.scrollTop));
  const previewHeight = Math.max(120, clientHeight * 0.65);
  const detailsHeight = Math.max(0, input.detailsBottom - input.detailsTop);
  const fitsInsideViewport = detailsHeight <= clientHeight;
  const desiredBottom = fitsInsideViewport
    ? input.detailsBottom
    : Math.min(input.detailsBottom, input.summaryBottom + previewHeight);
  const availableBottom = input.viewportTop + clientHeight - (fitsInsideViewport ? 0 : 8);
  const hiddenPixels = Math.max(0, desiredBottom - availableBottom);
  return Math.min(maximumScroll, currentScroll + hiddenPixels);
}
