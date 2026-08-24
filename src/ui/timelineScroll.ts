const TIMELINE_END_THRESHOLD_PX = 24;
const SCROLLBAR_MIN_THUMB_PX = 84;
const SCROLLBAR_OVERFLOW_EPSILON_PX = 2;
const TIMELINE_PROGRAMMATIC_SCROLL_EPSILON_PX = 1;
const TIMELINE_WHEEL_LINE_PX = 16;
const TIMELINE_WHEEL_TRANSFER_EPSILON_PX = 0.5;
const TIMELINE_WHEEL_DELTA_MODE_LINE = 1;
const TIMELINE_WHEEL_DELTA_MODE_PAGE = 2;

export type TimelineProgrammaticScrollKind = "instant" | "smooth";

export interface NestedTimelineWheelTransfer {
  readonly nestedScrollTop: number;
  readonly timelineDelta: number;
}

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

export function resolveTimelineFollowing(input: {
  readonly followingLatest: boolean;
  readonly nearEnd: boolean;
  readonly userInitiated: boolean;
}): boolean {
  return input.userInitiated ? input.nearEnd : input.followingLatest;
}

export function shouldMeasureTimelineScrollAsUserInitiated(input: {
  readonly explicitUserInput: boolean;
  readonly layoutRequested: boolean;
  readonly unownedScroll: boolean;
}): boolean {
  return input.explicitUserInput || (input.unownedScroll && !input.layoutRequested);
}

export function shouldSynchronizeTimelineToEnd(input: {
  readonly followingLatest: boolean;
  readonly layoutRequested: boolean;
}): boolean {
  return input.layoutRequested && input.followingLatest;
}

export function shouldPreserveTimelineAnchor(input: {
  readonly anchorDelta: number;
  readonly followingLatest: boolean;
  readonly programmaticNavigationActive: boolean;
}): boolean {
  return input.anchorDelta !== 0 && !input.followingLatest && !input.programmaticNavigationActive;
}

export function resolveTimelineAnchorCorrection(input: {
  readonly currentScrollTop: number;
  readonly nextAnchorOffset: number;
  readonly previousAnchorOffset: number;
}): number {
  if (
    !Number.isFinite(input.currentScrollTop) ||
    input.currentScrollTop < 0 ||
    !Number.isFinite(input.nextAnchorOffset) ||
    !Number.isFinite(input.previousAnchorOffset)
  ) {
    throw new Error("Timeline anchor correction requires finite non-negative scroll metrics.");
  }
  return Math.max(0, input.currentScrollTop + input.nextAnchorOffset - input.previousAnchorOffset);
}

export class TimelineProgrammaticScrollTracker {
  #pending: { readonly kind: TimelineProgrammaticScrollKind; readonly target: number } | null =
    null;

  begin(kind: TimelineProgrammaticScrollKind, target: number): void {
    if (!Number.isFinite(target) || target < 0) {
      throw new Error("Timeline programmatic scroll target must be a non-negative finite number.");
    }
    this.#pending = { kind, target };
  }

  cancel(): void {
    this.#pending = null;
  }

  consume(scrollTop: number): boolean {
    if (!Number.isFinite(scrollTop) || scrollTop < 0) {
      throw new Error("Timeline scroll position must be a non-negative finite number.");
    }
    const pending = this.#pending;
    if (pending === null) {
      return false;
    }
    const reachedTarget =
      Math.abs(scrollTop - pending.target) <= TIMELINE_PROGRAMMATIC_SCROLL_EPSILON_PX;
    if (pending.kind === "instant" || reachedTarget) {
      this.#pending = null;
    }
    return pending.kind === "smooth" || reachedTarget;
  }

  finish(): void {
    this.#pending = null;
  }

  smoothActive(): boolean {
    return this.#pending?.kind === "smooth";
  }
}

export function normalizeTimelineWheelDelta(input: {
  readonly deltaMode: number;
  readonly deltaY: number;
  readonly viewportHeight: number;
}): number {
  if (!Number.isFinite(input.deltaY)) {
    throw new Error("Timeline wheel delta must be finite.");
  }
  if (!Number.isFinite(input.viewportHeight) || input.viewportHeight < 0) {
    throw new Error("Timeline wheel viewport height must be a non-negative finite number.");
  }
  switch (input.deltaMode) {
    case TIMELINE_WHEEL_DELTA_MODE_LINE:
      return input.deltaY * TIMELINE_WHEEL_LINE_PX;
    case TIMELINE_WHEEL_DELTA_MODE_PAGE:
      return input.deltaY * input.viewportHeight;
    default:
      return input.deltaY;
  }
}

export function resolveNestedTimelineWheelTransfer(input: {
  readonly clientHeight: number;
  readonly delta: number;
  readonly scrollHeight: number;
  readonly scrollTop: number;
}): NestedTimelineWheelTransfer | null {
  if (
    !Number.isFinite(input.clientHeight) ||
    input.clientHeight < 0 ||
    !Number.isFinite(input.delta) ||
    !Number.isFinite(input.scrollHeight) ||
    input.scrollHeight < 0 ||
    !Number.isFinite(input.scrollTop)
  ) {
    throw new Error(
      "Nested timeline scroll metrics must be finite and heights must be non-negative.",
    );
  }
  if (Math.abs(input.delta) <= TIMELINE_WHEEL_TRANSFER_EPSILON_PX) {
    return null;
  }
  const maximumScroll = Math.max(0, input.scrollHeight - input.clientHeight);
  const scrollTop = Math.min(maximumScroll, Math.max(0, input.scrollTop));
  const desiredScrollTop = scrollTop + input.delta;
  const nestedScrollTop = Math.min(maximumScroll, Math.max(0, desiredScrollTop));
  const timelineDelta = desiredScrollTop - nestedScrollTop;
  return Math.abs(timelineDelta) <= TIMELINE_WHEEL_TRANSFER_EPSILON_PX
    ? null
    : { nestedScrollTop, timelineDelta };
}

export function resolveTimelineWheelHandoffTarget(input: {
  readonly currentScrollTop: number;
  readonly delta: number;
  readonly maximumScroll: number;
  readonly pendingTarget: number | null;
}): number {
  if (
    !Number.isFinite(input.currentScrollTop) ||
    input.currentScrollTop < 0 ||
    !Number.isFinite(input.delta) ||
    !Number.isFinite(input.maximumScroll) ||
    input.maximumScroll < 0 ||
    (input.pendingTarget !== null &&
      (!Number.isFinite(input.pendingTarget) || input.pendingTarget < 0))
  ) {
    throw new Error(
      "Timeline wheel handoff requires finite metrics and non-negative scroll positions.",
    );
  }
  const currentScrollTop = Math.min(input.maximumScroll, input.currentScrollTop);
  if (Math.abs(input.delta) <= TIMELINE_WHEEL_TRANSFER_EPSILON_PX) {
    return currentScrollTop;
  }
  const pendingTarget =
    input.pendingTarget === null ? null : Math.min(input.maximumScroll, input.pendingTarget);
  const pendingDelta = pendingTarget === null ? 0 : pendingTarget - currentScrollTop;
  const continuesPendingDirection =
    pendingTarget !== null &&
    (Math.abs(pendingDelta) <= TIMELINE_WHEEL_TRANSFER_EPSILON_PX ||
      Math.sign(pendingDelta) === Math.sign(input.delta));
  const origin = continuesPendingDirection ? pendingTarget : currentScrollTop;
  return Math.min(input.maximumScroll, Math.max(0, origin + input.delta));
}

export function resolveTimelineRestorationTop(input: {
  readonly followingLatest: boolean;
  readonly maximumScroll: number;
  readonly savedScrollTop: number;
}): number {
  if (!Number.isFinite(input.maximumScroll) || input.maximumScroll < 0) {
    throw new Error("Timeline maximum scroll must be a non-negative finite number.");
  }
  if (!Number.isFinite(input.savedScrollTop) || input.savedScrollTop < 0) {
    throw new Error("Timeline saved scroll position must be a non-negative finite number.");
  }
  return input.followingLatest
    ? input.maximumScroll
    : Math.min(input.maximumScroll, input.savedScrollTop);
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

export function resolveTimelineMessageOffset(
  mountedMessageOffset: number | null,
  estimatedTurnOffset: number,
): number {
  if (!Number.isFinite(estimatedTurnOffset) || estimatedTurnOffset < 0) {
    throw new Error("Timeline turn offset must be a non-negative finite number.");
  }
  if (mountedMessageOffset === null) {
    return estimatedTurnOffset;
  }
  if (!Number.isFinite(mountedMessageOffset) || mountedMessageOffset < 0) {
    throw new Error("Mounted timeline message offset must be a non-negative finite number.");
  }
  return mountedMessageOffset;
}
