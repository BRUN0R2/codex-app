import {
  projectVirtualLogicalOffset,
  resolveBoundedVirtualViewport,
} from "./boundedVirtualViewport";

export interface FixedRowVirtualRange {
  readonly end: number;
  readonly logicalTotalSize: number;
  readonly offset: number;
  readonly physicalTotalSize: number;
  readonly start: number;
}

export function calculateFixedRowVirtualRange(input: {
  readonly itemCount: number;
  readonly itemSize: number;
  readonly maximumCanvasSize: number;
  readonly overscanItems: number;
  readonly scrollOffset: number;
  readonly viewportSize: number;
}): FixedRowVirtualRange {
  if (!Number.isInteger(input.itemCount) || input.itemCount < 0) {
    throw new Error("Fixed-row item count must be a non-negative integer.");
  }
  if (!Number.isFinite(input.itemSize) || input.itemSize <= 0) {
    throw new Error("Fixed-row item size must be a positive finite number.");
  }
  if (!Number.isInteger(input.overscanItems) || input.overscanItems < 0) {
    throw new Error("Fixed-row overscan must be a non-negative integer.");
  }
  const scrollOffset = Number.isFinite(input.scrollOffset) ? Math.max(0, input.scrollOffset) : 0;
  const viewportSize = Number.isFinite(input.viewportSize) ? Math.max(1, input.viewportSize) : 1;
  const logicalTotalSize = input.itemCount * input.itemSize;
  const viewport = resolveBoundedVirtualViewport({
    logicalTotalSize,
    maximumCanvasSize: input.maximumCanvasSize,
    physicalOffset: scrollOffset,
    viewportSize,
  });
  const firstVisible = Math.floor(viewport.logicalOffset / input.itemSize);
  const visibleItems = Math.ceil(viewportSize / input.itemSize);
  const start = Math.max(0, firstVisible - input.overscanItems);
  const end = Math.min(input.itemCount, firstVisible + visibleItems + input.overscanItems);
  return {
    end,
    logicalTotalSize,
    offset: Math.max(0, projectVirtualLogicalOffset(viewport, start * input.itemSize)),
    physicalTotalSize: viewport.physicalTotalSize,
    start,
  };
}
