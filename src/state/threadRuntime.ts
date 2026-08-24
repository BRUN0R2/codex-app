import type {
  CodexThread,
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
import { applyStreamDeltas, readLatestContextUsage } from "./conversation";
import type { StreamDelta } from "./streamDeltas";
import {
  findVisibleTurn,
  overlayVisibleTurn,
  type VisibleThreadTurn,
  type VisibleTurnSequence,
} from "./visibleTurnSequence";

export interface ThreadRuntimeState {
  readonly activeTurnId: string | null;
  readonly contextUsage: ContextUsageItem | null;
  readonly itemOverlays: readonly VisibleThreadItem[];
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
    const overlayIds = new Set(runtime.itemOverlays.map((item) => item.id));
    const applicableDeltas = threadDeltas.filter(
      (delta) => delta.kind !== "commandOutput" || overlayIds.has(delta.itemId),
    );
    if (applicableDeltas.length === 0) {
      continue;
    }
    next ??= new Map(current);
    next.set(threadId, {
      ...runtime,
      itemOverlays: applyStreamDeltas(runtime.itemOverlays, applicableDeltas),
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
  const itemOverlays =
    existing?.activeTurnId === incomingActiveTurnId && incomingActiveTurnId !== null
      ? existing.itemOverlays
      : incomingActiveTurnId === null
        ? retainContinuingBackgroundCommands(existing?.itemOverlays ?? [])
        : [];
  const next = new Map(current);
  next.set(thread.id, {
    activeTurnId: incomingActiveTurnId,
    contextUsage: readLatestContextUsage(thread),
    itemOverlays,
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
  return (
    thread.status.type === "active" ||
    (runtime?.activeTurnId ?? null) !== null ||
    (runtime?.itemOverlays.some(isContinuingBackgroundCommand) ?? false)
  );
}

export function isTimelineVisibleItem(item: ThreadItem): boolean {
  return (
    item.type !== "contextUsage" && !(item.type === "toolExecution" && item.name === "poll_command")
  );
}

export function isContinuingBackgroundCommand(item: VisibleThreadItem): boolean {
  return (
    item.type === "commandExecution" && item.status === "inProgress" && item.processId !== null
  );
}

export function retainContinuingBackgroundCommands(
  items: readonly VisibleThreadItem[],
): readonly VisibleThreadItem[] {
  const continuing = items.filter(isContinuingBackgroundCommand);
  return continuing.length === items.length ? items : continuing;
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
  itemOverlays: readonly VisibleThreadItem[],
  activeTurnId: string | null,
): VisibleTurnSequence {
  if (itemOverlays.length === 0) {
    return persistedTurns;
  }
  const overlayById = new Map(itemOverlays.map((item) => [item.id, item]));
  if (overlayById.size !== itemOverlays.length) {
    throw new Error("Os itens transitórios da conversa contêm identificadores duplicados.");
  }
  if (persistedTurns.length === 0) {
    const runtimeTurn: VisibleThreadTurn = {
      id: activeTurnId ?? `${thread.id}:runtime`,
      items: itemOverlays,
      status: activeTurnId === null ? "completed" : "inProgress",
      error: null,
      createdAt: thread.updatedAt,
      updatedAt: thread.updatedAt,
    };
    return [runtimeTurn];
  }
  const targetIndex =
    activeTurnId === null
      ? persistedTurns.length - 1
      : findPersistedTurnIndex(persistedTurns, activeTurnId);
  if (targetIndex === -1 && activeTurnId !== null) {
    return overlayVisibleTurn(persistedTurns, persistedTurns.length, {
      id: activeTurnId,
      items: itemOverlays,
      status: "inProgress",
      error: null,
      createdAt: thread.updatedAt,
      updatedAt: thread.updatedAt,
    });
  }
  const target = persistedTurns[targetIndex];
  if (target === undefined) {
    throw new Error("O turno de destino dos itens transitórios ficou inconsistente.");
  }
  const assignedIds = new Set<string>();
  const mergedItems = target.items.map((item) => {
    assignedIds.add(item.id);
    return overlayById.get(item.id) ?? item;
  });
  for (const item of itemOverlays) {
    if (!assignedIds.has(item.id)) {
      mergedItems.push(item);
    }
  }
  return overlayVisibleTurn(persistedTurns, targetIndex, { ...target, items: mergedItems });
}

function emptyThreadRuntime(): ThreadRuntimeState {
  return {
    activeTurnId: null,
    contextUsage: null,
    itemOverlays: [],
    modelReroute: null,
    modelVerifications: [],
    safetyBuffering: null,
  };
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
