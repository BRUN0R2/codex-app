const TIMELINE_END_THRESHOLD_PX = 24;
const SCROLLBAR_MIN_THUMB_PX = 84;
const SCROLLBAR_OVERFLOW_EPSILON_PX = 2;

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
