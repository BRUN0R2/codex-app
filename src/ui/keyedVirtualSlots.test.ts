import { describe, expect, it } from "vitest";

import { reconcileKeyedVirtualSlots } from "./keyedVirtualSlots";

describe("reconcileKeyedVirtualSlots", () => {
  const item = (key: string, reuseGroup = "activity") => ({ key, reuseGroup });

  it("preserves overlapping keys and reuses only slots that left the range", () => {
    const first = reconcileKeyedVirtualSlots([], [item("a"), item("b"), item("c")]);
    const second = reconcileKeyedVirtualSlots(first, [item("b"), item("c"), item("d")]);

    expect(second).toEqual([
      { index: 0, key: "b", reuseGroup: "activity", slotId: 1 },
      { index: 1, key: "c", reuseGroup: "activity", slotId: 2 },
      { index: 2, key: "d", reuseGroup: "activity", slotId: 0 },
    ]);
  });

  it("reserves overlapping slots before recycling a compatible predecessor", () => {
    const first = reconcileKeyedVirtualSlots([], [item("a"), item("b")]);
    const second = reconcileKeyedVirtualSlots(first, [item("new"), item("a")]);

    expect(second).toEqual([
      { index: 0, key: "new", reuseGroup: "activity", slotId: 1 },
      { index: 1, key: "a", reuseGroup: "activity", slotId: 0 },
    ]);
  });

  it("drops inactive slots and expands the active window predictably", () => {
    const first = reconcileKeyedVirtualSlots([], [item("a"), item("b"), item("c")]);
    const reduced = reconcileKeyedVirtualSlots(first, [item("b")]);
    const restored = reconcileKeyedVirtualSlots(reduced, [item("b"), item("c")]);

    expect(reduced).toEqual([{ index: 0, key: "b", reuseGroup: "activity", slotId: 1 }]);
    expect(restored).toEqual([
      { index: 0, key: "b", reuseGroup: "activity", slotId: 1 },
      { index: 1, key: "c", reuseGroup: "activity", slotId: 2 },
    ]);
  });

  it("reuses only structurally compatible slots across disjoint ranges", () => {
    const first = reconcileKeyedVirtualSlots([], [item("a", "command"), item("b", "diff")]);
    const second = reconcileKeyedVirtualSlots(first, [item("c", "diff"), item("d", "command")]);

    expect(second).toEqual([
      { index: 0, key: "c", reuseGroup: "diff", slotId: 1 },
      { index: 1, key: "d", reuseGroup: "command", slotId: 0 },
    ]);
  });

  it("recycles compatible disjoint windows without changing slot order", () => {
    const first = reconcileKeyedVirtualSlots([], [item("a"), item("b"), item("c")]);
    const second = reconcileKeyedVirtualSlots(first, [item("d"), item("e"), item("f")]);

    expect(second.map(({ slotId }) => slotId)).toEqual([0, 1, 2]);
  });

  it("reuses a uniform disjoint pool directly while growing and shrinking", () => {
    const previous = [
      { index: 0, key: "old-a", reuseGroup: "file", slotId: 7 },
      { index: 1, key: "old-b", reuseGroup: "file", slotId: 3 },
    ] as const;

    const grown = reconcileKeyedVirtualSlots(previous, [
      item("new-a", "file"),
      item("new-b", "file"),
      item("new-c", "file"),
    ]);
    expect(grown.map((slot) => slot.slotId)).toEqual([7, 3, 8]);

    const shrunk = reconcileKeyedVirtualSlots(grown, [item("final-a", "file")]);
    expect(shrunk).toEqual([{ index: 0, key: "final-a", reuseGroup: "file", slotId: 7 }]);
  });

  it("reconciles large disjoint windows with stable per-group queues", () => {
    const first = reconcileKeyedVirtualSlots(
      [],
      Array.from({ length: 100 }, (_, index) => item(`old-${index}`, String(index % 4))),
    );
    const second = reconcileKeyedVirtualSlots(
      first,
      Array.from({ length: 100 }, (_, index) => item(`new-${index}`, String(index % 4))),
    );

    expect(second.map(({ slotId }) => slotId)).toEqual(first.map(({ slotId }) => slotId));
  });

  it("rejects duplicate activity identities", () => {
    expect(() => reconcileKeyedVirtualSlots([], [item("same"), item("same")])).toThrow(
      "Virtual activity keys must be unique.",
    );
  });
});
