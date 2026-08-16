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

  it("normalizes fractional DOM measurements to stable whole-pixel offsets", () => {
    const virtualizer = new VariableSizeVirtualizer(100);
    virtualizer.setKeys(["a", "b"]);

    expect(virtualizer.measure("a", 100.49)).toBeNull();
    expect(virtualizer.measure("a", 100.51)).toEqual({ index: 0, delta: 1 });
    expect(virtualizer.measure("a", 100.52)).toBeNull();
    expect(virtualizer.offsetOf(1)).toBe(101);
    expect(Number.isInteger(virtualizer.totalSize())).toBe(true);
  });

  it("batches measurements into one deterministic anchor correction", () => {
    const virtualizer = new VariableSizeVirtualizer(100);
    virtualizer.setKeys(["a", "b", "c", "d"]);

    expect(
      virtualizer.measureBatch(
        [
          { key: "c", size: 160 },
          { key: "a", size: 130 },
          { key: "b", size: 80 },
        ],
        250,
      ),
    ).toEqual({ anchorDelta: 10, changed: true });
    expect(virtualizer.offsetOf(3)).toBe(370);
    expect(
      virtualizer.measureBatch(
        [
          { key: "a", size: 130.1 },
          { key: "b", size: 80.2 },
        ],
        260,
      ),
    ).toEqual({ anchorDelta: 0, changed: false });
  });
});
