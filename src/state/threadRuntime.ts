import type {
  CodexThread,
  ContextUsageItem,
  ModelReroutedNotification,
  ModelSafetyBufferingUpdatedNotification,
  ModelVerification,
  ThreadTurn,
  VisibleThreadItem,
} from "../contracts/types";
import { readConversationState, upsertItem } from "./conversation";

export interface ThreadRuntimeState {
  readonly activeTurnId: string | null;
  readonly contextUsage: ContextUsageItem | null;
  readonly items: readonly VisibleThreadItem[];
  readonly modelReroute: ModelReroutedNotification["params"] | null;
  readonly modelVerifications: readonly ModelVerification[];
  readonly moderationMetadata: unknown | null;
  readonly safetyBuffering: ModelSafetyBufferingUpdatedNotification["params"] | null;
}

export interface VisibleThreadTurn extends Omit<ThreadTurn, "items"> {
  readonly items: readonly VisibleThreadItem[];
}

export type ThreadRuntimeMap = ReadonlyMap<string, ThreadRuntimeState>;

export function updateThreadRuntime(
  current: ThreadRuntimeMap,
  threadId: string,
  update: (runtime: ThreadRuntimeState) => ThreadRuntimeState,
): ThreadRuntimeMap {
  const next = new Map(current);
  const existing =
    current.get(threadId) ??
    ({
      activeTurnId: null,
      contextUsage: null,
      items: [],
      modelReroute: null,
      modelVerifications: [],
      moderationMetadata: null,
      safetyBuffering: null,
    } satisfies ThreadRuntimeState);
  next.set(threadId, update(existing));
  return next;
}

export function synchronizeThreadRuntime(
  current: ThreadRuntimeMap,
  thread: CodexThread,
): ThreadRuntimeMap {
  const conversation = readConversationState(thread);
  const incomingActiveTurnId = activeTurnFromThread(thread);
  const existing = current.get(thread.id);
  const next = new Map(current);
  if (existing !== undefined && existing.activeTurnId !== null && incomingActiveTurnId !== null) {
    const mergedItems = conversation.items.reduce(
      (items, item) => upsertItem(items, item),
      existing.items,
    );
    next.set(thread.id, {
      activeTurnId: incomingActiveTurnId,
      contextUsage: conversation.contextUsage ?? existing.contextUsage,
      items: mergedItems,
      modelReroute: existing.modelReroute,
      modelVerifications: existing.modelVerifications,
      moderationMetadata: existing.moderationMetadata,
      safetyBuffering: existing.safetyBuffering,
    });
  } else {
    next.set(thread.id, {
      activeTurnId: incomingActiveTurnId,
      contextUsage: conversation.contextUsage,
      items: conversation.items,
      modelReroute: existing?.modelReroute ?? null,
      modelVerifications: existing?.modelVerifications ?? [],
      moderationMetadata: existing?.moderationMetadata ?? null,
      safetyBuffering: existing?.safetyBuffering ?? null,
    });
  }
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
  const active = [...thread.turns].reverse().find((turn) => turn.status === "inProgress");
  return active?.id ?? null;
}

export function readVisibleThreadTurns(
  thread: CodexThread,
  runtimeItems: readonly VisibleThreadItem[],
  activeTurnId: string | null,
): readonly VisibleThreadTurn[] {
  const runtimeById = new Map(runtimeItems.map((item) => [item.id, item]));
  const assignedIds = new Set<string>();
  const turns = thread.turns.map((turn) => {
    const items = turn.items.flatMap((item) => {
      if (item.type === "contextUsage") {
        return [];
      }
      assignedIds.add(item.id);
      return [runtimeById.get(item.id) ?? item];
    });
    return { ...turn, items } satisfies VisibleThreadTurn;
  });
  const unassigned = runtimeItems.filter((item) => !assignedIds.has(item.id));
  if (unassigned.length === 0) {
    return turns;
  }
  if (turns.length === 0) {
    return [
      {
        id: activeTurnId ?? `${thread.id}:runtime`,
        items: unassigned,
        status: activeTurnId === null ? "completed" : "inProgress",
        error: null,
        createdAt: thread.updatedAt,
        updatedAt: thread.updatedAt,
      },
    ];
  }
  const targetIndex = turns.findIndex((turn) => turn.id === activeTurnId);
  if (targetIndex >= 0) {
    return turns.map((turn, index) =>
      index === targetIndex ? { ...turn, items: [...turn.items, ...unassigned] } : turn,
    );
  }
  if (activeTurnId !== null) {
    return [
      ...turns,
      {
        id: activeTurnId,
        items: unassigned,
        status: "inProgress",
        error: null,
        createdAt: thread.updatedAt,
        updatedAt: thread.updatedAt,
      },
    ];
  }
  const lastIndex = turns.length - 1;
  return turns.map((turn, index) =>
    index === lastIndex ? { ...turn, items: [...turn.items, ...unassigned] } : turn,
  );
}
