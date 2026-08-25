export const MAX_VIRTUAL_CANVAS_SIZE_PX = 8_000_000;

export interface BoundedVirtualViewport {
  readonly logicalOffset: number;
  readonly logicalTotalSize: number;
  readonly physicalOffset: number;
  readonly physicalTotalSize: number;
  readonly viewportSize: number;
}

export function resolveBoundedVirtualViewport(input: {
  readonly logicalTotalSize: number;
  readonly maximumCanvasSize?: number;
  readonly physicalOffset: number;
  readonly viewportSize: number;
}): BoundedVirtualViewport {
  const logicalTotalSize = nonNegativeFinite(input.logicalTotalSize, "logical total size");
  const viewportSize = positiveFinite(input.viewportSize, "viewport size");
  const maximumCanvasSize = positiveFinite(
    input.maximumCanvasSize ?? MAX_VIRTUAL_CANVAS_SIZE_PX,
    "maximum canvas size",
  );
  const physicalTotalSize = Math.min(logicalTotalSize, Math.max(viewportSize, maximumCanvasSize));
  const maximumPhysicalOffset = Math.max(0, physicalTotalSize - viewportSize);
  const physicalOffset = Math.min(
    maximumPhysicalOffset,
    nonNegativeFinite(input.physicalOffset, "physical offset"),
  );

  return {
    logicalOffset: physicalToLogicalOffset(
      physicalOffset,
      logicalTotalSize,
      physicalTotalSize,
      viewportSize,
    ),
    logicalTotalSize,
    physicalOffset,
    physicalTotalSize,
    viewportSize,
  };
}

export function virtualLogicalToPhysicalOffset(
  logicalOffset: number,
  logicalTotalSize: number,
  viewportSize: number,
  maximumCanvasSize = MAX_VIRTUAL_CANVAS_SIZE_PX,
): number {
  const total = nonNegativeFinite(logicalTotalSize, "logical total size");
  const viewport = positiveFinite(viewportSize, "viewport size");
  const maximumCanvas = positiveFinite(maximumCanvasSize, "maximum canvas size");
  const physicalTotal = Math.min(total, Math.max(viewport, maximumCanvas));
  const maximumLogicalOffset = Math.max(0, total - viewport);
  const maximumPhysicalOffset = Math.max(0, physicalTotal - viewport);
  const boundedLogicalOffset = Math.min(
    maximumLogicalOffset,
    nonNegativeFinite(logicalOffset, "logical offset"),
  );
  return maximumLogicalOffset === 0
    ? 0
    : (boundedLogicalOffset / maximumLogicalOffset) * maximumPhysicalOffset;
}

export function projectVirtualLogicalOffset(
  viewport: BoundedVirtualViewport,
  logicalOffset: number,
): number {
  if (!Number.isFinite(logicalOffset) || logicalOffset < 0) {
    throw new Error("Projected virtual offsets must be non-negative finite numbers.");
  }
  return viewport.physicalOffset + logicalOffset - viewport.logicalOffset;
}

function physicalToLogicalOffset(
  physicalOffset: number,
  logicalTotalSize: number,
  physicalTotalSize: number,
  viewportSize: number,
): number {
  const maximumPhysicalOffset = Math.max(0, physicalTotalSize - viewportSize);
  const maximumLogicalOffset = Math.max(0, logicalTotalSize - viewportSize);
  return maximumPhysicalOffset === 0
    ? 0
    : (physicalOffset / maximumPhysicalOffset) * maximumLogicalOffset;
}

function nonNegativeFinite(value: number, description: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Virtual ${description} must be a non-negative finite number.`);
  }
  return value;
}

function positiveFinite(value: number, description: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Virtual ${description} must be a positive finite number.`);
  }
  return value;
}
