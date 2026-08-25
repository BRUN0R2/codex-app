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

export function reconcileKeyedVirtualSlots(
  previousSlots: readonly KeyedVirtualSlot[],
  nextItems: readonly KeyedVirtualItem[],
): readonly KeyedVirtualSlot[] {
  const nextKeySet = new Set<string>();
  let sameSequence = previousSlots.length === nextItems.length;
  for (let index = 0; index < nextItems.length; index += 1) {
    const item = nextItems[index];
    if (item === undefined) {
      throw new Error("Virtual activity items must address every position.");
    }
    if (nextKeySet.has(item.key)) {
      throw new Error("Virtual activity keys must be unique.");
    }
    nextKeySet.add(item.key);
    const previous = previousSlots[index];
    sameSequence &&= item.key === previous?.key && item.reuseGroup === previous.reuseGroup;
  }
  if (sameSequence) {
    return previousSlots;
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
