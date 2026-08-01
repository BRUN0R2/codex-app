import type { CodexThread, ThreadItem } from "../contracts/types";

export function flattenThreadItems(thread: CodexThread): readonly ThreadItem[] {
  return thread.turns.flatMap((turn) => turn.items);
}

export function upsertItem(
  items: readonly ThreadItem[],
  incoming: ThreadItem,
): readonly ThreadItem[] {
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
  items: readonly ThreadItem[],
  itemId: string,
  delta: string,
): readonly ThreadItem[] {
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
  items: readonly ThreadItem[],
  itemId: string,
  index: number,
  delta: string,
  target: "content" | "summary",
): readonly ThreadItem[] {
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
