export const DIFF_ROW_HEIGHT_PX = 22;
export const DIFF_OVERSCAN_ROWS = 16;
export const MAX_DIFF_CANVAS_HEIGHT_PX = 8_000_000;

export interface DiffVirtualRange {
  readonly end: number;
  readonly logicalTotalHeight: number;
  readonly offsetTop: number;
  readonly start: number;
  readonly totalHeight: number;
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
  const scrollTop = Number.isFinite(input.scrollTop) ? Math.max(0, input.scrollTop) : 0;
  const viewportHeight = Number.isFinite(input.viewportHeight)
    ? Math.max(1, input.viewportHeight)
    : 1;
  const logicalTotalHeight = input.rowCount * rowHeight;
  const totalHeight = Math.min(logicalTotalHeight, MAX_DIFF_CANVAS_HEIGHT_PX);
  const maximumPhysicalScroll = Math.max(0, totalHeight - viewportHeight);
  const maximumLogicalScroll = Math.max(0, logicalTotalHeight - viewportHeight);
  const physicalScrollTop = Math.min(maximumPhysicalScroll, scrollTop);
  const logicalScrollTop =
    maximumPhysicalScroll === 0
      ? 0
      : (physicalScrollTop / maximumPhysicalScroll) * maximumLogicalScroll;
  const firstVisible = Math.floor(logicalScrollTop / rowHeight);
  const visibleRows = Math.ceil(viewportHeight / rowHeight);
  const start = Math.max(0, firstVisible - overscanRows);
  const end = Math.min(input.rowCount, firstVisible + visibleRows + overscanRows);
  return {
    start,
    end,
    logicalTotalHeight,
    offsetTop: Math.max(0, physicalScrollTop - (logicalScrollTop - start * rowHeight)),
    totalHeight,
  };
}
