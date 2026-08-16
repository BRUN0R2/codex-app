import type { FileChange, VisibleThreadItem } from "../contracts/types";
import { findVisibleTurn, type VisibleTurnSequence } from "../state/visibleTurnSequence";

import {
  createDiffDocument,
  type DiffDocument,
  type DiffStats,
  summarizeDiff,
} from "./diffDocument";

export interface ReviewStats extends DiffStats {
  readonly fileCount: number;
}

export interface ReviewFileDocument {
  readonly change: FileChange;
  readonly document: DiffDocument;
}

type FileChangeItem = Extract<VisibleThreadItem, { readonly type: "fileChange" }>;

export class LatestTurnFileChangeStore {
  #changes: readonly FileChange[] = [];
  #items: readonly FileChangeItem[] = [];
  #turnId: string | null = null;

  project(turns: VisibleTurnSequence, activeTurnId: string | null): readonly FileChange[] {
    const turn =
      (activeTurnId === null ? undefined : findVisibleTurn(turns, activeTurnId)) ?? turns.at(-1);
    if (turn === undefined) {
      this.#turnId = null;
      this.#items = [];
      this.#changes = [];
      return this.#changes;
    }
    if (turn.id === this.#turnId && sameFileChangeItems(turn.items, this.#items)) {
      return this.#changes;
    }
    const items = turn.items.filter((item): item is FileChangeItem => item.type === "fileChange");
    this.#turnId = turn.id;
    this.#items = items;
    this.#changes = mergeFileChanges(items);
    return this.#changes;
  }
}

export class ReviewDocumentStore {
  #documentsByPath = new Map<string, ReviewFileDocument>();

  project(changes: readonly FileChange[]): readonly ReviewFileDocument[] {
    const nextByPath = new Map<string, ReviewFileDocument>();
    const projected = changes.map((change) => {
      const current = this.#documentsByPath.get(change.path);
      const document =
        current !== undefined && sameFileChange(current.change, change)
          ? current
          : { change, document: createDiffDocument(change.diff) };
      nextByPath.set(change.path, document);
      return document;
    });
    this.#documentsByPath = nextByPath;
    return projected;
  }
}

export class ReviewStatisticsStore {
  #statsByPath = new Map<string, { readonly change: FileChange; readonly stats: DiffStats }>();

  summarize(changes: readonly FileChange[]): ReviewStats {
    const nextByPath = new Map<
      string,
      { readonly change: FileChange; readonly stats: DiffStats }
    >();
    let additions = 0;
    let deletions = 0;
    for (const change of changes) {
      const current = this.#statsByPath.get(change.path);
      const entry =
        current !== undefined && sameFileChange(current.change, change)
          ? current
          : { change, stats: summarizeDiff(change.diff) };
      nextByPath.set(change.path, entry);
      additions += entry.stats.additions;
      deletions += entry.stats.deletions;
    }
    this.#statsByPath = nextByPath;
    return { additions, deletions, fileCount: changes.length };
  }
}

export function latestTurnFileChanges(
  turns: VisibleTurnSequence,
  activeTurnId: string | null,
): readonly FileChange[] {
  return new LatestTurnFileChangeStore().project(turns, activeTurnId);
}

function mergeFileChanges(items: readonly FileChangeItem[]): readonly FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const item of items) {
    for (const change of item.changes) {
      const previous = byPath.get(change.path);
      byPath.set(
        change.path,
        previous === undefined
          ? change
          : {
              ...change,
              diff: [previous.diff, change.diff].filter((diff) => diff.length > 0).join("\n"),
            },
      );
    }
  }
  return [...byPath.values()];
}

export function summarizeReviewChanges(changes: readonly FileChange[]): ReviewStats {
  return new ReviewStatisticsStore().summarize(changes);
}

export function summarizeReviewDocuments(documents: readonly ReviewFileDocument[]): ReviewStats {
  return documents.reduce<ReviewStats>(
    (total, entry) => {
      const stats = entry.document.stats;
      return {
        additions: total.additions + stats.additions,
        deletions: total.deletions + stats.deletions,
        fileCount: total.fileCount + 1,
      };
    },
    { additions: 0, deletions: 0, fileCount: 0 },
  );
}

function sameFileChange(left: FileChange, right: FileChange): boolean {
  if (left.path !== right.path || left.diff !== right.diff || left.kind.type !== right.kind.type) {
    return false;
  }
  return (
    left.kind.type !== "update" ||
    (right.kind.type === "update" && left.kind.movePath === right.kind.movePath)
  );
}

function sameFileChangeItems(
  items: readonly VisibleThreadItem[],
  previous: readonly FileChangeItem[],
): boolean {
  let fileChangeIndex = 0;
  for (const item of items) {
    if (item.type !== "fileChange") {
      continue;
    }
    if (previous[fileChangeIndex] !== item) {
      return false;
    }
    fileChangeIndex += 1;
  }
  return fileChangeIndex === previous.length;
}
