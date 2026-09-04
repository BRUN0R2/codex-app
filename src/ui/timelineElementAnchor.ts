import { observeElementResize } from "./elementResize";
import { resolveTimelineElementAnchorScrollTop } from "./timelineScroll";

const TIMELINE_ELEMENT_ANCHOR_DURATION_MS = 250;
const TIMELINE_ELEMENT_ANCHOR_EPSILON_PX = 0.5;
const TIMELINE_VIRTUAL_TURN_SELECTOR = ".timeline-virtual-item[data-virtual-turn-id]";

export function preserveTimelineElementPosition(
  scrollElement: HTMLElement,
  anchorElement: HTMLElement,
): () => void {
  if (!scrollElement.contains(anchorElement)) {
    throw new Error("The timeline anchor must belong to its scroll surface.");
  }

  const scrollBounds = scrollElement.getBoundingClientRect();
  const capturedAnchorOffset = anchorElement.getBoundingClientRect().top - scrollBounds.top;
  let active = true;
  let animationFrame: number | undefined;
  let releaseTimer: number | undefined;
  let releaseResizeObservation: (() => void) | undefined;

  const release = () => {
    if (!active) {
      return;
    }
    active = false;
    if (animationFrame !== undefined) {
      cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
    }
    if (releaseTimer !== undefined) {
      window.clearTimeout(releaseTimer);
      releaseTimer = undefined;
    }
    releaseResizeObservation?.();
    releaseResizeObservation = undefined;
  };

  const correct = () => {
    if (!active) {
      return;
    }
    if (!anchorElement.isConnected) {
      release();
      return;
    }
    const currentScrollTop = scrollElement.scrollTop;
    const targetScrollTop = resolveTimelineElementAnchorScrollTop({
      capturedAnchorOffset,
      capturedScrollTop: currentScrollTop,
      currentAnchorOffset:
        anchorElement.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top,
      currentScrollTop,
    });
    if (
      targetScrollTop !== null &&
      Math.abs(targetScrollTop - currentScrollTop) > TIMELINE_ELEMENT_ANCHOR_EPSILON_PX
    ) {
      scrollElement.scrollTop = targetScrollTop;
    }
  };

  const scheduleCorrection = () => {
    if (!active || animationFrame !== undefined) {
      return;
    }
    animationFrame = requestAnimationFrame(() => {
      animationFrame = undefined;
      correct();
    });
  };

  const handleResize = () => {
    if (animationFrame !== undefined) {
      cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
    }
    correct();
    scheduleCorrection();
  };

  const virtualTurn = anchorElement.closest(TIMELINE_VIRTUAL_TURN_SELECTOR);
  if (virtualTurn !== null) {
    releaseResizeObservation = observeElementResize(virtualTurn, handleResize);
  }
  scheduleCorrection();
  releaseTimer = window.setTimeout(release, TIMELINE_ELEMENT_ANCHOR_DURATION_MS);
  return release;
}
