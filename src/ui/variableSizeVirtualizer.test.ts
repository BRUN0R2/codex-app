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

  it("reuses immutable key sources without rebuilding preserved measurements", () => {
    const virtualizer = new VariableSizeVirtualizer(100);
    const keys = ["a", "b"] as const;

    expect(virtualizer.setKeys(keys)).toBe(true);
    virtualizer.measure("a", 240);
    expect(virtualizer.setKeys(keys)).toBe(false);

    const equivalentKeys = [...keys];
    expect(virtualizer.setKeys(equivalentKeys)).toBe(false);
    expect(virtualizer.setKeys(equivalentKeys)).toBe(false);
    expect(virtualizer.totalSize()).toBe(340);
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
    const anchor = virtualizer.anchorAt(250);

    expect(
      virtualizer.measureBatch([
        { key: "c", size: 160 },
        { key: "a", size: 130 },
        { key: "b", size: 80 },
      ]),
    ).toEqual({ changed: true });
    expect(anchor).toEqual({ key: "c", offsetWithinItem: 50 });
    expect(anchor === null ? null : virtualizer.resolveAnchorOffset(anchor)).toBe(260);
    expect(virtualizer.offsetOf(3)).toBe(370);
    expect(
      virtualizer.measureBatch([
        { key: "a", size: 130.1 },
        { key: "b", size: 80.2 },
      ]),
    ).toEqual({ changed: false });
  });

  it("keeps an anchor attached to its key across prepends and measurement resets", () => {
    const virtualizer = new VariableSizeVirtualizer(100);
    virtualizer.setKeys(["b", "c"]);
    virtualizer.measure("b", 180);
    const anchor = virtualizer.anchorAt(210);

    expect(anchor).toEqual({ key: "c", offsetWithinItem: 30 });
    virtualizer.setKeys(["a", "b", "c"]);
    expect(anchor === null ? null : virtualizer.resolveAnchorOffset(anchor)).toBe(310);
    expect(virtualizer.resetMeasurements()).toBe(true);
    expect(anchor === null ? null : virtualizer.resolveAnchorOffset(anchor)).toBe(230);
    expect(virtualizer.resetMeasurements()).toBe(false);
  });

  it("uses semantic estimates and invalidates only measurements whose estimate changed", () => {
    const virtualizer = new VariableSizeVirtualizer(30);
    const collapsed = [
      { key: "first", estimatedSize: 30 },
      { key: "second", estimatedSize: 30 },
    ] as const;
    expect(virtualizer.setEstimatedItems(collapsed)).toBe(true);
    virtualizer.measure("first", 32);
    virtualizer.measure("second", 31);

    expect(
      virtualizer.setEstimatedItems([
        { key: "first", estimatedSize: 400 },
        { key: "second", estimatedSize: 30 },
      ]),
    ).toBe(true);
    expect(virtualizer.sizeOf(0)).toBe(400);
    expect(virtualizer.sizeOf(1)).toBe(31);
    expect(virtualizer.totalSize()).toBe(431);
  });

  it("updates one semantic estimate without rebuilding unrelated measurements", () => {
    const virtualizer = new VariableSizeVirtualizer(30);
    virtualizer.setEstimatedItems([
      { key: "first", estimatedSize: 30 },
      { key: "second", estimatedSize: 30 },
      { key: "third", estimatedSize: 30 },
    ]);
    virtualizer.measure("first", 42);
    virtualizer.measure("third", 44);

    expect(virtualizer.estimate("second", 400)).toBe(true);
    expect(virtualizer.totalSize()).toBe(486);
    expect(virtualizer.sizeOf(0)).toBe(42);
    expect(virtualizer.sizeOf(1)).toBe(400);
    expect(virtualizer.sizeOf(2)).toBe(44);
    expect(virtualizer.estimatedSizeOf("second")).toBe(400);
    expect(virtualizer.estimatedSizeOf("missing")).toBeNull();
    expect(virtualizer.estimate("second", 400)).toBe(false);
  });

  it("restores uniform estimates after sparse expanded rows are cleared", () => {
    const virtualizer = new VariableSizeVirtualizer(30);
    virtualizer.setKeys(["first", "second", "third"]);
    virtualizer.estimate("second", 400);
    virtualizer.measure("first", 42);

    expect(virtualizer.resetEstimates()).toBe(true);
    expect(virtualizer.totalSize()).toBe(90);
    expect(virtualizer.estimatedSizeOf("second")).toBe(30);
    expect(virtualizer.resetEstimates()).toBe(false);
  });

  it("bounds the mounted range for one hundred thousand expanded file rows", () => {
    const virtualizer = new VariableSizeVirtualizer(30);
    virtualizer.setEstimatedItems(
      Array.from({ length: 100_000 }, (_, index) => ({
        key: `file-${index}`,
        estimatedSize: 400,
      })),
    );

    const range = virtualizer.range(20_000_000, 900, 900);
    expect(virtualizer.totalSize()).toBe(40_000_000);
    expect(range.end - range.start).toBeLessThanOrEqual(8);
  });

  it("indexes one hundred thousand source items without materializing their keys", () => {
    let keyReads = 0;
    const source = {
      count: 100_000,
      estimatedOffsetOf: (index: number) => index * 26,
      estimatedSizeAt: () => 26,
      identity: {},
      indexOf: (key: string) => {
        const index = Number(key.slice("file-".length));
        return Number.isInteger(index) && index >= 0 && index < 100_000 ? index : null;
      },
      keyAt: (index: number) => {
        keyReads += 1;
        return `file-${index}`;
      },
    } as const;
    const virtualizer = new VariableSizeVirtualizer(30);

    expect(virtualizer.setItemSource(source)).toBe(true);
    expect(virtualizer.totalSize()).toBe(2_600_000);
    expect(virtualizer.range(1_300_000, 900, 0)).toEqual({ start: 50_000, end: 50_035 });
    expect(keyReads).toBe(0);
    expect(virtualizer.anchorAt(1_300_013)).toEqual({
      key: "file-50000",
      offsetWithinItem: 13,
    });
    expect(keyReads).toBe(1);
  });

  it("keeps sparse measurements exact over nonuniform indexed estimates", () => {
    const source = {
      count: 4,
      estimatedOffsetOf: (index: number) => [0, 26, 54, 80, 108][index] ?? 108,
      estimatedSizeAt: (index: number) => [26, 28, 26, 28][index] ?? 28,
      identity: {},
      indexOf: (key: string) => {
        const index = ["first", "second", "third", "fourth"].indexOf(key);
        return index < 0 ? null : index;
      },
      keyAt: (index: number) => ["first", "second", "third", "fourth"][index] ?? "",
    } as const;
    const virtualizer = new VariableSizeVirtualizer(30);
    virtualizer.setItemSource(source);

    expect(virtualizer.totalSize()).toBe(108);
    expect(virtualizer.measure("second", 80)).toEqual({ delta: 52, index: 1 });
    expect(virtualizer.offsetOf(2)).toBe(106);
    expect(virtualizer.totalSize()).toBe(160);
    expect(virtualizer.range(105, 1, 0)).toEqual({ start: 1, end: 3 });
  });

  it("updates a materialized estimate set without rebuilding its semantic keys", () => {
    const virtualizer = new VariableSizeVirtualizer(30);
    const keys = ["first", "second", "third"] as const;
    virtualizer.setEstimatedKeys(keys, () => 30);

    expect(virtualizer.updateEstimatedSizes((_key, index) => (index === 1 ? 400 : 30))).toBe(true);
    expect(virtualizer.totalSize()).toBe(460);
    expect(virtualizer.updateEstimatedSizes((_key, index) => (index === 1 ? 400 : 30))).toBe(false);
  });

  it("accepts indexed semantic estimates without allocating item records", () => {
    const virtualizer = new VariableSizeVirtualizer(30);
    const keys = ["first", "second", "third"] as const;
    const estimateAt = (_key: string, index: number) => (index === 1 ? 400 : 30);

    expect(virtualizer.setEstimatedKeys(keys, estimateAt)).toBe(true);
    expect(virtualizer.totalSize()).toBe(460);
    expect(virtualizer.setEstimatedKeys(keys, estimateAt)).toBe(false);
    expect(virtualizer.estimatedSizeOf("second")).toBe(400);
  });

  it("rejects invalid estimates and out-of-range size reads", () => {
    const virtualizer = new VariableSizeVirtualizer(30);
    expect(() =>
      virtualizer.setEstimatedItems([{ key: "invalid", estimatedSize: Number.NaN }]),
    ).toThrow("positive finite");
    expect(() => virtualizer.sizeOf(0)).toThrow("existing item");
  });
});
