import { createComputed, createRoot } from "solid-js";
import { describe, expect, it } from "vitest";

import { createKeyedVirtualRenderSlotStore } from "./keyedVirtualRenderSlots";

interface TestSource {
  readonly entries: readonly { readonly key: string; readonly value: string }[];
  readonly revision: number;
  readonly startIndex: number;
}

describe("keyed virtual render slots", () => {
  const commandKey =
    "16:commandExecution|53:fc_0dcf3068ac8a016b016a8d7160898c87d28d89439526a8ea4b|";
  const items = (source: TestSource) =>
    source.entries.map((entry) => ({ key: entry.key, reuseGroup: "commandExecution" }));
  const readKey = (source: TestSource, index: number) => {
    const entry = source.entries[index - source.startIndex];
    if (entry === undefined) {
      throw new Error(`Missing virtual entry at ${index}.`);
    }
    return entry.key;
  };
  const readReuseGroup = () => "commandExecution";
  const read = (source: TestSource, index: number, expectedKey: string) => {
    const entry = source.entries[index - source.startIndex];
    if (entry?.key !== expectedKey) {
      throw new Error(`${expectedKey} lost its position.`);
    }
    return entry.value;
  };

  it("keeps source, key, and index coherent while a streaming insertion shifts retained items", () => {
    createRoot((dispose) => {
      const previousSource = {
        revision: 1,
        startIndex: 0,
        entries: [
          { key: "reasoning", value: "Pensando" },
          { key: commandKey, value: "Executando" },
        ],
      } as const satisfies TestSource;
      const nextSource = {
        revision: 2,
        startIndex: 0,
        entries: [
          { key: "new-command", value: "Novo comando" },
          { key: "reasoning", value: "Pensando" },
          { key: commandKey, value: "Executou" },
        ],
      } as const satisfies TestSource;
      const store = createKeyedVirtualRenderSlotStore<TestSource>();

      store.reconcileRange(
        previousSource,
        0,
        previousSource.entries.length,
        readKey,
        readReuseGroup,
      );
      const retainedCommandSlot = store.slots().find((slot) => slot.position().key === commandKey);
      if (retainedCommandSlot === undefined) {
        throw new Error("The command render slot was not created.");
      }
      const stalePosition = retainedCommandSlot.position();
      expect(() => read(nextSource, stalePosition.index, stalePosition.key)).toThrow(
        "lost its position",
      );
      expect(read(stalePosition.source, stalePosition.index, stalePosition.key)).toBe("Executando");

      const coherentValues: string[] = [];
      createComputed(() => {
        const position = retainedCommandSlot.position();
        coherentValues.push(read(position.source, position.index, position.key));
      });

      store.reconcileRange(nextSource, 0, nextSource.entries.length, readKey, readReuseGroup);
      const currentCommandSlot = store.slots().find((slot) => slot.position().key === commandKey);
      expect(currentCommandSlot).toBe(retainedCommandSlot);
      const currentPosition = retainedCommandSlot.position();
      expect(currentPosition).toEqual({
        active: true,
        index: 2,
        key: commandKey,
        source: nextSource,
      });
      expect(read(currentPosition.source, currentPosition.index, currentPosition.key)).toBe(
        "Executou",
      );
      expect(coherentValues).toEqual(["Executando", "Executou"]);
      for (const slot of store.slots()) {
        const position = slot.position();
        expect(() => read(position.source, position.index, position.key)).not.toThrow();
      }
      dispose();
    });
  });

  it("refreshes content sources without recreating an unchanged slot sequence", () => {
    createRoot((dispose) => {
      const initial = {
        revision: 1,
        startIndex: 40,
        entries: [{ key: commandKey, value: "Executando" }],
      } as const satisfies TestSource;
      const completed = {
        revision: 2,
        startIndex: 40,
        entries: [{ key: commandKey, value: "Executou" }],
      } as const satisfies TestSource;
      const store = createKeyedVirtualRenderSlotStore<TestSource>();

      store.reconcile(initial, 40, items(initial));
      const sequence = store.slots();
      const slot = sequence[0];
      if (slot === undefined) {
        throw new Error("The command render slot was not created.");
      }
      store.reconcile(completed, 40, items(completed));

      expect(store.slots()).toBe(sequence);
      expect(store.slots()[0]).toBe(slot);
      expect(slot.position()).toEqual({
        active: true,
        index: 40,
        key: commandKey,
        source: completed,
      });
      expect(read(completed, slot.position().index, slot.position().key)).toBe("Executou");
      dispose();
    });
  });

  it("retains a DOM slot for one intermediate nonuniform virtual window", () => {
    createRoot((dispose) => {
      const source = {
        revision: 1,
        startIndex: 0,
        entries: [
          { key: "command-0", value: "zero" },
          { key: "command-1", value: "one" },
          { key: "command-2", value: "two" },
        ],
      } as const satisfies TestSource;
      const store = createKeyedVirtualRenderSlotStore<TestSource>();

      store.reconcileRange(source, 0, 1, readKey, readReuseGroup, 1);
      const firstSlot = store.slots()[0];
      if (firstSlot === undefined) {
        throw new Error("The first render slot was not created.");
      }

      store.reconcileRange(source, 1, 2, readKey, readReuseGroup, 1);
      expect(store.slots()).toHaveLength(2);
      expect(firstSlot.position()).toEqual({
        active: false,
        index: 0,
        key: "command-0",
        source,
      });

      store.reconcileRange(source, 0, 1, readKey, readReuseGroup, 1);
      expect(store.slots()[0]).toBe(firstSlot);
      expect(firstSlot.position()).toEqual({
        active: true,
        index: 0,
        key: "command-0",
        source,
      });
      dispose();
    });
  });

  it("bounds retained slots to one previous nonuniform window", () => {
    createRoot((dispose) => {
      const source = {
        revision: 1,
        startIndex: 0,
        entries: Array.from({ length: 256 }, (_, index) => ({
          key: `command-${index}`,
          value: String(index),
        })),
      } satisfies TestSource;
      const store = createKeyedVirtualRenderSlotStore<TestSource>();
      const slotIds = new Set<number>();

      for (let index = 0; index < source.entries.length; index += 1) {
        store.reconcileRange(source, index, index + 1, readKey, readReuseGroup, 1);
        expect(store.slots().length).toBeLessThanOrEqual(2);
        for (const slot of store.slots()) {
          slotIds.add(slot.slotId);
        }
      }

      expect(slotIds.size).toBe(2);
      store.reconcileRange(source, 0, 0, readKey, readReuseGroup, 1);
      expect(store.slots()).toEqual([]);
      dispose();
    });
  });

  it("retains only the nearest leaving slots at a configured boundary", () => {
    createRoot((dispose) => {
      const source = {
        revision: 1,
        startIndex: 0,
        entries: Array.from({ length: 8 }, (_, index) => ({
          key: `command-${index}`,
          value: String(index),
        })),
      } satisfies TestSource;
      const store = createKeyedVirtualRenderSlotStore<TestSource>();

      store.reconcileRange(source, 0, 5, readKey, readReuseGroup, 2);
      store.reconcileRange(source, 3, 8, readKey, readReuseGroup, 2);

      const retainedKeys = store
        .slots()
        .filter((slot) => !slot.position().active)
        .map((slot) => slot.position().key)
        .sort();
      expect(retainedKeys).toEqual(["command-1", "command-2"]);
      expect(store.slots()).toHaveLength(7);
      dispose();
    });
  });

  it("keeps an append-only render pool while active windows change order", () => {
    createRoot((dispose) => {
      const source = {
        revision: 1,
        startIndex: 0,
        entries: Array.from({ length: 8 }, (_, index) => ({
          key: `command-${index}`,
          value: String(index),
        })),
      } satisfies TestSource;
      const store = createKeyedVirtualRenderSlotStore<TestSource>();

      store.reconcileRange(source, 0, 4, readKey, readReuseGroup, 1);
      const initialRenderSlots = store.renderSlots();
      const initialSlotIds = initialRenderSlots.map((slot) => slot.slotId);

      store.reconcileRange(source, 2, 6, readKey, readReuseGroup, 1);
      const forwardRenderSlots = store.renderSlots();
      expect(forwardRenderSlots.slice(0, initialRenderSlots.length)).toEqual(initialRenderSlots);
      expect(forwardRenderSlots.map((slot) => slot.slotId).slice(0, initialSlotIds.length)).toEqual(
        initialSlotIds,
      );

      store.reconcileRange(source, 0, 4, readKey, readReuseGroup, 1);
      expect(store.renderSlots()).toBe(forwardRenderSlots);
      expect(store.renderSlots().map((slot) => slot.slotId)).toEqual(
        forwardRenderSlots.map((slot) => slot.slotId),
      );
      expect(store.renderSlots().filter((slot) => slot.position().active)).toHaveLength(4);
      dispose();
    });
  });

  it("rejects duplicate keys before mutating render slots", () => {
    createRoot((dispose) => {
      const source = {
        revision: 1,
        startIndex: 0,
        entries: [
          { key: commandKey, value: "one" },
          { key: commandKey, value: "two" },
        ],
      } as const satisfies TestSource;
      const store = createKeyedVirtualRenderSlotStore<TestSource>();

      expect(() =>
        store.reconcileRange(source, 0, source.entries.length, readKey, readReuseGroup),
      ).toThrow("Virtual activity keys must be unique.");
      expect(store.slots()).toEqual([]);
      dispose();
    });
  });

  it("rejects invalid retained slot limits before mutating render slots", () => {
    createRoot((dispose) => {
      const source = {
        revision: 1,
        startIndex: 0,
        entries: [{ key: commandKey, value: "one" }],
      } as const satisfies TestSource;
      const store = createKeyedVirtualRenderSlotStore<TestSource>();

      expect(() => store.reconcileRange(source, 0, 1, readKey, readReuseGroup, -1)).toThrow(
        "retained slot limits must be non-negative integers",
      );
      expect(store.slots()).toEqual([]);
      dispose();
    });
  });
});
