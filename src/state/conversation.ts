import type { CodexThread, ContextUsageItem, VisibleThreadItem } from "../contracts/types";

export interface ConversationState {
  readonly items: readonly VisibleThreadItem[];
  readonly contextUsage: ContextUsageItem | null;
}

export function readLatestTurnFailure(thread: CodexThread): string | null {
  const turn = thread.turns.at(-1);
  return turn?.status === "failed" ? turn.error : null;
}

export function readConversationState(thread: CodexThread): ConversationState {
  const items: VisibleThreadItem[] = [];
  let contextUsage: ContextUsageItem | null = null;
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.type === "contextUsage") {
        contextUsage = item;
      } else if (item.type === "contextCompaction") {
        contextUsage = null;
        items.push(item);
      } else {
        items.push(item);
      }
    }
  }
  return { items, contextUsage };
}

export function upsertItem(
  items: readonly VisibleThreadItem[],
  incoming: VisibleThreadItem,
): readonly VisibleThreadItem[] {
  const index = items.findIndex((item) => item.id === incoming.id);
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
  return items.map((item, itemIndex) => (itemIndex === index ? incoming : item));
}

export function appendAgentText(
  items: readonly VisibleThreadItem[],
  itemId: string,
  delta: string,
): readonly VisibleThreadItem[] {
  const current = items.find((item) => item.id === itemId);
  if (current === undefined) {
    return [...items, { type: "agentMessage", id: itemId, text: delta, phase: null }];
  }
  if (current.type !== "agentMessage") {
    throw new Error(`O delta de texto aponta para um item ${current.type}.`);
  }
  return upsertItem(items, { ...current, text: current.text + delta });
}

export function appendReasoningText(
  items: readonly VisibleThreadItem[],
  itemId: string,
  index: number,
  delta: string,
  target: "content" | "summary",
): readonly VisibleThreadItem[] {
  const current = items.find((item) => item.id === itemId);
  const reasoning =
    current === undefined
      ? { type: "reasoning" as const, id: itemId, summary: [], content: [] }
      : current;
  if (reasoning.type !== "reasoning") {
    throw new Error(`O delta de raciocínio aponta para um item ${reasoning.type}.`);
  }
  const parts = [...reasoning[target]];
  while (parts.length <= index) {
    parts.push("");
  }
  const existing = parts[index];
  if (existing === undefined) {
    throw new Error("O índice do delta de raciocínio ficou inconsistente.");
  }
  parts[index] = existing + delta;
  return upsertItem(items, { ...reasoning, [target]: parts });
}
