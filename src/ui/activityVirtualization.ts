import { touchMostRecentEntry } from "./recentlyUsedMap";
import {
  VariableSizeVirtualizer,
  type VirtualItemSource,
  type VirtualRange,
} from "./variableSizeVirtualizer";

export interface ActivityVirtualizerActivation {
  readonly appliedEstimateRevision: number;
  readonly estimatesComplete: boolean;
  readonly keysChanged: boolean;
  readonly measurementsReset: boolean;
  readonly virtualizer: VariableSizeVirtualizer;
}

export interface ActivityMeasurementVersion {
  readonly contentRevision: number;
  readonly estimatedSize: number;
  readonly layoutSignature: string | null;
}

export function isCurrentActivityMeasurement(
  captured: ActivityMeasurementVersion,
  current: ActivityMeasurementVersion,
): boolean {
  return (
    captured.contentRevision === current.contentRevision &&
    captured.estimatedSize === current.estimatedSize &&
    captured.layoutSignature === current.layoutSignature
  );
}

interface ActivityVirtualizerRecord {
  contentRevision: number;
  estimateRevision: number;
  layoutSignature: string | null;
  sourceIdentity: object | null;
  sourceItemCount: number;
  sourceKeys: readonly string[] | null;
  sourceType: "indexed" | "keys";
  sourceUniformEstimate: number | null;
  uniformEstimates: boolean;
  virtualizer: VariableSizeVirtualizer;
}

const EAGER_ACTIVITY_ESTIMATE_ITEM_LIMIT = 4_096;

export class ActivityVirtualizerStore {
  readonly #capacity: number;
  readonly #estimatedItemSize: number;
  readonly #records = new Map<string, ActivityVirtualizerRecord>();

  constructor(estimatedItemSize: number, capacity: number) {
    if (!Number.isFinite(estimatedItemSize) || estimatedItemSize <= 0) {
      throw new Error("Activity item estimates must be positive finite numbers.");
    }
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Activity virtualizer capacity must be a positive integer.");
    }
    this.#estimatedItemSize = estimatedItemSize;
    this.#capacity = capacity;
  }

  activate(
    groupKey: string,
    itemKeys: readonly string[],
    layoutSignature: string | null,
    contentRevision = 0,
    estimateItemSize?: ((key: string, index: number) => number) | undefined,
  ): ActivityVirtualizerActivation {
    if (groupKey.length === 0) {
      throw new Error("Activity virtualizers require a non-empty group key.");
    }
    const current = this.#records.get(groupKey);
    const record =
      current ??
      ({
        contentRevision,
        estimateRevision: contentRevision,
        layoutSignature,
        sourceIdentity: null,
        sourceItemCount: itemKeys.length,
        sourceKeys: null,
        sourceType: "keys",
        sourceUniformEstimate: null,
        uniformEstimates: estimateItemSize === undefined,
        virtualizer: new VariableSizeVirtualizer(this.#estimatedItemSize),
      } satisfies ActivityVirtualizerRecord);
    const contentChanged = current !== undefined && record.contentRevision !== contentRevision;
    const sourceKeysChanged = record.sourceType !== "keys" || record.sourceKeys !== itemKeys;
    const useUniformEstimates = estimateItemSize === undefined;
    let keysChanged = false;
    let estimatesReset = false;
    if (current === undefined || sourceKeysChanged) {
      keysChanged = useUniformEstimates
        ? record.virtualizer.setKeys(itemKeys)
        : record.virtualizer.setEstimatedKeys(itemKeys, estimateItemSize);
    } else if (useUniformEstimates) {
      if (!record.uniformEstimates || contentChanged) {
        estimatesReset = record.virtualizer.resetEstimates();
        keysChanged = estimatesReset;
      }
    } else if (contentChanged) {
      keysChanged = record.virtualizer.setEstimatedKeys(itemKeys, estimateItemSize);
    }
    const layoutMeasurementsReset =
      record.layoutSignature !== null &&
      layoutSignature !== null &&
      record.layoutSignature !== layoutSignature &&
      record.virtualizer.resetMeasurements();
    if (layoutSignature !== null) {
      record.layoutSignature = layoutSignature;
    }
    record.contentRevision = contentRevision;
    record.sourceIdentity = null;
    record.sourceItemCount = itemKeys.length;
    record.sourceKeys = itemKeys;
    record.sourceType = "keys";
    record.sourceUniformEstimate = null;
    record.uniformEstimates = useUniformEstimates;
    this.#touch(groupKey, record);
    return {
      appliedEstimateRevision: contentRevision,
      estimatesComplete: true,
      keysChanged,
      measurementsReset:
        layoutMeasurementsReset || estimatesReset || (contentChanged && keysChanged),
      virtualizer: record.virtualizer,
    };
  }

  activateSource(
    groupKey: string,
    itemSource: VirtualItemSource,
    layoutSignature: string | null,
    contentRevision = 0,
    uniformEstimate?: number | undefined,
    estimateItemSize?: ((key: string, index: number) => number) | undefined,
    estimateRevision = contentRevision,
  ): ActivityVirtualizerActivation {
    if (groupKey.length === 0) {
      throw new Error("Activity virtualizers require a non-empty group key.");
    }
    const current = this.#records.get(groupKey);
    const record =
      current ??
      ({
        contentRevision,
        estimateRevision,
        layoutSignature,
        sourceIdentity: null,
        sourceItemCount: itemSource.count,
        sourceKeys: null,
        sourceType: "indexed",
        sourceUniformEstimate: null,
        uniformEstimates: false,
        virtualizer: new VariableSizeVirtualizer(this.#estimatedItemSize),
      } satisfies ActivityVirtualizerRecord);
    const contentChanged = current !== undefined && record.contentRevision !== contentRevision;
    const sourceChanged =
      record.sourceType !== "indexed" ||
      record.sourceIdentity !== itemSource.identity ||
      record.sourceItemCount !== itemSource.count;
    if (estimateItemSize !== undefined && itemSource.count <= EAGER_ACTIVITY_ESTIMATE_ITEM_LIMIT) {
      const materializedSourceChanged = sourceChanged || record.sourceKeys === null;
      const itemKeys =
        !materializedSourceChanged && record.sourceKeys !== null
          ? record.sourceKeys
          : Array.from({ length: itemSource.count }, (_, index) => itemSource.keyAt(index));
      const keysChanged = materializedSourceChanged
        ? record.virtualizer.setEstimatedKeys(itemKeys, estimateItemSize)
        : false;
      const layoutMeasurementsReset =
        record.layoutSignature !== null &&
        layoutSignature !== null &&
        record.layoutSignature !== layoutSignature &&
        record.virtualizer.resetMeasurements();
      if (layoutSignature !== null) {
        record.layoutSignature = layoutSignature;
      }
      record.contentRevision = contentRevision;
      if (materializedSourceChanged) {
        record.estimateRevision = estimateRevision;
      }
      record.sourceIdentity = itemSource.identity;
      record.sourceItemCount = itemSource.count;
      record.sourceKeys = itemKeys;
      record.sourceType = "indexed";
      record.sourceUniformEstimate = null;
      record.uniformEstimates = false;
      this.#touch(groupKey, record);
      return {
        appliedEstimateRevision: record.estimateRevision,
        estimatesComplete: true,
        keysChanged,
        measurementsReset: layoutMeasurementsReset || (contentChanged && keysChanged),
        virtualizer: record.virtualizer,
      };
    }
    const estimateMode = uniformEstimate ?? (sourceChanged ? null : record.sourceUniformEstimate);
    const resetUniformEstimates = contentChanged && uniformEstimate !== undefined;
    const keysChanged = record.virtualizer.setItemSource(
      itemSource,
      estimateMode,
      resetUniformEstimates,
    );
    const layoutMeasurementsReset =
      record.layoutSignature !== null &&
      layoutSignature !== null &&
      record.layoutSignature !== layoutSignature &&
      record.virtualizer.resetMeasurements();
    if (layoutSignature !== null) {
      record.layoutSignature = layoutSignature;
    }
    record.contentRevision = contentRevision;
    record.estimateRevision = estimateRevision;
    record.sourceIdentity = itemSource.identity;
    record.sourceItemCount = itemSource.count;
    record.sourceKeys = null;
    record.sourceType = "indexed";
    record.sourceUniformEstimate = estimateMode;
    record.uniformEstimates = false;
    this.#touch(groupKey, record);
    return {
      appliedEstimateRevision: estimateRevision,
      estimatesComplete: uniformEstimate !== undefined,
      keysChanged,
      measurementsReset: layoutMeasurementsReset || resetUniformEstimates || sourceChanged,
      virtualizer: record.virtualizer,
    };
  }

  #touch(groupKey: string, record: ActivityVirtualizerRecord): void {
    if (!this.#records.has(groupKey)) {
      this.#records.set(groupKey, record);
    }
    touchMostRecentEntry(this.#records, groupKey, this.#capacity);
  }
}

export interface ActivityViewportInput {
  readonly listTop: number;
  readonly scrollTop: number;
  readonly viewportSize: number;
}

export interface ActivityViewport {
  readonly offset: number;
  readonly size: number;
}

export function resolveActivityViewport(input: ActivityViewportInput): ActivityViewport {
  const scrollTop = Number.isFinite(input.scrollTop) ? Math.max(0, input.scrollTop) : 0;
  const listTop = Number.isFinite(input.listTop) ? input.listTop : 0;
  const viewportSize = Number.isFinite(input.viewportSize) ? Math.max(1, input.viewportSize) : 1;
  return {
    offset: Math.max(0, scrollTop - listTop),
    size: viewportSize,
  };
}

export function shouldDeferActivityContent(scrollDelta: number, viewportSize: number): boolean {
  if (!Number.isFinite(scrollDelta) || !Number.isFinite(viewportSize) || viewportSize <= 0) {
    return false;
  }
  return Math.abs(scrollDelta) >= Math.max(80, viewportSize * 0.12);
}

export function shouldMinimizeActivityOverscan(scrollDelta: number, viewportSize: number): boolean {
  if (!Number.isFinite(scrollDelta) || !Number.isFinite(viewportSize) || viewportSize <= 0) {
    return false;
  }
  return Math.abs(scrollDelta) >= Math.max(240, viewportSize * 0.8);
}

export function shouldMaterializeActivityBody(
  itemIndex: number,
  visibleStart: number,
  visibleEnd: number,
  contentDeferred: boolean,
): boolean {
  return !contentDeferred || (itemIndex >= visibleStart && itemIndex < visibleEnd);
}

export function overscanActivityVirtualRange(
  range: VirtualRange,
  itemCount: number,
  overscanItems: number,
): VirtualRange {
  if (
    !Number.isInteger(itemCount) ||
    itemCount < 0 ||
    !Number.isInteger(overscanItems) ||
    overscanItems < 0 ||
    range.start < 0 ||
    range.end < range.start ||
    range.end > itemCount
  ) {
    throw new Error("Activity virtual range bounds must be non-negative valid integers.");
  }
  return {
    start: Math.max(0, range.start - overscanItems),
    end: Math.min(itemCount, range.end + overscanItems),
  };
}

export function retainContainingActivityVirtualRange(
  previousRange: VirtualRange | undefined,
  nextRange: VirtualRange,
): VirtualRange {
  if (
    previousRange !== undefined &&
    previousRange.start <= nextRange.start &&
    previousRange.end >= nextRange.end
  ) {
    return previousRange;
  }
  return nextRange;
}

export function includeRetainedActivityAnchor(
  previousRange: VirtualRange | undefined,
  nextRange: VirtualRange,
  anchorIndex: number | null,
): VirtualRange {
  if (
    anchorIndex === null ||
    (anchorIndex >= nextRange.start && anchorIndex < nextRange.end) ||
    previousRange === undefined ||
    anchorIndex < previousRange.start ||
    anchorIndex >= previousRange.end ||
    previousRange.end < nextRange.start ||
    nextRange.end < previousRange.start
  ) {
    return nextRange;
  }
  return {
    start: Math.min(nextRange.start, anchorIndex),
    end: Math.max(nextRange.end, anchorIndex + 1),
  };
}
