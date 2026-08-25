import { describe, expect, it } from "vitest";

import {
  MAX_VIRTUAL_CANVAS_SIZE_PX,
  projectVirtualLogicalOffset,
  resolveBoundedVirtualViewport,
  virtualLogicalToPhysicalOffset,
} from "./boundedVirtualViewport";

describe("bounded virtual viewport", () => {
  it("keeps ordinary lists in one-to-one physical coordinates", () => {
    const viewport = resolveBoundedVirtualViewport({
      logicalTotalSize: 40_000,
      physicalOffset: 12_000,
      viewportSize: 800,
    });

    expect(viewport).toEqual({
      logicalOffset: 12_000,
      logicalTotalSize: 40_000,
      physicalOffset: 12_000,
      physicalTotalSize: 40_000,
      viewportSize: 800,
    });
    expect(projectVirtualLogicalOffset(viewport, 12_300)).toBe(12_300);
  });

  it("maps a forty-million-pixel list onto a bounded physical canvas", () => {
    const logicalTotalSize = 100_000 * 400;
    const viewportSize = 900;
    const physicalOffset = (MAX_VIRTUAL_CANVAS_SIZE_PX - viewportSize) / 2;
    const viewport = resolveBoundedVirtualViewport({
      logicalTotalSize,
      physicalOffset,
      viewportSize,
    });

    expect(viewport.physicalTotalSize).toBe(MAX_VIRTUAL_CANVAS_SIZE_PX);
    expect(viewport.logicalOffset).toBeCloseTo((logicalTotalSize - viewportSize) / 2, 5);
    expect(projectVirtualLogicalOffset(viewport, viewport.logicalOffset + 120)).toBeCloseTo(
      physicalOffset + 120,
      5,
    );
  });

  it("maps both ends exactly and preserves a logical anchor after total-size changes", () => {
    const viewportSize = 720;
    const firstTotal = 40_000_000;
    const firstLogicalOffset = 20_000_000;
    const firstPhysicalOffset = virtualLogicalToPhysicalOffset(
      firstLogicalOffset,
      firstTotal,
      viewportSize,
    );
    const firstViewport = resolveBoundedVirtualViewport({
      logicalTotalSize: firstTotal,
      physicalOffset: firstPhysicalOffset,
      viewportSize,
    });
    const anchorLogicalOffset = firstViewport.logicalOffset + 180;
    const nextTotal = firstTotal + 2_000_000;
    const nextAnchorLogicalOffset = anchorLogicalOffset + 2_000;
    const nextPhysicalOffset = virtualLogicalToPhysicalOffset(
      nextAnchorLogicalOffset - 180,
      nextTotal,
      viewportSize,
    );
    const nextViewport = resolveBoundedVirtualViewport({
      logicalTotalSize: nextTotal,
      physicalOffset: nextPhysicalOffset,
      viewportSize,
    });

    expect(
      projectVirtualLogicalOffset(nextViewport, nextAnchorLogicalOffset) - nextPhysicalOffset,
    ).toBeCloseTo(180, 5);
    expect(virtualLogicalToPhysicalOffset(0, nextTotal, viewportSize)).toBe(0);
    expect(virtualLogicalToPhysicalOffset(nextTotal, nextTotal, viewportSize)).toBe(
      MAX_VIRTUAL_CANVAS_SIZE_PX - viewportSize,
    );
  });

  it("rejects invalid geometry instead of hiding it behind fallback state", () => {
    expect(() =>
      resolveBoundedVirtualViewport({
        logicalTotalSize: Number.NaN,
        physicalOffset: 0,
        viewportSize: 800,
      }),
    ).toThrow("logical total size");
    expect(() => virtualLogicalToPhysicalOffset(0, 100, 0)).toThrow("viewport size");
  });
});
