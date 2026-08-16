import type { VisibleThreadItem } from "../contracts/types";

export type TurnMessageItem = Extract<
  VisibleThreadItem,
  { readonly type: "agentMessage" | "userMessage" }
>;

export type TurnWorkItem = Exclude<
  VisibleThreadItem,
  { readonly type: "agentMessage" | "plan" | "userMessage" }
>;

export type TurnPresentationBlock =
  | {
      readonly kind: "message";
      readonly key: string;
      readonly item: TurnMessageItem;
    }
  | {
      readonly kind: "work";
      readonly key: string;
      readonly items: readonly TurnWorkItem[];
    };

export type TurnMessageBlock = Extract<TurnPresentationBlock, { readonly kind: "message" }>;
export type TurnWorkBlock = Extract<TurnPresentationBlock, { readonly kind: "work" }>;

export interface TurnPresentation {
  readonly blocks: readonly TurnPresentationBlock[];
  readonly firstWorkBlockIndex: number | null;
  readonly lastWorkBlockIndex: number | null;
  readonly trailingAgentMessageBlockIndex: number | null;
}

export class TurnPresentationStore {
  #blocksByKey = new Map<string, TurnPresentationBlock>();
  #presentation: TurnPresentation | null = null;

  project(items: readonly VisibleThreadItem[]): TurnPresentation {
    const projected = projectTurnPresentation(items);
    const nextBlocksByKey = new Map<string, TurnPresentationBlock>();
    const blocks = projected.blocks.map((block) => {
      if (nextBlocksByKey.has(block.key)) {
        throw new Error(
          `A projeção do turno produziu a chave duplicada ${JSON.stringify(block.key)}.`,
        );
      }
      const previous = this.#blocksByKey.get(block.key);
      const stable =
        previous !== undefined && sameTurnPresentationBlock(previous, block) ? previous : block;
      nextBlocksByKey.set(block.key, stable);
      return stable;
    });
    const previous = this.#presentation;
    if (
      previous !== null &&
      previous.firstWorkBlockIndex === projected.firstWorkBlockIndex &&
      previous.lastWorkBlockIndex === projected.lastWorkBlockIndex &&
      previous.trailingAgentMessageBlockIndex === projected.trailingAgentMessageBlockIndex &&
      sameReferences(previous.blocks, blocks)
    ) {
      return previous;
    }
    const presentation = { ...projected, blocks };
    this.#blocksByKey = nextBlocksByKey;
    this.#presentation = presentation;
    return presentation;
  }
}

export function projectTurnPresentation(items: readonly VisibleThreadItem[]): TurnPresentation {
  const blocks: TurnPresentationBlock[] = [];
  let pendingWork: TurnWorkItem[] = [];
  let workAnchor = "turn-start";

  function flushWork(): void {
    if (pendingWork.length === 0) {
      return;
    }
    blocks.push({ kind: "work", key: `work-after:${workAnchor}`, items: pendingWork });
    pendingWork = [];
  }

  for (const item of items) {
    if (item.type === "plan") {
      continue;
    }
    if (isVisibleMessage(item)) {
      flushWork();
      blocks.push({ kind: "message", key: `message:${item.type}:${item.id}`, item });
      workAnchor = `${item.type}:${item.id}`;
      continue;
    }
    pendingWork.push(item);
  }
  flushWork();

  let firstWorkBlockIndex: number | null = null;
  let lastWorkBlockIndex: number | null = null;
  for (let index = 0; index < blocks.length; index += 1) {
    if (blocks[index]?.kind !== "work") {
      continue;
    }
    firstWorkBlockIndex ??= index;
    lastWorkBlockIndex = index;
  }
  const lastBlockIndex = blocks.length - 1;
  const lastBlock = blocks[lastBlockIndex];

  return {
    blocks,
    firstWorkBlockIndex,
    lastWorkBlockIndex,
    trailingAgentMessageBlockIndex:
      lastBlock?.kind === "message" && lastBlock.item.type === "agentMessage"
        ? lastBlockIndex
        : null,
  };
}

export function asTurnMessageBlock(block: TurnPresentationBlock): TurnMessageBlock | null {
  return block.kind === "message" ? block : null;
}

export function asTurnWorkBlock(block: TurnPresentationBlock): TurnWorkBlock | null {
  return block.kind === "work" ? block : null;
}

function sameTurnPresentationBlock(
  left: TurnPresentationBlock,
  right: TurnPresentationBlock,
): boolean {
  if (left.kind !== right.kind || left.key !== right.key) {
    return false;
  }
  if (left.kind === "message" && right.kind === "message") {
    return left.item === right.item;
  }
  return left.kind === "work" && right.kind === "work" && sameReferences(left.items, right.items);
}

function sameReferences<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isVisibleMessage(item: VisibleThreadItem): item is TurnMessageItem {
  return item.type === "agentMessage" || item.type === "userMessage";
}
