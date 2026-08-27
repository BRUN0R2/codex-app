import { describe, expect, it } from "vitest";

import {
  ActivityVirtualizerStore,
  includeRetainedActivityAnchor,
  isActivityListNearViewport,
  isCurrentActivityMeasurement,
  overscanActivityVirtualRange,
  resolveActivityViewport,
  retainContainingActivityVirtualRange,
  shouldDeferActivityContent,
  shouldMaterializeActivityBody,
  shouldMinimizeActivityOverscan,
} from "./activityVirtualization";

describe("ActivityVirtualizerStore", () => {
  it("retains measurements while a group is temporarily unmounted", () => {
    const store = new ActivityVirtualizerStore(30, 4);
    const keys = ["first", "second", "third"];
    const first = store.activate("thread:group", keys, "800:14:unified");
    first.virtualizer.measure("first", 240);

    const restored = store.activate("thread:group", [...keys], "800:14:unified");

    expect(restored.virtualizer).toBe(first.virtualizer);
    expect(restored.virtualizer.offsetOf(1)).toBe(240);
  });

  it("invalidates size measurements when the layout signature changes", () => {
    const store = new ActivityVirtualizerStore(30, 4);
    const first = store.activate("thread:group", ["first", "second"], "800:14:unified");
    first.virtualizer.measure("first", 240);

    const resized = store.activate("thread:group", ["first", "second"], "600:16:split");

    expect(resized.measurementsReset).toBe(true);
    expect(resized.virtualizer.offsetOf(1)).toBe(30);
  });

  it("evicts the least recently used inactive group", () => {
    const store = new ActivityVirtualizerStore(30, 2);
    const first = store.activate("first", ["item"], null).virtualizer;
    const second = store.activate("second", ["item"], null).virtualizer;
    expect(store.activate("first", ["item"], null).virtualizer).toBe(first);
    store.activate("third", ["item"], null);

    expect(store.activate("first", ["item"], null).virtualizer).toBe(first);
    expect(store.activate("second", ["item"], null).virtualizer).not.toBe(second);
  });

  it("replaces stale expanded measurements after a parent clears its disclosure subtree", () => {
    const store = new ActivityVirtualizerStore(30, 4);
    const keys = ["first", "second"];
    const expanded = store.activate("thread:group", keys, "800:14:unified", 0, () => 400);
    expanded.virtualizer.measure("first", 412);
    expanded.virtualizer.measure("second", 408);

    const collapsed = store.activate("thread:group", keys, "800:14:unified", 1, () => 30);

    expect(collapsed.measurementsReset).toBe(true);
    expect(collapsed.virtualizer.totalSize()).toBe(60);
  });

  it("switches a retained group back to uniform estimates without rescanning every key", () => {
    const store = new ActivityVirtualizerStore(30, 4);
    const keys = ["first", "second", "third"];
    const collapsed = store.activate("thread:group", keys, "800:14:unified");
    collapsed.virtualizer.estimate("second", 400);

    store.activate("thread:group", keys, "800:14:unified", 0, () => 30);
    const uniform = store.activate("thread:group", keys, "800:14:unified");

    expect(uniform.keysChanged).toBe(true);
    expect(uniform.measurementsReset).toBe(true);
    expect(uniform.virtualizer.totalSize()).toBe(90);
  });

  it("clears sparse expanded estimates when a uniform subtree revision changes", () => {
    const store = new ActivityVirtualizerStore(30, 4);
    const keys = ["first", "second", "third"];
    const expanded = store.activate("thread:group", keys, "800:14:unified", 0);
    expanded.virtualizer.estimate("second", 400);

    const collapsed = store.activate("thread:group", keys, "800:14:unified", 1);

    expect(collapsed.keysChanged).toBe(true);
    expect(collapsed.measurementsReset).toBe(true);
    expect(collapsed.virtualizer.totalSize()).toBe(90);
  });

  it("supplies stable collection indexes to nonuniform estimators", () => {
    const store = new ActivityVirtualizerStore(30, 4);
    const keys = ["first", "second", "third"];
    const visited: Array<readonly [string, number]> = [];

    const activation = store.activate("thread:group", keys, "800:14:unified", 0, (key, index) => {
      visited.push([key, index]);
      return 30 + index;
    });

    expect(visited).toEqual([
      ["first", 0],
      ["second", 1],
      ["third", 2],
    ]);
    expect(activation.virtualizer.totalSize()).toBe(93);
  });

  it("keeps extreme indexed collections lazy while applying visible estimates sparsely", () => {
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
    const store = new ActivityVirtualizerStore(30, 4);

    const activation = store.activateSource(
      "thread:massive-group",
      source,
      "1920:14:unified",
      0,
      26,
      () => 398,
    );

    expect(keyReads).toBe(0);
    expect(activation.estimatesComplete).toBe(false);
    expect(activation.virtualizer.totalSize()).toBe(2_600_000);
    expect(activation.virtualizer.estimate("file-50000", 398)).toBe(true);
    expect(activation.virtualizer.totalSize()).toBe(2_600_372);
    expect(keyReads).toBe(1);
  });

  it("reports a pending exact estimate revision without mutating outside an anchor transaction", () => {
    let expanded = false;
    const source = {
      count: 3,
      estimatedOffsetOf: (index: number) => index * 30,
      estimatedSizeAt: () => 30,
      identity: {},
      indexOf: (key: string) => ["a", "b", "c"].indexOf(key),
      keyAt: (index: number) => ["a", "b", "c"][index] ?? "",
    } as const;
    const estimate = () => (expanded ? 400 : 30);
    const store = new ActivityVirtualizerStore(30, 4);
    const initial = store.activateSource("group", source, null, 0, undefined, estimate, 0);
    expanded = true;
    const pending = store.activateSource("group", source, null, 0, undefined, estimate, 1);

    expect(initial.appliedEstimateRevision).toBe(0);
    expect(pending.appliedEstimateRevision).toBe(0);
    expect(pending.virtualizer.totalSize()).toBe(90);
    expect(pending.virtualizer.updateEstimatedSizes(estimate)).toBe(true);
    expect(pending.virtualizer.totalSize()).toBe(1_200);
  });
});

describe("isCurrentActivityMeasurement", () => {
  const captured = {
    contentRevision: 3,
    estimatedSize: 26,
    layoutSignature: "800:14:unified",
  } as const;

  it("accepts a measurement from the current semantic layout", () => {
    expect(isCurrentActivityMeasurement(captured, { ...captured })).toBe(true);
  });

  it.each([
    { ...captured, contentRevision: 4 },
    { ...captured, estimatedSize: 400 },
    { ...captured, layoutSignature: "600:14:unified" },
  ])("rejects a stale measurement from %o", (current) => {
    expect(isCurrentActivityMeasurement(captured, current)).toBe(false);
  });
});

describe("activity viewport geometry", () => {
  it("adds a fixed item overscan without crossing collection boundaries", () => {
    expect(overscanActivityVirtualRange({ start: 0, end: 4 }, 180, 2)).toEqual({
      start: 0,
      end: 6,
    });
    expect(overscanActivityVirtualRange({ start: 176, end: 180 }, 180, 2)).toEqual({
      start: 174,
      end: 180,
    });
    expect(overscanActivityVirtualRange({ start: 80, end: 88 }, 180, 2)).toEqual({
      start: 78,
      end: 90,
    });
  });

  it("retains a rendered range while it still contains the requested range", () => {
    const previous = { start: 20, end: 40 };

    expect(retainContainingActivityVirtualRange(previous, { start: 24, end: 36 })).toBe(previous);
    expect(retainContainingActivityVirtualRange(previous, { start: 12, end: 36 })).toEqual({
      start: 12,
      end: 36,
    });
    expect(retainContainingActivityVirtualRange(undefined, { start: 24, end: 36 })).toEqual({
      start: 24,
      end: 36,
    });
  });

  it("retains a measured anchor only while the rendered and requested ranges remain adjacent", () => {
    expect(
      includeRetainedActivityAnchor({ start: 20, end: 30 }, { start: 28, end: 36 }, 22),
    ).toEqual({
      start: 22,
      end: 36,
    });
    expect(
      includeRetainedActivityAnchor({ start: 20, end: 30 }, { start: 80, end: 88 }, 22),
    ).toEqual({
      start: 80,
      end: 88,
    });
    expect(
      includeRetainedActivityAnchor({ start: 20, end: 30 }, { start: 28, end: 36 }, 18),
    ).toEqual({
      start: 28,
      end: 36,
    });
  });

  it("maps the outer timeline viewport into list-local coordinates", () => {
    expect(resolveActivityViewport({ listTop: 400, scrollTop: 550, viewportSize: 720 })).toEqual({
      offset: 150,
      size: 720,
    });
  });

  it("derives list visibility from the current viewport after rapid scroll reversals", () => {
    const list = {
      listSize: 1_200,
      listTop: 2_400,
      overscanViewports: 1,
      viewportSize: 600,
    } as const;

    expect(isActivityListNearViewport({ ...list, scrollTop: 4_800 })).toBe(false);
    expect(isActivityListNearViewport({ ...list, scrollTop: 2_650 })).toBe(true);
    expect(isActivityListNearViewport({ ...list, scrollTop: 100 })).toBe(false);
    expect(isActivityListNearViewport({ ...list, scrollTop: 2_100 })).toBe(true);
  });

  it("keeps intersection boundaries inclusive across the overscan margin", () => {
    const list = {
      listSize: 400,
      listTop: 1_600,
      overscanViewports: 1,
      viewportSize: 500,
    } as const;

    expect(isActivityListNearViewport({ ...list, scrollTop: 600 })).toBe(true);
    expect(isActivityListNearViewport({ ...list, scrollTop: 599 })).toBe(false);
    expect(isActivityListNearViewport({ ...list, scrollTop: 2_500 })).toBe(true);
    expect(isActivityListNearViewport({ ...list, scrollTop: 2_501 })).toBe(false);
  });

  it("defers heavy activity bodies only for large viewport jumps", () => {
    expect(shouldDeferActivityContent(24, 720)).toBe(false);
    expect(shouldDeferActivityContent(87, 720)).toBe(true);
    expect(shouldDeferActivityContent(Number.NaN, 720)).toBe(false);
  });

  it("minimizes overscan only for high-velocity viewport jumps", () => {
    expect(shouldMinimizeActivityOverscan(575, 720)).toBe(false);
    expect(shouldMinimizeActivityOverscan(576, 720)).toBe(true);
    expect(shouldMinimizeActivityOverscan(-900, 720)).toBe(true);
    expect(shouldMinimizeActivityOverscan(Number.NaN, 720)).toBe(false);
  });

  it("always materializes visible bodies while deferring only offscreen overscan", () => {
    expect(shouldMaterializeActivityBody(12, 12, 18, true)).toBe(true);
    expect(shouldMaterializeActivityBody(17, 12, 18, true)).toBe(true);
    expect(shouldMaterializeActivityBody(11, 12, 18, true)).toBe(false);
    expect(shouldMaterializeActivityBody(18, 12, 18, true)).toBe(false);
    expect(shouldMaterializeActivityBody(11, 12, 18, false)).toBe(true);
  });
});
