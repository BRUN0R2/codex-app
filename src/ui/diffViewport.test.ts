import { describe, expect, it } from "vitest";

import {
  calculateDiffVirtualRange,
  DIFF_ROW_HEIGHT_PX,
  MAX_DIFF_CANVAS_HEIGHT_PX,
} from "./diffViewport";

describe("diff viewport", () => {
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
