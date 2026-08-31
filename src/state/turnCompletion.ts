import type {
  CodexThread,
  CompletedTurn,
  ThreadItem,
  ThreadSummary,
  TurnSummary,
} from "../contracts/types";

export function applySummaryTurnStarted(thread: ThreadSummary, turn: TurnSummary): ThreadSummary {
  return {
    ...thread,
    status: { type: "active", activeFlags: [] },
    updatedAt: Math.max(thread.updatedAt, turn.updatedAt),
  };
}

export function applySummaryTurnCompletion(
  thread: ThreadSummary,
  completion: CompletedTurn,
): ThreadSummary {
  return {
    ...thread,
    status: { type: "idle" },
    updatedAt: Math.max(thread.updatedAt, completion.updatedAt),
  };
}

export function applyTurnStarted(thread: CodexThread, turn: TurnSummary): CodexThread {
  const existing = thread.turns.find((entry) => entry.id === turn.id);
  if (existing !== undefined) {
    if (
      existing.status === turn.status &&
      existing.createdAt === turn.createdAt &&
      existing.updatedAt === turn.updatedAt
    ) {
      return thread;
    }
    throw new Error(`Turn ${JSON.stringify(turn.id)} was started with conflicting data.`);
  }
  if (turn.status !== "inProgress") {
    throw new Error(`New turn ${JSON.stringify(turn.id)} is not in progress.`);
  }
  return {
    ...thread,
    status: { type: "active", activeFlags: [] },
    turns: [
      ...thread.turns,
      {
        ...turn,
        items: [],
        error: null,
      },
    ],
    updatedAt: Math.max(thread.updatedAt, turn.updatedAt),
  };
}

export function applyTurnItem(
  thread: CodexThread,
  turnId: string,
  item: ThreadItem,
  causalOrder: readonly string[] = [],
): CodexThread {
  const turnIndex = thread.turns.findIndex((turn) => turn.id === turnId);
  if (turnIndex < 0) {
    throw new Error(`Item ${JSON.stringify(item.id)} does not belong to a loaded turn.`);
  }
  const turn = thread.turns[turnIndex];
  if (turn === undefined) {
    throw new Error("The position of the turn that received an item became inconsistent.");
  }
  const itemIndex = turn.items.findIndex((entry) => entry.id === item.id);
  if (itemIndex >= 0 && turn.items[itemIndex]?.type !== item.type) {
    throw new Error(`Item ${JSON.stringify(item.id)} changed type during the turn.`);
  }
  const items = turn.items.slice();
  if (itemIndex < 0) {
    const insertionIndex = causalInsertionIndex(items, item.id, causalOrder);
    items.splice(insertionIndex, 0, item);
  } else {
    items[itemIndex] = item;
  }
  const turns = thread.turns.slice();
  turns[turnIndex] = { ...turn, items };
  return { ...thread, turns };
}

function causalInsertionIndex(
  items: readonly ThreadItem[],
  itemId: string,
  causalOrder: readonly string[],
): number {
  if (causalOrder.length === 0) {
    return items.length;
  }
  const orderById = new Map(causalOrder.map((id, index) => [id, index]));
  if (orderById.size !== causalOrder.length) {
    throw new Error("The turn causal order contains duplicate identifiers.");
  }
  const incomingOrder = orderById.get(itemId);
  if (incomingOrder === undefined) {
    throw new Error(`Item ${JSON.stringify(itemId)} does not belong to the turn causal order.`);
  }
  const nextItemIndex = items.findIndex((existing) => {
    const existingOrder = orderById.get(existing.id);
    return existingOrder !== undefined && existingOrder > incomingOrder;
  });
  return nextItemIndex < 0 ? items.length : nextItemIndex;
}

export function applyTurnCompletion(thread: CodexThread, completion: CompletedTurn): CodexThread {
  const turnIndex = thread.turns.findIndex((turn) => turn.id === completion.id);
  if (turnIndex < 0) {
    throw new Error(`Terminal turn ${JSON.stringify(completion.id)} does not belong to the task.`);
  }
  const current = thread.turns[turnIndex];
  if (current === undefined) {
    throw new Error("The terminal turn position became inconsistent.");
  }
  if (current.status !== "inProgress") {
    if (
      current.status === completion.status &&
      current.error === completion.error &&
      current.updatedAt === completion.updatedAt
    ) {
      return thread;
    }
    throw new Error(`Turn ${JSON.stringify(completion.id)} received conflicting completions.`);
  }
  if (completion.updatedAt < current.createdAt) {
    throw new Error(`Turn ${JSON.stringify(completion.id)} completed before it was created.`);
  }

  const turns = thread.turns.slice();
  turns[turnIndex] = {
    ...current,
    items: current.items.map(settleActiveItem),
    status: completion.status,
    error: completion.error,
    updatedAt: completion.updatedAt,
  };
  return {
    ...thread,
    status: { type: "idle" },
    turns,
    updatedAt: Math.max(thread.updatedAt, completion.updatedAt),
  };
}

function settleActiveItem(item: ThreadItem): ThreadItem {
  switch (item.type) {
    case "commandExecution":
      return item.status === "inProgress"
        ? {
            ...item,
            processId: null,
            status: "failed",
            liveOutput: null,
          }
        : item;
    case "fileChange":
    case "toolExecution":
      return item.status === "inProgress" ? { ...item, status: "failed" } : item;
    default:
      return item;
  }
}
