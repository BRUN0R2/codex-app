import type { ScrollbarMetrics } from "./timelineScroll";

export const SCROLLBAR_ARROW_SCROLL_STEP_PX: number = 64;

const SCROLLBAR_MINIMUM_PAGE_STEP_PX: number = 120;
const SCROLLBAR_PAGE_VIEWPORT_FACTOR: number = 0.8;

export function sameScrollbarMetrics(left: ScrollbarMetrics, right: ScrollbarMetrics): boolean {
  return (
    left.maximumScroll === right.maximumScroll &&
    left.scrollable === right.scrollable &&
    left.thumbHeight === right.thumbHeight &&
    left.thumbTop === right.thumbTop
  );
}

export function resolveScrollbarPageScrollAmount(viewportSize: number): number {
  return Math.max(SCROLLBAR_MINIMUM_PAGE_STEP_PX, viewportSize * SCROLLBAR_PAGE_VIEWPORT_FACTOR);
}
