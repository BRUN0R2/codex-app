import type {
  CodexThread,
  CompletedTurn,
  ContextUsageItem,
  ModelReroutedNotification,
  ModelSafetyBufferingUpdatedNotification,
  ModelVerification,
  PlanItem,
  ThreadItem,
  ThreadSummary,
  ThreadTurn,
  VisibleThreadItem,
} from "../contracts/types";
import {
  applyStreamDeltas,
  readLatestContextUsage,
  readTurnOutputTokens,
  removeItem,
  upsertItem,
} from "./conversation";
import type { StreamDelta } from "./streamDeltas";
import {
  findVisibleTurn,
  overlayVisibleTurns,
  type VisibleThreadTurn,
  type VisibleTurnSequence,
} from "./visibleTurnSequence";

export type ThreadItemOverlaysByTurn = ReadonlyMap<string, readonly VisibleThreadItem[]>;
export type ThreadItemOrderByTurn = ReadonlyMap<string, readonly string[]>;

export interface ThreadRuntimeState {
  readonly activeTurnId: string | null;
  readonly contextUsage: ContextUsageItem | null;
  readonly itemOrderByTurn: ThreadItemOrderByTurn;
  readonly itemOverlaysByTurn: ThreadItemOverlaysByTurn;
  readonly modelReroute: ModelReroutedNotification["params"] | null;
  readonly modelVerifications: readonly ModelVerification[];
  readonly safetyBuffering: ModelSafetyBufferingUpdatedNotification["params"] | null;
}

export type ThreadRuntimeMap = ReadonlyMap<string, ThreadRuntimeState>;

export type PersistedVisibleTurnsBySource = WeakMap<
  readonly ThreadTurn[],
  readonly VisibleThreadTurn[]
>;

export function updateThreadRuntime(
  current: ThreadRuntimeMap,
  threadId: string,
  update: (runtime: ThreadRuntimeState) => ThreadRuntimeState,
): ThreadRuntimeMap {
  const next = new Map(current);
  const existing = current.get(threadId) ?? emptyThreadRuntime();
  next.set(threadId, update(existing));
  return next;
}

export function readThreadRuntimeItems(
  runtime: ThreadRuntimeState | null | undefined,
): readonly VisibleThreadItem[] {
  if (runtime === null || runtime === undefined || runtime.itemOverlaysByTurn.size === 0) {
    return [];
  }
  if (runtime.itemOverlaysByTurn.size === 1) {
    return runtime.itemOverlaysByTurn.values().next().value ?? [];
  }
  return [...runtime.itemOverlaysByTurn.values()].flat();
}

export function readThreadRuntimeItemIds(
  runtime: ThreadRuntimeState | null | undefined,
): ReadonlySet<string> {
  return new Set(readThreadRuntimeItems(runtime).map((item) => item.id));
}

export function upsertThreadRuntimeItemOverlay(
  overlays: ThreadItemOverlaysByTurn,
  turnId: string,
  item: VisibleThreadItem,
): ThreadItemOverlaysByTurn {
  return replaceTurnItemOverlays(overlays, turnId, upsertItem(overlays.get(turnId) ?? [], item));
}

export function removeThreadRuntimeItemOverlay(
  overlays: ThreadItemOverlaysByTurn,
  turnId: string,
  itemId: string,
): ThreadItemOverlaysByTurn {
  const current = overlays.get(turnId);
  if (current === undefined) {
    return overlays;
  }
  return replaceTurnItemOverlays(overlays, turnId, removeItem(current, itemId));
}

export function recordThreadRuntimeItemOrder(
  orderByTurn: ThreadItemOrderByTurn,
  turnId: string,
  itemId: string,
): ThreadItemOrderByTurn {
  const current = orderByTurn.get(turnId) ?? [];
  if (current.includes(itemId)) {
    return orderByTurn;
  }
  const next = new Map(orderByTurn);
  next.set(turnId, [...current, itemId]);
  return next;
}

export function applyThreadRuntimeStreamDeltas(
  current: ThreadRuntimeMap,
  deltas: readonly StreamDelta[],
): ThreadRuntimeMap {
  if (deltas.length === 0) {
    return current;
  }
  const deltasByThread = new Map<string, StreamDelta[]>();
  for (const delta of deltas) {
    const threadDeltas = deltasByThread.get(delta.threadId);
    if (threadDeltas === undefined) {
      deltasByThread.set(delta.threadId, [delta]);
    } else {
      threadDeltas.push(delta);
    }
  }
  let next: Map<string, ThreadRuntimeState> | null = null;
  for (const [threadId, threadDeltas] of deltasByThread) {
    const runtime = current.get(threadId) ?? emptyThreadRuntime();
    const deltasByTurn = new Map<string, StreamDelta[]>();
    for (const delta of threadDeltas) {
      const turnDeltas = deltasByTurn.get(delta.turnId);
      if (turnDeltas === undefined) {
        deltasByTurn.set(delta.turnId, [delta]);
      } else {
        turnDeltas.push(delta);
      }
    }
    let itemOverlaysByTurn = runtime.itemOverlaysByTurn;
    let itemOrderByTurn = runtime.itemOrderByTurn;
    for (const [turnId, turnDeltas] of deltasByTurn) {
      const turnItems = itemOverlaysByTurn.get(turnId) ?? [];
      const overlayIds = new Set(turnItems.map((item) => item.id));
      const applicableDeltas = turnDeltas.filter(
        (delta) => delta.kind !== "commandOutput" || overlayIds.has(delta.itemId),
      );
      if (applicableDeltas.length === 0) {
        continue;
      }
      for (const delta of applicableDeltas) {
        itemOrderByTurn = recordThreadRuntimeItemOrder(itemOrderByTurn, turnId, delta.itemId);
      }
      itemOverlaysByTurn = replaceTurnItemOverlays(
        itemOverlaysByTurn,
        turnId,
        applyStreamDeltas(turnItems, applicableDeltas),
      );
    }
    if (
      itemOverlaysByTurn === runtime.itemOverlaysByTurn &&
      itemOrderByTurn === runtime.itemOrderByTurn
    ) {
      continue;
    }
    next ??= new Map(current);
    next.set(threadId, {
      ...runtime,
      itemOrderByTurn,
      itemOverlaysByTurn,
    });
  }
  return next ?? current;
}

export function synchronizeThreadRuntime(
  current: ThreadRuntimeMap,
  thread: CodexThread,
): ThreadRuntimeMap {
  const incomingActiveTurnId = activeTurnFromThread(thread);
  const existing = current.get(thread.id);
  const itemOverlaysByTurn =
    existing?.activeTurnId === incomingActiveTurnId && incomingActiveTurnId !== null
      ? existing.itemOverlaysByTurn
      : new Map();
  const itemOrderByTurn =
    existing?.activeTurnId === incomingActiveTurnId && incomingActiveTurnId !== null
      ? existing.itemOrderByTurn
      : new Map();
  const next = new Map(current);
  next.set(thread.id, {
    activeTurnId: incomingActiveTurnId,
    contextUsage: readLatestContextUsage(thread),
    itemOrderByTurn,
    itemOverlaysByTurn,
    modelReroute: existing?.modelReroute ?? null,
    modelVerifications: existing?.modelVerifications ?? [],
    safetyBuffering: existing?.safetyBuffering ?? null,
  });
  return next;
}

export function deleteThreadRuntime(current: ThreadRuntimeMap, threadId: string): ThreadRuntimeMap {
  if (!current.has(threadId)) {
    return current;
  }
  const next = new Map(current);
  next.delete(threadId);
  return next;
}

export function activeTurnFromThread(thread: CodexThread): string | null {
  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    const turn = thread.turns[index];
    if (turn?.status === "inProgress") {
      return turn.id;
    }
  }
  return null;
}

export function isThreadActive(
  thread: ThreadSummary,
  runtime: ThreadRuntimeState | undefined,
): boolean {
  return thread.status.type === "active" || (runtime?.activeTurnId ?? null) !== null;
}

export function isTimelineVisibleItem(item: ThreadItem): boolean {
  return (
    item.type !== "contextUsage" && !(item.type === "toolExecution" && item.name === "poll_command")
  );
}

export function shouldMaterializeThreadItemNotification(
  method: "item.completed" | "item.started",
): boolean {
  return method === "item.completed";
}

export type QueuedMessageDispatchDecision =
  | { readonly type: "startTurn" }
  | { readonly turnId: string; readonly type: "steerTurn" };

export function queuedMessageDispatchDecision(
  runtime: ThreadRuntimeState | undefined,
): QueuedMessageDispatchDecision {
  if (runtime?.activeTurnId !== null && runtime?.activeTurnId !== undefined) {
    return { type: "steerTurn", turnId: runtime.activeTurnId };
  }
  return { type: "startTurn" };
}

export function completeThreadRuntimeTurn(
  runtime: ThreadRuntimeState,
  completion: Pick<CompletedTurn, "id">,
): {
  readonly completedActiveTurn: boolean;
  readonly runtime: ThreadRuntimeState;
} {
  if (runtime.activeTurnId !== completion.id) {
    return {
      completedActiveTurn: false,
      runtime,
    };
  }
  const itemOverlaysByTurn = replaceTurnItemOverlays(runtime.itemOverlaysByTurn, completion.id, []);
  return {
    completedActiveTurn: true,
    runtime: {
      ...runtime,
      activeTurnId: null,
      itemOrderByTurn: removeTurnItemOrder(runtime.itemOrderByTurn, completion.id),
      itemOverlaysByTurn,
      safetyBuffering: null,
    },
  };
}

export function readActiveTurnPlan(
  turns: VisibleTurnSequence,
  activeTurnId: string | null,
): PlanItem | null {
  if (activeTurnId === null) {
    return null;
  }
  const activeTurn = findVisibleTurn(turns, activeTurnId);
  if (activeTurn === undefined) {
    return null;
  }
  for (let index = activeTurn.items.length - 1; index >= 0; index -= 1) {
    const item = activeTurn.items[index];
    if (item?.type === "plan") {
      return item;
    }
  }
  return null;
}

export function readPersistedVisibleTurns(
  persistedVisibleTurnsBySource: PersistedVisibleTurnsBySource,
  thread: CodexThread,
): readonly VisibleThreadTurn[] {
  const cached = persistedVisibleTurnsBySource.get(thread.turns);
  if (cached !== undefined) {
    return cached;
  }
  const projected = thread.turns.map((turn) => ({
    ...turn,
    confirmedOutputTokens: readTurnOutputTokens(turn),
    items: turn.items
      .filter((item): item is VisibleThreadItem => item.type !== "contextUsage")
      .filter(isTimelineVisibleItem),
  }));
  persistedVisibleTurnsBySource.set(thread.turns, projected);
  return projected;
}

export function mergeRuntimeThreadItems(
  thread: CodexThread,
  persistedTurns: readonly VisibleThreadTurn[],
  itemOverlaysByTurn: ThreadItemOverlaysByTurn,
  activeTurnId: string | null,
  itemOrderByTurn: ThreadItemOrderByTurn = new Map(),
): VisibleTurnSequence {
  if (itemOverlaysByTurn.size === 0) {
    return persistedTurns;
  }
  const overlayTurns = new Map<number, VisibleThreadTurn>();
  const seenItemIds = new Set<string>();
  for (const [turnId, itemOverlays] of itemOverlaysByTurn) {
    for (const item of itemOverlays) {
      if (seenItemIds.has(item.id)) {
        throw new Error("The transient thread items contain duplicate identifiers.");
      }
      seenItemIds.add(item.id);
    }
    let targetIndex = findPersistedTurnIndex(persistedTurns, turnId);
    if (targetIndex === -1) {
      if (turnId !== activeTurnId) {
        continue;
      }
      targetIndex = persistedTurns.length;
      overlayTurns.set(targetIndex, {
        id: turnId,
        confirmedOutputTokens: 0,
        items: mergeTurnItems([], itemOverlays, itemOrderByTurn.get(turnId) ?? []),
        status: "inProgress",
        error: null,
        createdAt: thread.updatedAt,
        updatedAt: thread.updatedAt,
      });
      continue;
    }
    const target = persistedTurns[targetIndex];
    if (target === undefined) {
      throw new Error("The target turn for the transient items became inconsistent.");
    }
    overlayTurns.set(targetIndex, {
      ...target,
      items: mergeTurnItems(target.items, itemOverlays, itemOrderByTurn.get(turnId) ?? []),
    });
  }
  return overlayVisibleTurns(persistedTurns, overlayTurns);
}

function emptyThreadRuntime(): ThreadRuntimeState {
  return {
    activeTurnId: null,
    contextUsage: null,
    itemOrderByTurn: new Map(),
    itemOverlaysByTurn: new Map(),
    modelReroute: null,
    modelVerifications: [],
    safetyBuffering: null,
  };
}

function replaceTurnItemOverlays(
  overlays: ThreadItemOverlaysByTurn,
  turnId: string,
  items: readonly VisibleThreadItem[],
): ThreadItemOverlaysByTurn {
  const current = overlays.get(turnId);
  if (current === items || (current === undefined && items.length === 0)) {
    return overlays;
  }
  const next = new Map(overlays);
  if (items.length === 0) {
    next.delete(turnId);
  } else {
    next.set(turnId, items);
  }
  return next;
}

function mergeTurnItems(
  persistedItems: readonly VisibleThreadItem[],
  itemOverlays: readonly VisibleThreadItem[],
  itemOrder: readonly string[],
): readonly VisibleThreadItem[] {
  const overlayById = new Map(itemOverlays.map((item) => [item.id, item]));
  const assignedIds = new Set<string>();
  const mergedItems = persistedItems.map((item) => {
    assignedIds.add(item.id);
    return overlayById.get(item.id) ?? item;
  });
  for (const item of itemOverlays) {
    if (!assignedIds.has(item.id)) {
      mergedItems.push(item);
    }
  }
  if (itemOrder.length === 0) {
    return mergedItems;
  }
  const mergedById = new Map(mergedItems.map((item) => [item.id, item]));
  const orderedIds = new Set(itemOrder);
  const untrackedItems = mergedItems.filter((item) => !orderedIds.has(item.id));
  const orderedItems = itemOrder.flatMap((itemId) => {
    const item = mergedById.get(itemId);
    return item === undefined ? [] : [item];
  });
  return [...untrackedItems, ...orderedItems];
}

function removeTurnItemOrder(
  orderByTurn: ThreadItemOrderByTurn,
  turnId: string,
): ThreadItemOrderByTurn {
  if (!orderByTurn.has(turnId)) {
    return orderByTurn;
  }
  const next = new Map(orderByTurn);
  next.delete(turnId);
  return next;
}

function findPersistedTurnIndex(turns: readonly VisibleThreadTurn[], turnId: string): number {
  if (turns.at(-1)?.id === turnId) {
    return turns.length - 1;
  }
  for (let index = turns.length - 2; index >= 0; index -= 1) {
    if (turns[index]?.id === turnId) {
      return index;
    }
  }
  return -1;
}
