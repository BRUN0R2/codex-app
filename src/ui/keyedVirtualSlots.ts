export interface KeyedVirtualItem {
  readonly key: string;
  readonly reuseGroup: string;
}

export interface KeyedVirtualSlot {
  readonly index: number;
  readonly key: string;
  readonly reuseGroup: string;
  readonly slotId: number;
}

interface ReusableSlotQueue {
  nextIndex: number;
  readonly slots: KeyedVirtualSlot[];
}

const DIRECT_SLOT_RECONCILIATION_LIMIT = 64;

export function reconcileKeyedVirtualSlots(
  previousSlots: readonly KeyedVirtualSlot[],
  nextItems: readonly KeyedVirtualItem[],
): readonly KeyedVirtualSlot[] {
  const direct = reconcileDirectSlots(previousSlots, nextItems);
  if (direct !== null) {
    return direct;
  }
  const disjoint = reconcileDisjointSlots(previousSlots, nextItems);
  if (disjoint !== null) {
    return disjoint;
  }
  const nextKeys = nextItems.map((item) => item.key);
  const nextKeySet = new Set(nextKeys);
  if (nextKeySet.size !== nextKeys.length) {
    throw new Error("Virtual activity keys must be unique.");
  }
  const previousByKey = new Map(previousSlots.map((slot) => [slot.key, slot]));
  const reusableSlotsByGroup = new Map<string, ReusableSlotQueue>();
  for (const slot of previousSlots) {
    if (nextKeySet.has(slot.key)) {
      continue;
    }
    appendReusableSlot(reusableSlotsByGroup, slot);
  }
  let nextSlotId = previousSlots.reduce((maximum, slot) => Math.max(maximum, slot.slotId), -1) + 1;
  return nextItems.map((item, index) => {
    const retainedSlot = previousByKey.get(item.key);
    if (retainedSlot !== undefined && retainedSlot.reuseGroup !== item.reuseGroup) {
      throw new Error("Virtual activity reuse groups must remain stable for each key.");
    }
    const reusableSlot =
      retainedSlot === undefined
        ? takeReusableSlot(reusableSlotsByGroup.get(item.reuseGroup))
        : undefined;
    const slotId = retainedSlot?.slotId ?? reusableSlot?.slotId ?? nextSlotId++;
    return {
      index,
      key: item.key,
      reuseGroup: item.reuseGroup,
      slotId,
    } satisfies KeyedVirtualSlot;
  });
}

function reconcileDirectSlots(
  previousSlots: readonly KeyedVirtualSlot[],
  nextItems: readonly KeyedVirtualItem[],
): readonly KeyedVirtualSlot[] | null {
  if (
    previousSlots.length > DIRECT_SLOT_RECONCILIATION_LIMIT ||
    nextItems.length > DIRECT_SLOT_RECONCILIATION_LIMIT
  ) {
    return null;
  }
  let sameSequence = previousSlots.length === nextItems.length;
  for (let index = 0; index < nextItems.length; index += 1) {
    const item = nextItems[index];
    if (item === undefined) {
      throw new Error("Virtual activity items must address every position.");
    }
    for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
      if (nextItems[previousIndex]?.key === item.key) {
        throw new Error("Virtual activity keys must be unique.");
      }
    }
    const previous = previousSlots[index];
    sameSequence &&= item.key === previous?.key && item.reuseGroup === previous.reuseGroup;
  }
  if (sameSequence) {
    return previousSlots;
  }

  let usedLow = 0;
  let usedHigh = 0;
  let nextSlotId = previousSlots.reduce((maximum, slot) => Math.max(maximum, slot.slotId), -1) + 1;
  const nextSlots = new Array<KeyedVirtualSlot>(nextItems.length);
  for (let index = 0; index < nextItems.length; index += 1) {
    const item = nextItems[index];
    if (item === undefined) {
      throw new Error("Virtual activity items must address every position.");
    }
    let retainedIndex = -1;
    let reusableIndex = -1;
    for (let previousIndex = 0; previousIndex < previousSlots.length; previousIndex += 1) {
      if (isDirectSlotUsed(previousIndex, usedLow, usedHigh)) {
        continue;
      }
      const previous = previousSlots[previousIndex];
      if (previous?.key === item.key) {
        if (previous.reuseGroup !== item.reuseGroup) {
          throw new Error("Virtual activity reuse groups must remain stable for each key.");
        }
        retainedIndex = previousIndex;
        break;
      }
      if (
        reusableIndex < 0 &&
        previous?.reuseGroup === item.reuseGroup &&
        !containsVirtualItemKey(nextItems, previous.key)
      ) {
        reusableIndex = previousIndex;
      }
    }
    const selectedIndex = retainedIndex >= 0 ? retainedIndex : reusableIndex;
    const selectedSlot = selectedIndex < 0 ? undefined : previousSlots[selectedIndex];
    if (selectedIndex < 32) {
      usedLow |= selectedIndex < 0 ? 0 : 1 << selectedIndex;
    } else {
      usedHigh |= 1 << (selectedIndex - 32);
    }
    nextSlots[index] = {
      index,
      key: item.key,
      reuseGroup: item.reuseGroup,
      slotId: selectedSlot?.slotId ?? nextSlotId++,
    };
  }
  return nextSlots;
}

function isDirectSlotUsed(index: number, usedLow: number, usedHigh: number): boolean {
  return index < 32 ? (usedLow & (1 << index)) !== 0 : (usedHigh & (1 << (index - 32))) !== 0;
}

function containsVirtualItemKey(items: readonly KeyedVirtualItem[], key: string): boolean {
  for (const item of items) {
    if (item.key === key) {
      return true;
    }
  }
  return false;
}

function reconcileDisjointSlots(
  previousSlots: readonly KeyedVirtualSlot[],
  nextItems: readonly KeyedVirtualItem[],
): readonly KeyedVirtualSlot[] | null {
  const previousKeys = new Set(previousSlots.map((slot) => slot.key));
  const nextKeys = new Set<string>();
  let sameSequence = previousSlots.length === nextItems.length;
  let overlapsPreviousRange = false;
  for (let index = 0; index < nextItems.length; index += 1) {
    const item = nextItems[index];
    if (item === undefined) {
      throw new Error("Virtual activity items must address every position.");
    }
    if (nextKeys.has(item.key)) {
      throw new Error("Virtual activity keys must be unique.");
    }
    nextKeys.add(item.key);
    const slot = previousSlots[index];
    sameSequence &&= item.key === slot?.key && item.reuseGroup === slot.reuseGroup;
    overlapsPreviousRange ||= previousKeys.has(item.key);
  }
  if (sameSequence) {
    return previousSlots;
  }
  if (overlapsPreviousRange) {
    return null;
  }
  const uniformSlots = reuseUniformDisjointSlots(previousSlots, nextItems);
  if (uniformSlots !== null) {
    return uniformSlots;
  }
  const reusableSlotsByGroup = new Map<string, ReusableSlotQueue>();
  for (const slot of previousSlots) {
    appendReusableSlot(reusableSlotsByGroup, slot);
  }
  let nextSlotId = previousSlots.reduce((maximum, slot) => Math.max(maximum, slot.slotId), -1) + 1;
  return nextItems.map((item, index) => {
    const reusableSlot = takeReusableSlot(reusableSlotsByGroup.get(item.reuseGroup));
    return {
      index,
      key: item.key,
      reuseGroup: item.reuseGroup,
      slotId: reusableSlot?.slotId ?? nextSlotId++,
    };
  });
}

function reuseUniformDisjointSlots(
  previousSlots: readonly KeyedVirtualSlot[],
  nextItems: readonly KeyedVirtualItem[],
): readonly KeyedVirtualSlot[] | null {
  const reuseGroup = previousSlots[0]?.reuseGroup ?? nextItems[0]?.reuseGroup;
  if (
    reuseGroup === undefined ||
    !previousSlots.every((slot) => slot.reuseGroup === reuseGroup) ||
    !nextItems.every((item) => item.reuseGroup === reuseGroup)
  ) {
    return null;
  }
  let nextSlotId = previousSlots.reduce((maximum, slot) => Math.max(maximum, slot.slotId), -1) + 1;
  return nextItems.map((item, index) => ({
    index,
    key: item.key,
    reuseGroup,
    slotId: previousSlots[index]?.slotId ?? nextSlotId++,
  }));
}

function appendReusableSlot(
  queuesByGroup: Map<string, ReusableSlotQueue>,
  slot: KeyedVirtualSlot,
): void {
  const queue = queuesByGroup.get(slot.reuseGroup);
  if (queue === undefined) {
    queuesByGroup.set(slot.reuseGroup, { nextIndex: 0, slots: [slot] });
    return;
  }
  queue.slots.push(slot);
}

function takeReusableSlot(queue: ReusableSlotQueue | undefined): KeyedVirtualSlot | undefined {
  if (queue === undefined) {
    return undefined;
  }
  const slot = queue.slots[queue.nextIndex];
  queue.nextIndex += 1;
  return slot;
}
