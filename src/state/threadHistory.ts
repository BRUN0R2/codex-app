import type { CodexThread, ThreadSummary, ThreadTurn } from "../contracts/types";

export function applyThreadSummary(thread: CodexThread, summary: ThreadSummary): CodexThread {
  assertSameThread(thread, summary);
  return { ...summary, turns: thread.turns };
}

export function prependThreadHistory(current: CodexThread, olderPage: CodexThread): CodexThread {
  assertSameThread(current, olderPage);
  if (olderPage.turns.length === 0) {
    return current;
  }
  if (current.turns.length === 0) {
    return { ...current, turns: olderPage.turns };
  }

  const olderLast = olderPage.turns.at(-1);
  const currentFirst = current.turns[0];
  const boundaryOverlap =
    olderLast !== undefined && currentFirst !== undefined && olderLast.id === currentFirst.id;
  const currentIds = new Set(current.turns.map((turn) => turn.id));
  for (const turn of olderPage.turns) {
    if (currentIds.has(turn.id) && (!boundaryOverlap || turn.id !== olderLast?.id)) {
      throw new Error("The history pages contain overlapping turns outside the boundary.");
    }
  }

  const turns = boundaryOverlap
    ? [
        ...olderPage.turns.slice(0, -1),
        mergeTurnFragments(olderLast, currentFirst),
        ...current.turns.slice(1),
      ]
    : [...olderPage.turns, ...current.turns];
  return { ...current, turns };
}

function mergeTurnFragments(older: ThreadTurn, newer: ThreadTurn): ThreadTurn {
  const items = [...older.items];
  const itemIndexes = new Map(items.map((item, index) => [item.id, index]));
  for (const item of newer.items) {
    const index = itemIndexes.get(item.id);
    if (index === undefined) {
      itemIndexes.set(item.id, items.length);
      items.push(item);
    } else {
      items[index] = item;
    }
  }
  return {
    ...newer,
    items,
    createdAt: Math.min(older.createdAt, newer.createdAt),
    updatedAt: Math.max(older.updatedAt, newer.updatedAt),
  };
}

function assertSameThread(left: ThreadSummary, right: ThreadSummary): void {
  if (
    left.id !== right.id ||
    left.mode !== right.mode ||
    left.cwd !== right.cwd ||
    left.projectPath !== right.projectPath
  ) {
    throw new Error("The history page does not belong to the open conversation.");
  }
}
