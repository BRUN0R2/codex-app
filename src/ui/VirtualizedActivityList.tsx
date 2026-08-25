import {
  type Accessor,
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  type Setter,
  untrack,
} from "solid-js";

import {
  type ActivityMeasurementVersion,
  includeRetainedActivityAnchor,
  isCurrentActivityMeasurement,
  overscanActivityVirtualRange,
  resolveActivityViewport,
  retainContainingActivityVirtualRange,
  shouldMaterializeActivityBody,
} from "./activityVirtualization";
import {
  type BoundedVirtualViewport,
  projectVirtualLogicalOffset,
  resolveBoundedVirtualViewport,
} from "./boundedVirtualViewport";
import { observeElementResize } from "./elementResize";
import { type KeyedVirtualSlot, reconcileKeyedVirtualSlots } from "./keyedVirtualSlots";
import { useTimelineActivityContext } from "./timelineActivityContext";
import type { VariableSizeVirtualizer, VirtualItemSource } from "./variableSizeVirtualizer";
import { findViewportVisualAnchorIndex } from "./viewportAnchor";

const ACTIVITY_INTERSECTION_OVERSCAN_VIEWPORTS = 1;
const ACTIVITY_MOVING_OVERSCAN_ITEMS = 0;
const ACTIVITY_SETTLED_OVERSCAN_ITEMS = 2;

interface ActivityVirtualRange {
  readonly end: number;
  readonly start: number;
  readonly visibleEnd: number;
  readonly visibleStart: number;
}

interface ActivityRenderSlot {
  readonly index: Accessor<number>;
  readonly key: Accessor<string>;
  readonly setPosition: Setter<ActivityRenderSlotPosition>;
  readonly slotId: number;
}

interface ActivityRenderSlotPosition {
  readonly index: number;
  readonly key: string;
}

interface PendingActivityMeasurement {
  readonly size: number;
  readonly version: ActivityMeasurementVersion;
}

export function VirtualizedActivityList(props: {
  readonly contentRevision?: number | undefined;
  readonly estimateRevision?: number | undefined;
  readonly estimateItemSize?: ((key: string, index: number) => number) | undefined;
  readonly groupKey: string;
  readonly itemSource: VirtualItemSource;
  readonly renderItem: (
    key: () => string,
    index: () => number,
    materializeBody: () => boolean,
  ) => JSX.Element;
  readonly reuseGroupForKey: (key: string, index: number) => string;
  readonly uniformEstimate?: number | undefined;
  readonly virtualize: boolean;
}) {
  let listElement: HTMLDivElement | undefined;
  let intersectionObserver: IntersectionObserver | undefined;
  let listContentTop: number | undefined;
  let geometrySynchronizationGeneration = 0;
  let scheduledGeometrySynchronization: number | undefined;
  let measurementGeneration = 0;
  let scheduledMeasurementGeneration: number | undefined;
  let anchorRetentionFrame: number | undefined;
  const pendingMeasurements = new Map<string, PendingActivityMeasurement>();
  const context = useTimelineActivityContext();
  const [nearViewport, setNearViewport] = createSignal(false);
  const [retainedAnchorIndex, setRetainedAnchorIndex] = createSignal<number | null>(null);
  const [revision, setRevision] = createSignal(0);
  const activation = createMemo(() => {
    const groupKey = props.groupKey;
    const itemSource = props.itemSource;
    const layoutSignature = context.layoutSignature();
    const contentRevision = props.contentRevision ?? 0;
    const estimateItemSize = props.estimateItemSize;
    return context.sessions.activateSource(
      groupKey,
      itemSource,
      layoutSignature,
      contentRevision,
      props.uniformEstimate,
      estimateItemSize === undefined
        ? undefined
        : (key, index) => untrack(() => estimateItemSize(key, index)),
      props.estimateRevision,
    );
  });
  const virtualizer = () => activation().virtualizer;
  const boundedViewport = createMemo<BoundedVirtualViewport>(() => {
    revision();
    const timelineViewport = context.viewport();
    return resolveBoundedVirtualViewport({
      logicalTotalSize: virtualizer().totalSize(),
      physicalOffset: readLocalViewportOffset() ?? 0,
      viewportSize: timelineViewport?.size ?? 1,
    });
  });
  const range = createMemo<ActivityVirtualRange>((previousRange) => {
    const timelineViewport = context.viewport();
    const viewport = boundedViewport();
    if (!props.virtualize) {
      return preserveActivityVirtualRange(previousRange, {
        start: 0,
        end: props.itemSource.count,
        visibleStart: 0,
        visibleEnd: props.itemSource.count,
      });
    }
    if (!nearViewport() || timelineViewport === null || listElement === undefined) {
      return preserveActivityVirtualRange(previousRange, {
        start: 0,
        end: 0,
        visibleStart: 0,
        visibleEnd: 0,
      });
    }
    const virtualRange = virtualizer().range(viewport.logicalOffset, viewport.viewportSize, 0);
    const stableRange = overscanActivityVirtualRange(
      virtualRange,
      props.itemSource.count,
      context.minimalOverscan() ? ACTIVITY_MOVING_OVERSCAN_ITEMS : ACTIVITY_SETTLED_OVERSCAN_ITEMS,
    );
    const anchorIndex = retainedAnchorIndex();
    const anchoredRange = includeRetainedActivityAnchor(previousRange, stableRange, anchorIndex);
    const retainedRange = retainContainingActivityVirtualRange(previousRange, anchoredRange);
    return preserveActivityVirtualRange(previousRange, {
      end: retainedRange.end,
      start: retainedRange.start,
      visibleEnd: virtualRange.end,
      visibleStart: virtualRange.start,
    });
  });
  const visibleKeys = createMemo(() => {
    const current = range();
    return Array.from({ length: current.end - current.start }, (_, index) =>
      props.itemSource.keyAt(current.start + index),
    );
  });
  const visibleItems = createMemo(() => {
    const start = range().start;
    return visibleKeys().map((key, index) => ({
      key,
      reuseGroup: props.reuseGroupForKey(key, start + index),
    }));
  });
  let slotAssignments: readonly KeyedVirtualSlot[] = [];
  let renderedSlotSequence: readonly ActivityRenderSlot[] = [];
  const [renderSlots, setRenderSlots] = createSignal<readonly ActivityRenderSlot[]>([]);
  createEffect(() => {
    const currentRange = range();
    const nextAssignments = reconcileKeyedVirtualSlots(slotAssignments, visibleItems());
    if (nextAssignments === slotAssignments) {
      return;
    }
    const nextRenderSlots: ActivityRenderSlot[] = [];
    batch(() => {
      for (const assignment of nextAssignments) {
        const slot =
          findActivityRenderSlot(renderedSlotSequence, assignment.slotId) ??
          createActivityRenderSlot(assignment);
        slot.setPosition((current) => {
          const index = currentRange.start + assignment.index;
          return current.key === assignment.key && current.index === index
            ? current
            : { index, key: assignment.key };
        });
        nextRenderSlots.push(slot);
      }
      const sequenceChanged =
        renderedSlotSequence.length !== nextRenderSlots.length ||
        nextRenderSlots.some((slot, index) => renderedSlotSequence[index] !== slot);
      if (sequenceChanged) {
        renderedSlotSequence = nextRenderSlots;
        setRenderSlots(nextRenderSlots);
      }
    });
    slotAssignments = nextAssignments;
  });
  const physicalTotalSize = createMemo(() => {
    revision();
    return resolveBoundedVirtualViewport({
      logicalTotalSize: virtualizer().totalSize(),
      physicalOffset: 0,
      viewportSize: context.viewport()?.size ?? 1,
    }).physicalTotalSize;
  });
  const visibleWindowOffset = createMemo(() => {
    const currentRange = range();
    return virtualizer().offsetOf(currentRange.start);
  });
  const visibleWindowSize = createMemo(() => {
    const currentRange = range();
    return Math.max(
      0,
      virtualizer().offsetOf(currentRange.end) - virtualizer().offsetOf(currentRange.start),
    );
  });

  function synchronizeIntersection(): void {
    const viewport = context.viewport();
    if (viewport === null || listElement === undefined) {
      listContentTop = undefined;
      setNearViewport(false);
      return;
    }
    const viewportRect = viewport.element.getBoundingClientRect();
    const listRect = listElement.getBoundingClientRect();
    listContentTop = viewport.scrollTop + listRect.top - viewportRect.top;
    const margin = viewport.size * ACTIVITY_INTERSECTION_OVERSCAN_VIEWPORTS;
    setNearViewport(
      listRect.bottom >= viewportRect.top - margin && listRect.top <= viewportRect.bottom + margin,
    );
  }

  function readLocalViewportOffset(): number | null {
    const viewport = context.viewport();
    if (viewport === null || listElement === undefined) {
      return null;
    }
    if (listContentTop === undefined) {
      synchronizeIntersection();
    }
    return resolveActivityViewport({
      listTop: listContentTop ?? 0,
      scrollTop: viewport.scrollTop,
      viewportSize: viewport.size,
    }).offset;
  }

  function scheduleGeometrySynchronization(): void {
    if (scheduledGeometrySynchronization !== undefined) {
      return;
    }
    geometrySynchronizationGeneration += 1;
    const generation = geometrySynchronizationGeneration;
    scheduledGeometrySynchronization = generation;
    queueMicrotask(() => {
      if (scheduledGeometrySynchronization !== generation) {
        return;
      }
      scheduledGeometrySynchronization = undefined;
      synchronizeIntersection();
    });
  }

  function commitVirtualizerMutation(
    mutate: () => boolean,
    excludedAnchorKeys: readonly string[] = [],
  ): void {
    const visualAnchor = captureVisualAnchor(excludedAnchorKeys);
    if (!mutate()) {
      return;
    }
    setRevision((current) => current + 1);
    context.notifyLayoutChange();
    if (visualAnchor !== null && anchorRetentionFrame === undefined) {
      setRetainedAnchorIndex(visualAnchor.index);
      context.preserveVisualAnchor(visualAnchor.anchor);
      anchorRetentionFrame = requestAnimationFrame(() => {
        anchorRetentionFrame = undefined;
        setRetainedAnchorIndex(null);
      });
    }
  }

  function captureVisualAnchor(excludedAnchorKeys: readonly string[]): {
    readonly anchor: {
      readonly element: HTMLElement;
      readonly key: string;
      readonly scrollTop: number;
      readonly viewportOffset: number;
    };
    readonly index: number;
  } | null {
    const viewport = context.viewport();
    if (
      viewport === null ||
      listElement === undefined ||
      context.contentDeferred() ||
      !context.shouldPreserveAnchor()
    ) {
      return null;
    }
    const viewportBounds = viewport.element.getBoundingClientRect();
    const mountedItems = [
      ...listElement.querySelectorAll<HTMLElement>(
        ".agent-activity-virtual-item[data-virtual-activity-key]",
      ),
    ].map((element) => {
      const key = element.getAttribute("data-virtual-activity-key");
      return {
        bounds: element.getBoundingClientRect(),
        element,
        index: key === null ? null : virtualizer().indexOf(key),
        key,
      };
    });
    const anchorIndex = findViewportVisualAnchorIndex({
      isAnchorCandidate: (index) => {
        const item = mountedItems[index];
        return (
          item !== undefined &&
          item.index !== null &&
          item.key !== null &&
          !excludedAnchorKeys.includes(item.key)
        );
      },
      itemCount: mountedItems.length,
      readItemBounds: (index) => mountedItems[index]?.bounds ?? { bottom: 0, top: 0 },
      viewportBottom: Math.min(viewportBounds.bottom, viewportBounds.top + viewport.size),
      viewportTop: viewportBounds.top,
    });
    const captured = anchorIndex === null ? undefined : mountedItems[anchorIndex];
    return captured === undefined || captured.index === null || captured.key === null
      ? null
      : {
          anchor: {
            element: captured.element,
            key: captured.key,
            scrollTop: viewport.scrollTop,
            viewportOffset: captured.bounds.top - viewportBounds.top,
          },
          index: captured.index,
        };
  }

  function measureItem(key: string, size: number): void {
    pendingMeasurements.set(key, {
      size,
      version: readMeasurementVersion(key),
    });
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
      const currentVirtualizer = virtualizer();
      const measurements = [...pendingMeasurements].flatMap(([measurementKey, measurement]) => {
        if (currentVirtualizer.estimatedSizeOf(measurementKey) === null) {
          return [];
        }
        return isCurrentActivityMeasurement(
          measurement.version,
          readMeasurementVersion(measurementKey),
        )
          ? [{ key: measurementKey, size: measurement.size }]
          : [];
      });
      pendingMeasurements.clear();
      if (measurements.length > 0) {
        const changedMeasurementKeys = measurements.flatMap((measurement) => {
          const index = currentVirtualizer.indexOf(measurement.key);
          const nextSize = Math.max(1, Math.round(measurement.size));
          return index !== null && currentVirtualizer.sizeOf(index) !== nextSize
            ? [measurement.key]
            : [];
        });
        commitVirtualizerMutation(
          () => currentVirtualizer.measureBatch(measurements).changed,
          changedMeasurementKeys,
        );
      }
    });
  }

  function readMeasurementVersion(key: string): ActivityMeasurementVersion {
    const index = virtualizer().indexOf(key);
    return {
      contentRevision: props.contentRevision ?? 0,
      estimatedSize: index === null ? 30 : (props.estimateItemSize?.(key, index) ?? 30),
      layoutSignature: context.layoutSignature(),
    };
  }

  let synchronizedEstimateRevision: number | undefined;
  let synchronizedEstimateVirtualizer: VariableSizeVirtualizer | undefined;
  createEffect(() => {
    const estimateItemSize = props.estimateItemSize;
    const currentActivation = activation();
    const currentVirtualizer = currentActivation.virtualizer;
    const targetEstimateRevision = props.estimateRevision ?? props.contentRevision ?? 0;
    if (synchronizedEstimateVirtualizer !== currentVirtualizer) {
      synchronizedEstimateVirtualizer = currentVirtualizer;
      synchronizedEstimateRevision = currentActivation.appliedEstimateRevision;
    }
    if (estimateItemSize === undefined) {
      return;
    }
    if (currentActivation.estimatesComplete) {
      if (synchronizedEstimateRevision === targetEstimateRevision) {
        return;
      }
      commitVirtualizerMutation(() =>
        currentVirtualizer.updateEstimatedSizes((key, index) =>
          untrack(() => estimateItemSize(key, index)),
        ),
      );
      synchronizedEstimateRevision = targetEstimateRevision;
      return;
    }
    const start = range().start;
    const estimates = visibleKeys()
      .map((key, index) => ({ key, size: estimateItemSize(key, start + index) }))
      .filter((estimate) => virtualizer().estimatedSizeOf(estimate.key) !== estimate.size);
    if (estimates.length === 0) {
      return;
    }
    commitVirtualizerMutation(
      () => {
        let changed = false;
        for (const estimate of estimates) {
          changed = virtualizer().estimate(estimate.key, estimate.size) || changed;
        }
        return changed;
      },
      estimates.map((estimate) => estimate.key),
    );
  });

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
          scheduleGeometrySynchronization();
        }
      },
      {
        root: viewport.element,
        rootMargin: `${Math.round(viewport.size * ACTIVITY_INTERSECTION_OVERSCAN_VIEWPORTS)}px 0px`,
      },
    );
    intersectionObserver.observe(listElement);
  });

  onCleanup(() => {
    intersectionObserver?.disconnect();
    measurementGeneration += 1;
    scheduledMeasurementGeneration = undefined;
    pendingMeasurements.clear();
    geometrySynchronizationGeneration += 1;
    scheduledGeometrySynchronization = undefined;
    if (anchorRetentionFrame !== undefined) {
      cancelAnimationFrame(anchorRetentionFrame);
      anchorRetentionFrame = undefined;
    }
  });

  createEffect(() => {
    context.layoutRevision();
    context.layoutSignature();
    scheduleGeometrySynchronization();
  });

  return (
    <div
      class="agent-activity-list agent-activity-virtual-list"
      data-virtual-activity-count={visibleKeys().length}
      data-virtual-activity-total={props.itemSource.count}
      ref={listElement}
      style={{ height: `${physicalTotalSize()}px` }}
    >
      <div
        class="agent-activity-virtual-window"
        style={{
          height: `${Math.round(visibleWindowSize())}px`,
          transform: `translate3d(0, ${Math.round(
            projectVirtualLogicalOffset(boundedViewport(), visibleWindowOffset()),
          )}px, 0)`,
        }}
      >
        <For each={renderSlots()}>
          {(slot) => {
            const itemIndex = slot.index;
            return (
              <VirtualizedActivityItem
                itemKey={slot.key}
                itemIndex={slot.index}
                onMeasure={measureItem}
                render={props.renderItem}
                reservedSize={() => {
                  revision();
                  return virtualizer().sizeOf(itemIndex());
                }}
                top={() => {
                  revision();
                  return virtualizer().offsetOf(itemIndex()) - visibleWindowOffset();
                }}
                shouldMaterializeBody={() => {
                  const currentRange = range();
                  return shouldMaterializeActivityBody(
                    itemIndex(),
                    currentRange.visibleStart,
                    currentRange.visibleEnd,
                    context.contentDeferred(),
                  );
                }}
              />
            );
          }}
        </For>
      </div>
    </div>
  );
}

function VirtualizedActivityItem(props: {
  readonly itemKey: () => string;
  readonly itemIndex: () => number;
  readonly onMeasure: (key: string, size: number) => void;
  readonly render: (
    key: () => string,
    index: () => number,
    materializeBody: () => boolean,
  ) => JSX.Element;
  readonly reservedSize: () => number;
  readonly shouldMaterializeBody: () => boolean;
  readonly top: () => number;
}) {
  let element: HTMLDivElement | undefined;
  let releaseResizeObservation: (() => void) | undefined;
  const [materializedKey, setMaterializedKey] = createSignal<string | null>(
    props.shouldMaterializeBody() ? props.itemKey() : null,
  );
  const materializeBody = () =>
    props.shouldMaterializeBody() || materializedKey() === props.itemKey();
  const shouldObserveSize = createMemo(materializeBody);

  function measure(): void {
    if (element !== undefined) {
      props.onMeasure(props.itemKey(), element.getBoundingClientRect().height);
    }
  }

  createEffect(() => {
    const key = props.itemKey();
    if (props.shouldMaterializeBody()) {
      setMaterializedKey(key);
    }
  });
  createEffect(() => {
    if (!shouldObserveSize() || element === undefined) {
      releaseResizeObservation?.();
      releaseResizeObservation = undefined;
      return;
    }
    releaseResizeObservation?.();
    releaseResizeObservation = observeElementResize(element, measure);
  });
  onCleanup(() => releaseResizeObservation?.());

  return (
    <div
      class="agent-activity-virtual-item"
      data-activity-content={materializeBody() ? "materialized" : "deferred"}
      data-virtual-activity-key={props.itemKey()}
      ref={element}
      style={{
        height: materializeBody() ? undefined : `${Math.round(props.reservedSize())}px`,
        overflow: materializeBody() ? undefined : "clip",
        top: `${Math.round(props.top())}px`,
      }}
    >
      {props.render(props.itemKey, props.itemIndex, materializeBody)}
    </div>
  );
}

function createActivityRenderSlot(assignment: KeyedVirtualSlot): ActivityRenderSlot {
  const [position, setPosition] = createSignal<ActivityRenderSlotPosition>({
    index: assignment.index,
    key: assignment.key,
  });
  return {
    index: () => position().index,
    key: () => position().key,
    setPosition,
    slotId: assignment.slotId,
  };
}

function findActivityRenderSlot(
  slots: readonly ActivityRenderSlot[],
  slotId: number,
): ActivityRenderSlot | undefined {
  for (const slot of slots) {
    if (slot.slotId === slotId) {
      return slot;
    }
  }
  return undefined;
}

function preserveActivityVirtualRange(
  previous: ActivityVirtualRange | undefined,
  next: ActivityVirtualRange,
): ActivityVirtualRange {
  return previous !== undefined &&
    previous.start === next.start &&
    previous.end === next.end &&
    previous.visibleStart === next.visibleStart &&
    previous.visibleEnd === next.visibleEnd
    ? previous
    : next;
}
