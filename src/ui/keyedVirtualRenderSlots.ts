import { type Accessor, batch, createSignal } from "solid-js";

import type { KeyedVirtualItem } from "./keyedVirtualSlots";

export interface KeyedVirtualRenderPosition<TSource> {
  readonly active: boolean;
  readonly index: number;
  readonly key: string;
  readonly source: TSource;
}

interface MutableKeyedVirtualRenderPosition<TSource> {
  active: boolean;
  index: number;
  key: string;
  source: TSource;
}

export interface KeyedVirtualRenderSlot<TSource> {
  readonly position: Accessor<KeyedVirtualRenderPosition<TSource>>;
  readonly slotId: number;
}

interface MutableKeyedVirtualRenderSlot<TSource> extends KeyedVirtualRenderSlot<TSource> {
  readonly reuseGroup: string;
  readonly updatePosition: (source: TSource, key: string, index: number, active: boolean) => void;
}

export interface KeyedVirtualRenderSlotStore<TSource> {
  readonly reconcile: (
    source: TSource,
    startIndex: number,
    items: readonly KeyedVirtualItem[],
  ) => void;
  readonly reconcileRange: (
    source: TSource,
    startIndex: number,
    endIndex: number,
    readKey: (source: TSource, index: number) => string,
    readReuseGroup: (source: TSource, key: string, index: number) => string,
    retainedSlotLimit?: number,
  ) => void;
  readonly renderSlots: Accessor<readonly KeyedVirtualRenderSlot<TSource>[]>;
  readonly slots: Accessor<readonly KeyedVirtualRenderSlot<TSource>[]>;
}

export function createKeyedVirtualRenderSlotStore<TSource>(): KeyedVirtualRenderSlotStore<TSource> {
  let hasPositionSnapshot = false;
  let nextSlotId = 0;
  let positionSource: TSource;
  let positionStartIndex = 0;
  let retentionLimit = 0;
  let activeSequence: readonly MutableKeyedVirtualRenderSlot<TSource>[] = [];
  let retainedSequence: readonly MutableKeyedVirtualRenderSlot<TSource>[] = [];
  let renderedSequence: readonly MutableKeyedVirtualRenderSlot<TSource>[] = [];
  const renderPool: MutableKeyedVirtualRenderSlot<TSource>[] = [];
  const firstActiveBuffer: MutableKeyedVirtualRenderSlot<TSource>[] = [];
  const secondActiveBuffer: MutableKeyedVirtualRenderSlot<TSource>[] = [];
  const firstRetainedBuffer: MutableKeyedVirtualRenderSlot<TSource>[] = [];
  const secondRetainedBuffer: MutableKeyedVirtualRenderSlot<TSource>[] = [];
  const firstRenderedBuffer: MutableKeyedVirtualRenderSlot<TSource>[] = [];
  const secondRenderedBuffer: MutableKeyedVirtualRenderSlot<TSource>[] = [];
  const activeKeys = new Set<string>();
  const presentSlotIds = new Set<number>();
  const reservedRetainedSlotIds = new Set<number>();
  const reusableSlotsByGroup = new Map<string, MutableKeyedVirtualRenderSlot<TSource>[]>();
  const keyBuffer: string[] = [];
  const reuseGroupBuffer: string[] = [];
  const slotsByKey = new Map<string, MutableKeyedVirtualRenderSlot<TSource>>();
  const [renderSlots, setRenderSlots] = createSignal<readonly KeyedVirtualRenderSlot<TSource>[]>(
    [],
  );
  const [slots, setSlots] = createSignal<readonly KeyedVirtualRenderSlot<TSource>[]>([]);

  function reconcileRange(
    source: TSource,
    startIndex: number,
    endIndex: number,
    readKey: (source: TSource, index: number) => string,
    readReuseGroup: (source: TSource, key: string, index: number) => string,
    retainedSlotLimit = 0,
  ): void {
    if (
      !Number.isSafeInteger(startIndex) ||
      startIndex < 0 ||
      !Number.isSafeInteger(endIndex) ||
      endIndex < startIndex
    ) {
      throw new Error("Virtual activity render windows require a non-negative start index.");
    }
    if (!Number.isSafeInteger(retainedSlotLimit) || retainedSlotLimit < 0) {
      throw new Error("Virtual activity retained slot limits must be non-negative integers.");
    }
    const itemCount = endIndex - startIndex;
    activeKeys.clear();
    keyBuffer.length = itemCount;
    reuseGroupBuffer.length = itemCount;
    for (let localIndex = 0; localIndex < itemCount; localIndex += 1) {
      const index = startIndex + localIndex;
      const key = readKey(source, index);
      if (activeKeys.has(key)) {
        throw new Error("Virtual activity keys must be unique.");
      }
      activeKeys.add(key);
      keyBuffer[localIndex] = key;
      reuseGroupBuffer[localIndex] = readReuseGroup(source, key, index);
    }
    let sameSequence = activeSequence.length === itemCount;
    for (let localIndex = 0; sameSequence && localIndex < itemCount; localIndex += 1) {
      const slot = activeSequence[localIndex];
      sameSequence =
        slot !== undefined &&
        slot.position().key === keyBuffer[localIndex] &&
        slot.reuseGroup === reuseGroupBuffer[localIndex];
    }
    if (
      sameSequence &&
      retentionLimit === retainedSlotLimit &&
      hasPositionSnapshot &&
      positionSource === source &&
      positionStartIndex === startIndex
    ) {
      return;
    }
    if (sameSequence && retentionLimit === retainedSlotLimit) {
      batch(() => {
        for (let localIndex = 0; localIndex < itemCount; localIndex += 1) {
          const slot = activeSequence[localIndex];
          const key = keyBuffer[localIndex];
          if (slot === undefined || key === undefined) {
            throw new Error("Virtual activity render buffers lost an item.");
          }
          slot.updatePosition(source, key, startIndex + localIndex, true);
        }
        hasPositionSnapshot = true;
        positionSource = source;
        positionStartIndex = startIndex;
      });
      return;
    }

    slotsByKey.clear();
    for (const slot of renderPool) {
      slotsByKey.set(slot.position().key, slot);
    }
    reservedRetainedSlotIds.clear();
    const nextActive =
      activeSequence === firstActiveBuffer ? secondActiveBuffer : firstActiveBuffer;
    const nextRetained =
      retainedSequence === firstRetainedBuffer ? secondRetainedBuffer : firstRetainedBuffer;
    const nextRendered =
      renderedSequence === firstRenderedBuffer ? secondRenderedBuffer : firstRenderedBuffer;
    nextActive.length = itemCount;
    nextRetained.length = 0;
    reserveNearestLeavingSlots({
      activeKeys,
      activeSequence,
      previousStartIndex: positionStartIndex,
      reservedSlotIds: reservedRetainedSlotIds,
      retainedSlotLimit,
      startIndex,
    });
    indexReusableSlots(renderPool, activeKeys, reservedRetainedSlotIds, reusableSlotsByGroup);

    batch(() => {
      let renderPoolChanged = false;
      presentSlotIds.clear();
      for (let localIndex = 0; localIndex < itemCount; localIndex += 1) {
        const index = startIndex + localIndex;
        const key = keyBuffer[localIndex];
        const reuseGroup = reuseGroupBuffer[localIndex];
        if (key === undefined || reuseGroup === undefined) {
          throw new Error("Virtual activity render buffers lost an item.");
        }
        const retainedSlot = slotsByKey.get(key);
        if (retainedSlot !== undefined && retainedSlot.reuseGroup !== reuseGroup) {
          throw new Error("Virtual activity reuse groups must remain stable for each key.");
        }
        let slot = retainedSlot ?? reusableSlotsByGroup.get(reuseGroup)?.pop();
        if (slot === undefined) {
          slot = createKeyedVirtualRenderSlot(nextSlotId++, reuseGroup, {
            active: true,
            index,
            key,
            source,
          });
          renderPool.push(slot);
          renderPoolChanged = true;
        }
        slot.updatePosition(source, key, index, true);
        presentSlotIds.add(slot.slotId);
        nextActive[localIndex] = slot;
      }

      if (retainedSlotLimit > 0 && itemCount > 0) {
        for (const slot of activeSequence) {
          if (reservedRetainedSlotIds.has(slot.slotId)) {
            const position = slot.position();
            slot.updatePosition(position.source, position.key, position.index, false);
            presentSlotIds.add(slot.slotId);
            nextRetained.push(slot);
          }
        }
      }

      for (const slot of renderPool) {
        if (!presentSlotIds.has(slot.slotId)) {
          const position = slot.position();
          slot.updatePosition(position.source, position.key, position.index, false);
        }
      }

      nextRendered.length = nextActive.length + nextRetained.length;
      for (let index = 0; index < nextActive.length; index += 1) {
        const slot = nextActive[index];
        if (slot !== undefined) {
          nextRendered[index] = slot;
        }
      }
      for (let index = 0; index < nextRetained.length; index += 1) {
        const slot = nextRetained[index];
        if (slot !== undefined) {
          nextRendered[nextActive.length + index] = slot;
        }
      }

      let sequenceChanged = renderedSequence.length !== nextRendered.length;
      for (let index = 0; !sequenceChanged && index < nextRendered.length; index += 1) {
        sequenceChanged = renderedSequence[index] !== nextRendered[index];
      }
      if (sequenceChanged) {
        renderedSequence = nextRendered;
        setSlots(nextRendered);
      }
      if (renderPoolChanged) {
        setRenderSlots(renderPool.slice());
      }
      activeSequence = nextActive;
      retainedSequence = nextRetained;
      retentionLimit = retainedSlotLimit;
      hasPositionSnapshot = true;
      positionSource = source;
      positionStartIndex = startIndex;
    });
  }

  return {
    reconcile(source, startIndex, items) {
      reconcileRange(
        source,
        startIndex,
        startIndex + items.length,
        (_source, index) => readVirtualItem(items, index - startIndex).key,
        (_source, _key, index) => readVirtualItem(items, index - startIndex).reuseGroup,
      );
    },
    reconcileRange,
    renderSlots,
    slots,
  };
}

function readVirtualItem(items: readonly KeyedVirtualItem[], index: number): KeyedVirtualItem {
  const item = items[index];
  if (item === undefined) {
    throw new Error("Virtual activity items must address every position.");
  }
  return item;
}

function indexReusableSlots<TSource>(
  slots: readonly MutableKeyedVirtualRenderSlot<TSource>[],
  activeKeys: ReadonlySet<string>,
  reservedSlotIds: ReadonlySet<number>,
  reusableSlotsByGroup: Map<string, MutableKeyedVirtualRenderSlot<TSource>[]>,
): void {
  for (const queue of reusableSlotsByGroup.values()) {
    queue.length = 0;
  }
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    const slot = slots[index];
    if (
      slot !== undefined &&
      !activeKeys.has(slot.position().key) &&
      !reservedSlotIds.has(slot.slotId)
    ) {
      let queue = reusableSlotsByGroup.get(slot.reuseGroup);
      if (queue === undefined) {
        queue = [];
        reusableSlotsByGroup.set(slot.reuseGroup, queue);
      }
      queue.push(slot);
    }
  }
}

function reserveNearestLeavingSlots<TSource>(options: {
  readonly activeKeys: ReadonlySet<string>;
  readonly activeSequence: readonly MutableKeyedVirtualRenderSlot<TSource>[];
  readonly previousStartIndex: number;
  readonly reservedSlotIds: Set<number>;
  readonly retainedSlotLimit: number;
  readonly startIndex: number;
}): void {
  if (options.retainedSlotLimit === 0 || options.activeSequence.length === 0) {
    return;
  }
  const movingForward = options.startIndex >= options.previousStartIndex;
  for (
    let offset = 0;
    offset < options.activeSequence.length &&
    options.reservedSlotIds.size < options.retainedSlotLimit;
    offset += 1
  ) {
    const index = movingForward ? options.activeSequence.length - 1 - offset : offset;
    const slot = options.activeSequence[index];
    if (slot !== undefined && !options.activeKeys.has(slot.position().key)) {
      options.reservedSlotIds.add(slot.slotId);
    }
  }
}

function createKeyedVirtualRenderSlot<TSource>(
  slotId: number,
  reuseGroup: string,
  initialPosition: MutableKeyedVirtualRenderPosition<TSource>,
): MutableKeyedVirtualRenderSlot<TSource> {
  const positions: [
    MutableKeyedVirtualRenderPosition<TSource>,
    MutableKeyedVirtualRenderPosition<TSource>,
  ] = [initialPosition, { ...initialPosition }];
  let activePosition = 0;
  const [position, setPosition] =
    createSignal<KeyedVirtualRenderPosition<TSource>>(initialPosition);
  return {
    position,
    reuseGroup,
    slotId,
    updatePosition(source, key, index, active) {
      const current = position();
      if (
        current.source === source &&
        current.key === key &&
        current.index === index &&
        current.active === active
      ) {
        return;
      }
      activePosition = activePosition === 0 ? 1 : 0;
      const next = activePosition === 0 ? positions[0] : positions[1];
      next.source = source;
      next.key = key;
      next.index = index;
      next.active = active;
      setPosition(next);
    },
  };
}
