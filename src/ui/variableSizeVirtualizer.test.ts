import { describe, expect, it } from "vitest";

import { VariableSizeVirtualizer } from "./variableSizeVirtualizer";

describe("variable-size timeline virtualizer", () => {
  it("keeps the rendered range bounded for very long histories", () => {
    const virtualizer = new VariableSizeVirtualizer(100);
    virtualizer.setKeys(Array.from({ length: 10_000 }, (_, index) => `turn-${index}`));
    const range = virtualizer.range(500_000, 800, 400);
    expect(range.end - range.start).toBeLessThanOrEqual(18);
    expect(virtualizer.totalSize()).toBe(1_000_000);
  });

  it("updates offsets logarithmically while preserving keyed measurements", () => {
    const virtualizer = new VariableSizeVirtualizer(100);
    virtualizer.setKeys(["a", "b", "c"]);
    expect(virtualizer.measure("b", 250)).toEqual({ index: 1, delta: 150 });
    expect(virtualizer.offsetOf(2)).toBe(350);
    virtualizer.setKeys(["older", "a", "b", "c"]);
    expect(virtualizer.offsetOf(3)).toBe(450);
    expect(virtualizer.totalSize()).toBe(550);
  });
});
