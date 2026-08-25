import { describe, expect, it } from "vitest";

import {
  calculateDiffViewportIntrinsicHeight,
  calculateDiffVirtualRange,
  DIFF_OVERSCAN_ROWS,
  DIFF_ROW_HEIGHT_PX,
  DIFF_VIEWPORT_MAX_HEIGHT_PX,
  MAX_DIFF_CANVAS_HEIGHT_PX,
  resolveDiffVirtualizationHeight,
} from "./diffViewport";

describe("diff viewport", () => {
  it("separates intrinsic presentation height from the rendered virtualization height", () => {
    const intrinsicHeight = calculateDiffViewportIntrinsicHeight({
      hidden: false,
      rowCount: 300,
    });

    expect(intrinsicHeight).toBe(DIFF_VIEWPORT_MAX_HEIGHT_PX);
    expect(resolveDiffVirtualizationHeight(intrinsicHeight, 159.171_875)).toBe(159.171_875);
    expect(resolveDiffVirtualizationHeight(intrinsicHeight, 0)).toBe(intrinsicHeight);
    expect(resolveDiffVirtualizationHeight(intrinsicHeight, null)).toBe(intrinsicHeight);
  });

  it("keeps short and hidden diff viewports intrinsically bounded", () => {
    expect(calculateDiffViewportIntrinsicHeight({ hidden: false, rowCount: 8 })).toBe(
      8 * DIFF_ROW_HEIGHT_PX,
    );
    expect(calculateDiffViewportIntrinsicHeight({ hidden: true, rowCount: 300 })).toBe(1);
  });

  it("keeps a million-row diff fully addressable with a bounded mounted window", () => {
    const range = calculateDiffVirtualRange({
      rowCount: 1_000_000,
      scrollTop: MAX_DIFF_CANVAS_HEIGHT_PX / 2,
      viewportHeight: 900,
    });

    expect(range.logicalTotalHeight).toBe(1_000_000 * DIFF_ROW_HEIGHT_PX);
    expect(range.totalHeight).toBe(MAX_DIFF_CANVAS_HEIGHT_PX);
    expect(range.end - range.start).toBeLessThanOrEqual(74);
    expect(range.start).toBeGreaterThan(0);
    expect(range.end).toBeLessThan(1_000_000);
  });

  it("maps the bounded physical bottom to the final logical row", () => {
    const range = calculateDiffVirtualRange({
      rowCount: 1_000_000,
      scrollTop: MAX_DIFF_CANVAS_HEIGHT_PX,
      viewportHeight: 900,
    });

    expect(range.end).toBe(1_000_000);
  });

  it("covers the first and final rows without truncating the document", () => {
    expect(
      calculateDiffVirtualRange({
        rowCount: 100,
        scrollTop: 0,
        viewportHeight: 220,
      }).start,
    ).toBe(0);
    expect(
      calculateDiffVirtualRange({
        rowCount: 100,
        scrollTop: 100 * DIFF_ROW_HEIGHT_PX,
        viewportHeight: 220,
      }).end,
    ).toBe(100);
  });

  it("mounts exactly the visible diff rows while scrolling", () => {
    const range = calculateDiffVirtualRange({
      rowCount: 100,
      scrollTop: 10 * DIFF_ROW_HEIGHT_PX,
      viewportHeight: 10 * DIFF_ROW_HEIGHT_PX,
    });

    expect(DIFF_OVERSCAN_ROWS).toBe(0);
    expect(range).toMatchObject({ start: 10, end: 20 });
  });

  it("rejects invalid structural inputs instead of inventing fallback state", () => {
    expect(() =>
      calculateDiffVirtualRange({
        rowCount: -1,
        scrollTop: 0,
        viewportHeight: 100,
      }),
    ).toThrow("non-negative integer");
  });
});
