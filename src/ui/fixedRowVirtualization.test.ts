import { describe, expect, it } from "vitest";

import { calculateFixedRowVirtualRange } from "./fixedRowVirtualization";

describe("fixed row virtualization", () => {
  it("keeps an extreme collection fully addressable with a bounded canvas", () => {
    const range = calculateFixedRowVirtualRange({
      itemCount: 1_000_000,
      itemSize: 22,
      maximumCanvasSize: 8_000_000,
      overscanItems: 4,
      scrollOffset: 4_000_000,
      viewportSize: 900,
    });

    expect(range.logicalTotalSize).toBe(22_000_000);
    expect(range.physicalTotalSize).toBe(8_000_000);
    expect(range.end - range.start).toBeLessThanOrEqual(49);
    expect(range.start).toBeGreaterThan(0);
    expect(range.end).toBeLessThan(1_000_000);
  });

  it("includes calibrated overscan without crossing collection bounds", () => {
    expect(
      calculateFixedRowVirtualRange({
        itemCount: 100,
        itemSize: 22,
        maximumCanvasSize: 8_000_000,
        overscanItems: 4,
        scrollOffset: 0,
        viewportSize: 205,
      }),
    ).toMatchObject({ start: 0, end: 14 });
  });

  it("rejects invalid structural inputs", () => {
    expect(() =>
      calculateFixedRowVirtualRange({
        itemCount: -1,
        itemSize: 22,
        maximumCanvasSize: 8_000_000,
        overscanItems: 4,
        scrollOffset: 0,
        viewportSize: 205,
      }),
    ).toThrow("non-negative integer");
  });
});
