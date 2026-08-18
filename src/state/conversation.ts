import type { CodexThread, ContextUsageItem, VisibleThreadItem } from "../contracts/types";
import type { StreamDelta } from "./streamDeltas";

export function readLatestTurnFailure(thread: CodexThread): string | null {
  const turn = thread.turns.at(-1);
  return turn?.status === "failed" ? turn.error : null;
}

export function readLatestContextUsage(thread: CodexThread): ContextUsageItem | null {
  let contextUsage: ContextUsageItem | null = null;
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.type === "contextUsage") {
        contextUsage = item;
      } else if (item.type === "contextCompaction") {
        contextUsage = null;
      }
    }
  }
  return contextUsage;
}

export function upsertItem(
  items: readonly VisibleThreadItem[],
  incoming: VisibleThreadItem,
): readonly VisibleThreadItem[] {
  const index = findItemIndex(items, incoming.id);
  if (index === -1) {
    return [...items, incoming];
  }
  const current = items[index];
  if (current === undefined) {
    throw new Error("O índice do item ativo ficou inconsistente.");
  }
  if (current.type !== incoming.type) {
    throw new Error(
      `O item ${incoming.id} mudou de ${current.type} para ${incoming.type}, violando o contrato.`,
    );
  }
  if (current === incoming) {
    return items;
  }
  const next = [...items];
  next[index] = incoming;
  return next;
}

export function removeItem(
  items: readonly VisibleThreadItem[],
  itemId: string,
): readonly VisibleThreadItem[] {
  const index = findItemIndex(items, itemId);
  if (index === -1) {
    return items;
  }
  return [...items.slice(0, index), ...items.slice(index + 1)];
}

export function applyStreamDeltas(
  items: readonly VisibleThreadItem[],
  deltas: readonly StreamDelta[],
): readonly VisibleThreadItem[] {
  if (deltas.length === 0) {
    return items;
  }
  const indexes = new Map<string, number>();
  const next = [...items];

  for (const delta of deltas) {
    const itemIndex = indexes.get(delta.itemId) ?? findItemIndex(next, delta.itemId);
    if (itemIndex === -1) {
      const incoming = createItemFromDelta(delta);
      indexes.set(delta.itemId, next.length);
      next.push(incoming);
      continue;
    }
    indexes.set(delta.itemId, itemIndex);
    const current = next[itemIndex];
    if (current === undefined) {
      throw new Error("O índice do lote de deltas ficou inconsistente.");
    }
    next[itemIndex] = applyStreamDelta(current, delta);
  }

  return next;
}

function createItemFromDelta(delta: StreamDelta): VisibleThreadItem {
  if (delta.kind === "agentText") {
    return { type: "agentMessage", id: delta.itemId, text: delta.delta, phase: null };
  }
  const parts = Array.from({ length: delta.index + 1 }, () => "");
  parts[delta.index] = delta.delta;
  return {
    type: "reasoning",
    id: delta.itemId,
    summary: delta.target === "summary" ? parts : [],
    content: delta.target === "content" ? parts : [],
  };
}

function applyStreamDelta(current: VisibleThreadItem, delta: StreamDelta): VisibleThreadItem {
  if (delta.kind === "agentText") {
    if (current.type !== "agentMessage") {
      throw new Error(`O delta de texto aponta para um item ${current.type}.`);
    }
    return { ...current, text: current.text + delta.delta };
  }
  if (current.type !== "reasoning") {
    throw new Error(`O delta de raciocínio aponta para um item ${current.type}.`);
  }
  const parts = [...current[delta.target]];
  while (parts.length <= delta.index) {
    parts.push("");
  }
  const existing = parts[delta.index];
  if (existing === undefined) {
    throw new Error("O índice do delta de raciocínio ficou inconsistente.");
  }
  parts[delta.index] = existing + delta.delta;
  return { ...current, [delta.target]: parts };
}

function findItemIndex(items: readonly VisibleThreadItem[], itemId: string): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.id === itemId) {
      return index;
    }
  }
  return -1;
}
