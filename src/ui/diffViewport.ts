import { calculateFixedRowVirtualRange } from "./fixedRowVirtualization";

export const DIFF_ROW_HEIGHT_PX = 20;
export const DIFF_VIEWPORT_MAX_HEIGHT_PX = 360;
export const DIFF_OVERSCAN_ROWS = 0;
export const MAX_DIFF_CANVAS_HEIGHT_PX = 8_000_000;

export interface DiffVirtualRange {
  readonly end: number;
  readonly logicalTotalHeight: number;
  readonly offsetTop: number;
  readonly start: number;
  readonly totalHeight: number;
}

export function calculateDiffViewportIntrinsicHeight(input: {
  readonly hidden: boolean;
  readonly rowCount: number;
}): number {
  if (!Number.isInteger(input.rowCount) || input.rowCount < 0) {
    throw new Error("Diff row count must be a non-negative integer.");
  }
  return Math.max(
    1,
    input.hidden ? 1 : Math.min(DIFF_VIEWPORT_MAX_HEIGHT_PX, input.rowCount * DIFF_ROW_HEIGHT_PX),
  );
}

export function resolveDiffVirtualizationHeight(
  intrinsicHeight: number,
  observedHeight: number | null,
): number {
  if (!Number.isFinite(intrinsicHeight) || intrinsicHeight <= 0) {
    throw new Error("Diff intrinsic viewport height must be a positive finite number.");
  }
  return observedHeight !== null && Number.isFinite(observedHeight) && observedHeight > 0
    ? observedHeight
    : intrinsicHeight;
}

export function calculateDiffVirtualRange(input: {
  readonly overscanRows?: number;
  readonly rowCount: number;
  readonly rowHeight?: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
}): DiffVirtualRange {
  const rowHeight = input.rowHeight ?? DIFF_ROW_HEIGHT_PX;
  const overscanRows = input.overscanRows ?? DIFF_OVERSCAN_ROWS;
  if (!Number.isInteger(input.rowCount) || input.rowCount < 0) {
    throw new Error("Diff row count must be a non-negative integer.");
  }
  if (!Number.isFinite(rowHeight) || rowHeight <= 0) {
    throw new Error("Diff row height must be a positive finite number.");
  }
  if (!Number.isInteger(overscanRows) || overscanRows < 0) {
    throw new Error("Diff overscan must be a non-negative integer.");
  }
  const range = calculateFixedRowVirtualRange({
    itemCount: input.rowCount,
    itemSize: rowHeight,
    maximumCanvasSize: MAX_DIFF_CANVAS_HEIGHT_PX,
    overscanItems: overscanRows,
    scrollOffset: input.scrollTop,
    viewportSize: input.viewportHeight,
  });
  return {
    start: range.start,
    end: range.end,
    logicalTotalHeight: range.logicalTotalSize,
    offsetTop: range.offset,
    totalHeight: range.physicalTotalSize,
  };
}
