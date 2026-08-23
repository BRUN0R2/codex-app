import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

import { resolveActivityAnchorCorrection, resolveActivityViewport } from "./activityVirtualization";
import { observeElementResize } from "./elementResize";
import { useTimelineActivityContext } from "./timelineActivityContext";

const ACTIVITY_OVERSCAN_VIEWPORTS = 1;

export function VirtualizedActivityList(props: {
  readonly groupKey: string;
  readonly itemKeys: readonly string[];
  readonly renderItem: (key: string) => JSX.Element;
  readonly virtualize: boolean;
}) {
  let listElement: HTMLDivElement | undefined;
  let intersectionObserver: IntersectionObserver | undefined;
  let measurementGeneration = 0;
  let scheduledMeasurementGeneration: number | undefined;
  const pendingMeasurements = new Map<string, number>();
  const context = useTimelineActivityContext();
  const [nearViewport, setNearViewport] = createSignal(false);
  const [revision, setRevision] = createSignal(0);
  const activation = createMemo(() =>
    context.sessions.activate(props.groupKey, props.itemKeys, context.layoutSignature()),
  );
  const virtualizer = () => activation().virtualizer;
  const range = createMemo(() => {
    revision();
    const viewport = context.viewport();
    if (!props.virtualize) {
      return { start: 0, end: props.itemKeys.length };
    }
    if (!nearViewport() || viewport === null || listElement === undefined) {
      return { start: 0, end: 0 };
    }
    const viewportRect = viewport.element.getBoundingClientRect();
    const listRect = listElement.getBoundingClientRect();
    const localViewport = resolveActivityViewport({
      listTop: viewport.scrollTop + listRect.top - viewportRect.top,
      scrollTop: viewport.scrollTop,
      viewportSize: viewport.size,
    });
    return virtualizer().range(
      localViewport.offset,
      localViewport.size,
      localViewport.size * ACTIVITY_OVERSCAN_VIEWPORTS,
    );
  });
  const visibleKeys = createMemo(() => {
    const current = range();
    return props.itemKeys.slice(current.start, current.end);
  });
  const totalSize = createMemo(() => {
    revision();
    return virtualizer().totalSize();
  });

  function synchronizeIntersection(): void {
    const viewport = context.viewport();
    if (viewport === null || listElement === undefined) {
      setNearViewport(false);
      return;
    }
    const viewportRect = viewport.element.getBoundingClientRect();
    const listRect = listElement.getBoundingClientRect();
    const margin = viewport.size * ACTIVITY_OVERSCAN_VIEWPORTS;
    setNearViewport(
      listRect.bottom >= viewportRect.top - margin && listRect.top <= viewportRect.bottom + margin,
    );
  }

  function readLocalViewportOffset(): number | null {
    const viewport = context.viewport();
    if (viewport === null || listElement === undefined) {
      return null;
    }
    const viewportRect = viewport.element.getBoundingClientRect();
    const listRect = listElement.getBoundingClientRect();
    return resolveActivityViewport({
      listTop: viewport.scrollTop + listRect.top - viewportRect.top,
      scrollTop: viewport.scrollTop,
      viewportSize: viewport.size,
    }).offset;
  }

  function measureItem(key: string, size: number): void {
    pendingMeasurements.set(key, size);
    if (scheduledMeasurementGeneration !== undefined) {
      return;
    }
    measurementGeneration += 1;
    const generation = measurementGeneration;
    scheduledMeasurementGeneration = generation;
    queueMicrotask(() => {
      if (scheduledMeasurementGeneration !== generation) {
        return;
      }
      scheduledMeasurementGeneration = undefined;
      const localOffset = readLocalViewportOffset();
      const anchor = localOffset === null ? null : virtualizer().anchorAt(localOffset);
      const previousAnchorOffset =
        anchor === null ? null : virtualizer().resolveAnchorOffset(anchor);
      const measurements = [...pendingMeasurements].map(([measurementKey, measuredSize]) => ({
        key: measurementKey,
        size: measuredSize,
      }));
      pendingMeasurements.clear();
      const batch = virtualizer().measureBatch(measurements);
      if (!batch.changed) {
        return;
      }
      const nextAnchorOffset = anchor === null ? null : virtualizer().resolveAnchorOffset(anchor);
      const correction = resolveActivityAnchorCorrection(previousAnchorOffset, nextAnchorOffset);
      if (correction !== 0 && context.shouldPreserveAnchor()) {
        context.adjustScrollBy(correction);
      }
      setRevision((current) => current + 1);
      context.notifyLayoutChange();
    });
  }

  onMount(() => {
    synchronizeIntersection();
    const viewport = context.viewport();
    if (
      viewport === null ||
      listElement === undefined ||
      typeof IntersectionObserver === "undefined"
    ) {
      setNearViewport(true);
      return;
    }
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry !== undefined) {
          setNearViewport(entry.isIntersecting);
        }
      },
      {
        root: viewport.element,
        rootMargin: `${Math.round(viewport.size * ACTIVITY_OVERSCAN_VIEWPORTS)}px 0px`,
      },
    );
    intersectionObserver.observe(listElement);
  });

  onCleanup(() => {
    intersectionObserver?.disconnect();
    measurementGeneration += 1;
    scheduledMeasurementGeneration = undefined;
    pendingMeasurements.clear();
  });

  return (
    <div
      class="agent-activity-list agent-activity-virtual-list"
      data-virtual-activity-count={visibleKeys().length}
      ref={listElement}
      style={{ height: `${totalSize()}px` }}
    >
      <For each={visibleKeys()}>
        {(key, relativeIndex) => (
          <VirtualizedActivityItem
            itemKey={key}
            measure={() => !context.contentDeferred()}
            onMeasure={measureItem}
            top={() => virtualizer().offsetOf(range().start + relativeIndex())}
          >
            <Show
              keyed
              when={!context.contentDeferred()}
              fallback={<div aria-hidden="true" class="agent-activity-scroll-placeholder" />}
            >
              {(_visible) => props.renderItem(key)}
            </Show>
          </VirtualizedActivityItem>
        )}
      </For>
    </div>
  );
}

function VirtualizedActivityItem(props: {
  readonly children: JSX.Element;
  readonly itemKey: string;
  readonly measure: () => boolean;
  readonly onMeasure: (key: string, size: number) => void;
  readonly top: () => number;
}) {
  let element: HTMLDivElement | undefined;
  let releaseResizeObservation: (() => void) | undefined;

  function measure(): void {
    if (element !== undefined) {
      props.onMeasure(props.itemKey, element.getBoundingClientRect().height);
    }
  }

  createEffect(() => {
    if (!props.measure() || element === undefined) {
      releaseResizeObservation?.();
      releaseResizeObservation = undefined;
      return;
    }
    releaseResizeObservation?.();
    releaseResizeObservation = observeElementResize(element, measure);
    measure();
  });
  onCleanup(() => releaseResizeObservation?.());

  return (
    <div
      class="agent-activity-virtual-item"
      data-virtual-activity-key={props.itemKey}
      ref={element}
      style={{ top: `${Math.round(props.top())}px` }}
    >
      {props.children}
    </div>
  );
}
