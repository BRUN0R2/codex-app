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

  it("preserves every position invariant through ten thousand deterministic mixed transitions", () => {
    const reuseGroups = new Map<string, string>();
    let randomState = 0x6d2b79f5;
    let nextKey = 0;
    let previous = reconcileKeyedVirtualSlots([], []);
    let activeItems: ReturnType<typeof item>[] = [];
    const random = () => {
      randomState = Math.imul(randomState ^ (randomState >>> 15), randomState | 1);
      randomState ^= randomState + Math.imul(randomState ^ (randomState >>> 7), randomState | 61);
      return ((randomState ^ (randomState >>> 14)) >>> 0) / 4_294_967_296;
    };
    const assertInvariant = (condition: boolean, message: string) => {
      if (!condition) {
        throw new Error(message);
      }
    };

    for (let transition = 0; transition < 10_000; transition += 1) {
      const retained = activeItems.filter(() => random() >= 0.34);
      for (let index = retained.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        const current = retained[index];
        const swap = retained[swapIndex];
        if (current === undefined || swap === undefined) {
          throw new Error("The randomized virtual window cannot shuffle a missing item.");
        }
        retained[index] = swap;
        retained[swapIndex] = current;
      }
      const additions = Math.floor(random() * 7);
      for (let index = 0; index < additions; index += 1) {
        const key = `generated-${nextKey}`;
        const reuseGroup = `group-${Math.floor(random() * 4)}`;
        nextKey += 1;
        reuseGroups.set(key, reuseGroup);
        retained.splice(Math.floor(random() * (retained.length + 1)), 0, item(key, reuseGroup));
      }
      activeItems = retained.slice(0, 96);

      const previousByKey = new Map(previous.map((slot) => [slot.key, slot]));
      const previousBySlotId = new Map(previous.map((slot) => [slot.slotId, slot]));
      const next = reconcileKeyedVirtualSlots(previous, activeItems);

      assertInvariant(next.length === activeItems.length, "The reconciled window changed length.");
      assertInvariant(
        new Set(next.map((slot) => slot.key)).size === next.length,
        "The reconciled window duplicated a key.",
      );
      assertInvariant(
        new Set(next.map((slot) => slot.slotId)).size === next.length,
        "The reconciled window assigned one DOM slot twice.",
      );
      for (let index = 0; index < next.length; index += 1) {
        const slot = next[index];
        const expected = activeItems[index];
        if (slot === undefined || expected === undefined) {
          throw new Error("The randomized virtual window is incomplete.");
        }
        assertInvariant(slot.index === index, "A slot lost its sequence position.");
        assertInvariant(slot.key === expected.key, "A slot received the wrong key.");
        assertInvariant(
          slot.reuseGroup === expected.reuseGroup && slot.reuseGroup === reuseGroups.get(slot.key),
          "A slot received an unstable reuse group.",
        );
        const retainedSlot = previousByKey.get(slot.key);
        if (retainedSlot !== undefined) {
          assertInvariant(
            slot.slotId === retainedSlot.slotId,
            "A retained key changed its DOM slot.",
          );
          continue;
        }
        const recycledSlot = previousBySlotId.get(slot.slotId);
        if (recycledSlot !== undefined) {
          assertInvariant(
            !activeItems.some((active) => active.key === recycledSlot.key),
            "An active predecessor slot was recycled.",
          );
          assertInvariant(
            slot.reuseGroup === recycledSlot.reuseGroup,
            "A slot was recycled across incompatible structures.",
          );
        }
      }
      previous = next;
    }
    expect(nextKey).toBeGreaterThan(10_000);
  });
});
