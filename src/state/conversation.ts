import type {
  CodexThread,
  ContextUsageItem,
  ThreadTurn,
  VisibleThreadItem,
} from "../contracts/types";
import type { StreamDelta } from "./streamDeltas";

const MAX_LIVE_COMMAND_OUTPUT_CHARACTERS: number = 256 * 1_024;

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

export function readTurnOutputTokens(turn: Pick<ThreadTurn, "items">): number {
  let outputTokens = 0;
  for (const item of turn.items) {
    if (item.type !== "contextUsage") {
      continue;
    }
    const next = outputTokens + item.usage.outputTokens;
    if (!Number.isSafeInteger(next)) {
      throw new Error("The turn output-token sum exceeded the safe numeric limit.");
    }
    outputTokens = next;
  }
  return outputTokens;
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
    throw new Error("The active-item index became inconsistent.");
  }
  if (current.type !== incoming.type) {
    throw new Error(
      `Item ${incoming.id} changed from ${current.type} to ${incoming.type}, violating the contract.`,
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
      throw new Error("The delta-batch index became inconsistent.");
    }
    next[itemIndex] = applyStreamDelta(current, delta);
  }

  return next;
}

export function applyCommandStreamDeltasToThread(
  thread: CodexThread,
  deltas: readonly Extract<StreamDelta, { readonly kind: "commandOutput" }>[],
): CodexThread {
  if (deltas.length === 0) {
    return thread;
  }
  let turns: readonly ThreadTurn[] | null = null;
  for (const delta of deltas) {
    const sourceTurns: readonly ThreadTurn[] = turns ?? thread.turns;
    const turnIndex = sourceTurns.findIndex((turn) => turn.id === delta.turnId);
    if (turnIndex === -1) {
      continue;
    }
    const turn = sourceTurns[turnIndex];
    if (turn === undefined) {
      throw new Error("The command-delta turn became inconsistent.");
    }
    const itemIndex = turn.items.findIndex((item) => item.id === delta.itemId);
    if (itemIndex === -1) {
      continue;
    }
    const item = turn.items[itemIndex];
    if (item === undefined) {
      throw new Error("The persisted command delta item became inconsistent.");
    }
    if (item.type !== "commandExecution") {
      throw new Error(`O delta de comando persistido aponta para um item ${item.type}.`);
    }
    const updated = applyStreamDelta(item, delta);
    const items = [...turn.items];
    items[itemIndex] = updated;
    const nextTurns: ThreadTurn[] = turns === null ? [...thread.turns] : [...turns];
    nextTurns[turnIndex] = { ...turn, items };
    turns = nextTurns;
  }
  return turns === null ? thread : { ...thread, turns };
}

function createItemFromDelta(delta: StreamDelta): VisibleThreadItem {
  switch (delta.kind) {
    case "agentText":
      return { type: "agentMessage", id: delta.itemId, text: delta.delta, phase: null };
    case "commandOutput":
      throw new Error("The command delta arrived before the commandExecution item.");
    case "reasoningText": {
      const parts = Array.from({ length: delta.index + 1 }, () => "");
      parts[delta.index] = delta.delta;
      return {
        type: "reasoning",
        id: delta.itemId,
        summary: delta.target === "summary" ? parts : [],
        content: delta.target === "content" ? parts : [],
      };
    }
  }
}

function applyStreamDelta(current: VisibleThreadItem, delta: StreamDelta): VisibleThreadItem {
  switch (delta.kind) {
    case "agentText":
      if (current.type !== "agentMessage") {
        throw new Error(`O delta de texto aponta para um item ${current.type}.`);
      }
      return { ...current, text: current.text + delta.delta };
    case "commandOutput": {
      if (current.type !== "commandExecution" || current.liveOutput === null) {
        throw new Error(`The command delta points to an inactive ${current.type} item.`);
      }
      const output = applyCommandOutputOperation(
        current.liveOutput[delta.stream],
        current.liveOutput.stdout.length + current.liveOutput.stderr.length,
        delta.operation,
      );
      return {
        ...current,
        liveOutput: {
          ...current.liveOutput,
          [delta.stream]: output.value,
          truncated: current.liveOutput.truncated || output.truncated,
        },
      };
    }
    case "reasoningText": {
      if (current.type !== "reasoning") {
        throw new Error(`The reasoning delta points to a ${current.type} item.`);
      }
      const parts = [...current[delta.target]];
      while (parts.length <= delta.index) {
        parts.push("");
      }
      const existing = parts[delta.index];
      if (existing === undefined) {
        throw new Error("The reasoning-delta index became inconsistent.");
      }
      parts[delta.index] = existing + delta.delta;
      return { ...current, [delta.target]: parts };
    }
  }
}

function applyCommandOutputOperation(
  current: string,
  totalCharacters: number,
  operation: Extract<StreamDelta, { readonly kind: "commandOutput" }>["operation"],
): { readonly truncated: boolean; readonly value: string } {
  switch (operation.type) {
    case "append": {
      const remaining = Math.max(0, MAX_LIVE_COMMAND_OUTPUT_CHARACTERS - totalCharacters);
      const appended = unicodePrefix(operation.delta, remaining);
      return {
        truncated: appended.length < operation.delta.length || remaining === 0,
        value: current + appended,
      };
    }
    case "backspace":
      return { truncated: false, value: removeLastCharacterFromCurrentLine(current) };
    case "clearCurrentLine":
      return {
        truncated: false,
        value: current.slice(0, current.lastIndexOf("\n") + 1),
      };
    case "truncated":
      return { truncated: true, value: current };
  }
}

function removeLastCharacterFromCurrentLine(value: string): string {
  const lineStart = value.lastIndexOf("\n") + 1;
  if (value.length <= lineStart) {
    return value;
  }
  const last = value.charCodeAt(value.length - 1);
  const remove = last >= 0xdc00 && last <= 0xdfff ? 2 : 1;
  return value.slice(0, value.length - remove);
}

function unicodePrefix(value: string, maximumCharacters: number): string {
  if (value.length <= maximumCharacters) {
    return value;
  }
  let end = maximumCharacters;
  if (
    end > 0 &&
    end < value.length &&
    value.charCodeAt(end - 1) >= 0xd800 &&
    value.charCodeAt(end - 1) <= 0xdbff
  ) {
    end -= 1;
  }
  return value.slice(0, end);
}

function findItemIndex(items: readonly VisibleThreadItem[], itemId: string): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.id === itemId) {
      return index;
    }
  }
  return -1;
}
