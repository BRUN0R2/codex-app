import { createSignal, onCleanup, onMount } from "solid-js";
import { useI18n } from "../i18n/context";
import { formatMessage } from "../i18n/messages";
import {
  resolveScrollbarPageScrollAmount,
  SCROLLBAR_ARROW_SCROLL_STEP_PX,
  sameScrollbarMetrics,
} from "./scrollCommands";
import { calculateTimelineScrollbar, type ScrollbarMetrics } from "./timelineScroll";

const EMPTY_SCROLLBAR: ScrollbarMetrics = {
  maximumScroll: 0,
  scrollable: false,
  thumbHeight: 0,
  thumbTop: 0,
};

export function SurfaceScrollbar(props: {
  readonly className?: string | undefined;
  readonly contentElement?: (() => HTMLElement | undefined) | undefined;
  readonly controls: string;
  readonly label: string;
  readonly scrollElement: () => HTMLElement | undefined;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().common;
  let trackElement: HTMLDivElement | undefined;
  let thumbElement: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let measurementFrame: number | undefined;
  let dragState:
    | { readonly pointerId: number; readonly startScrollTop: number; readonly startY: number }
    | undefined;
  const [scrollbar, setScrollbar] = createSignal<ScrollbarMetrics>(EMPTY_SCROLLBAR);

  function measure(): void {
    measurementFrame = undefined;
    const scrollElement = props.scrollElement();
    if (scrollElement === undefined) {
      setScrollbar(EMPTY_SCROLLBAR);
      return;
    }
    const next = calculateTimelineScrollbar({
      clientHeight: scrollElement.clientHeight,
      scrollHeight: scrollElement.scrollHeight,
      scrollTop: scrollElement.scrollTop,
      trackHeight: trackElement?.clientHeight ?? 0,
    });
    setScrollbar((current) => (sameScrollbarMetrics(current, next) ? current : next));
  }

  function scheduleMeasurement(): void {
    if (measurementFrame !== undefined) {
      return;
    }
    measurementFrame = window.requestAnimationFrame(measure);
  }

  function setScrollTopFromThumb(thumbTop: number): void {
    const scrollElement = props.scrollElement();
    if (scrollElement === undefined || trackElement === undefined) {
      return;
    }
    const metrics = scrollbar();
    const maximumThumbTop = Math.max(0, trackElement.clientHeight - metrics.thumbHeight);
    scrollElement.scrollTop =
      maximumThumbTop === 0
        ? 0
        : (Math.min(maximumThumbTop, Math.max(0, thumbTop)) / maximumThumbTop) *
          metrics.maximumScroll;
    scheduleMeasurement();
  }

  function scrollBy(delta: number): void {
    props.scrollElement()?.scrollBy({ top: delta });
    scheduleMeasurement();
  }

  function handleTrackPointerDown(event: PointerEvent): void {
    if (event.target === thumbElement || trackElement === undefined || !scrollbar().scrollable) {
      return;
    }
    const track = trackElement.getBoundingClientRect();
    setScrollTopFromThumb(event.clientY - track.top - scrollbar().thumbHeight / 2);
  }

  function handleThumbPointerDown(event: PointerEvent): void {
    const scrollElement = props.scrollElement();
    if (scrollElement === undefined || thumbElement === undefined) {
      return;
    }
    event.preventDefault();
    dragState = {
      pointerId: event.pointerId,
      startScrollTop: scrollElement.scrollTop,
      startY: event.clientY,
    };
    thumbElement.setPointerCapture(event.pointerId);
  }

  function handleThumbPointerMove(event: PointerEvent): void {
    if (
      dragState === undefined ||
      dragState.pointerId !== event.pointerId ||
      trackElement === undefined
    ) {
      return;
    }
    const metrics = scrollbar();
    const maximumThumbTop = Math.max(0, trackElement.clientHeight - metrics.thumbHeight);
    const scrollDelta =
      maximumThumbTop === 0
        ? 0
        : ((event.clientY - dragState.startY) / maximumThumbTop) * metrics.maximumScroll;
    const targetScrollTop = dragState.startScrollTop + scrollDelta;
    setScrollTopFromThumb(
      metrics.maximumScroll === 0 ? 0 : (targetScrollTop / metrics.maximumScroll) * maximumThumbTop,
    );
  }

  function finishThumbDrag(event: PointerEvent): void {
    if (dragState?.pointerId !== event.pointerId || thumbElement === undefined) {
      return;
    }
    if (thumbElement.hasPointerCapture(event.pointerId)) {
      thumbElement.releasePointerCapture(event.pointerId);
    }
    dragState = undefined;
  }

  function handleTrackKeyDown(event: KeyboardEvent): void {
    const scrollElement = props.scrollElement();
    if (scrollElement === undefined) {
      return;
    }
    const page = resolveScrollbarPageScrollAmount(scrollElement.clientHeight);
    switch (event.key) {
      case "ArrowDown":
        scrollBy(SCROLLBAR_ARROW_SCROLL_STEP_PX);
        break;
      case "ArrowUp":
        scrollBy(-SCROLLBAR_ARROW_SCROLL_STEP_PX);
        break;
      case "End":
        scrollElement.scrollTop = scrollbar().maximumScroll;
        scheduleMeasurement();
        break;
      case "Home":
        scrollElement.scrollTop = 0;
        scheduleMeasurement();
        break;
      case "PageDown":
        scrollBy(page);
        break;
      case "PageUp":
        scrollBy(-page);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  onMount(() => {
    const scrollElement = props.scrollElement();
    if (scrollElement === undefined) {
      return;
    }
    scrollElement.addEventListener("scroll", scheduleMeasurement, { passive: true });
    resizeObserver = new ResizeObserver(scheduleMeasurement);
    resizeObserver.observe(scrollElement);
    if (trackElement !== undefined) {
      resizeObserver.observe(trackElement);
    }
    const contentElement = props.contentElement?.();
    if (contentElement !== undefined) {
      resizeObserver.observe(contentElement);
    }
    scheduleMeasurement();
  });

  onCleanup(() => {
    props.scrollElement()?.removeEventListener("scroll", scheduleMeasurement);
    resizeObserver?.disconnect();
    if (measurementFrame !== undefined) {
      window.cancelAnimationFrame(measurementFrame);
    }
  });

  return (
    <div
      aria-hidden={!scrollbar().scrollable}
      class={`surface-scrollbar${props.className === undefined ? "" : ` ${props.className}`}`}
      classList={{ "is-hidden": !scrollbar().scrollable }}
    >
      <button
        aria-controls={props.controls}
        aria-label={formatMessage(messages().scrollNamedUp, { name: props.label })}
        class="surface-scrollbar-arrow up"
        disabled={!scrollbar().scrollable || scrollbar().thumbTop <= 0.5}
        onClick={() => scrollBy(-SCROLLBAR_ARROW_SCROLL_STEP_PX)}
        title={messages().scrollUp}
        type="button"
      >
        <span aria-hidden="true" class="surface-scrollbar-arrow-glyph" />
      </button>
      <div
        aria-controls={props.controls}
        aria-label={formatMessage(messages().positionIn, { name: props.label })}
        aria-orientation="vertical"
        aria-valuemax={Math.round(scrollbar().maximumScroll)}
        aria-valuemin={0}
        aria-valuenow={Math.round(props.scrollElement()?.scrollTop ?? 0)}
        class="surface-scrollbar-track"
        onKeyDown={handleTrackKeyDown}
        onPointerDown={handleTrackPointerDown}
        ref={trackElement}
        role="scrollbar"
        tabIndex={scrollbar().scrollable ? 0 : -1}
      >
        <div
          class="surface-scrollbar-thumb"
          onPointerCancel={finishThumbDrag}
          onPointerDown={handleThumbPointerDown}
          onPointerMove={handleThumbPointerMove}
          onPointerUp={finishThumbDrag}
          ref={thumbElement}
          style={{
            height: `${scrollbar().thumbHeight}px`,
            transform: `translateY(${scrollbar().thumbTop}px)`,
          }}
        />
      </div>
      <button
        aria-controls={props.controls}
        aria-label={formatMessage(messages().scrollNamedDown, { name: props.label })}
        class="surface-scrollbar-arrow down"
        disabled={
          !scrollbar().scrollable ||
          scrollbar().thumbTop + scrollbar().thumbHeight >= (trackElement?.clientHeight ?? 0) - 0.5
        }
        onClick={() => scrollBy(SCROLLBAR_ARROW_SCROLL_STEP_PX)}
        title={messages().scrollDown}
        type="button"
      >
        <span aria-hidden="true" class="surface-scrollbar-arrow-glyph" />
      </button>
    </div>
  );
}
