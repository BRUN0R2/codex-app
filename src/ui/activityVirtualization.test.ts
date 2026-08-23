import { describe, expect, it } from "vitest";

import {
  ActivityVirtualizerStore,
  resolveActivityAnchorCorrection,
  resolveActivityViewport,
  shouldDeferActivityContent,
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
});

describe("activity viewport geometry", () => {
  it("maps the outer timeline viewport into list-local coordinates", () => {
    expect(resolveActivityViewport({ listTop: 400, scrollTop: 550, viewportSize: 720 })).toEqual({
      offset: 150,
      size: 720,
    });
  });

  it("keeps the scroll anchor stable when measurements above it change", () => {
    expect(resolveActivityAnchorCorrection(360, 540)).toBe(180);
    expect(resolveActivityAnchorCorrection(null, 540)).toBe(0);
  });

  it("defers heavy activity bodies only for large viewport jumps", () => {
    expect(shouldDeferActivityContent(24, 720)).toBe(false);
    expect(shouldDeferActivityContent(180, 720)).toBe(true);
    expect(shouldDeferActivityContent(Number.NaN, 720)).toBe(false);
  });
});
