import type { FileChange, VisibleThreadItem } from "../contracts/types";
import { findVisibleTurn, type VisibleTurnSequence } from "../state/visibleTurnSequence";

import { createDiffDocument, type DiffDocument, type DiffStats } from "./diffDocument";
import { fileChangeLineStats } from "./fileChangeStats";

export interface ReviewStats extends DiffStats {
  readonly fileCount: number;
}

export interface ReviewFileDocument {
  readonly change: FileChange;
  readonly document: DiffDocument;
  readonly stats: DiffStats;
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
          : {
              change,
              document: createDiffDocument(change.diff),
              stats: fileChangeLineStats(change),
            };
      nextByPath.set(change.path, document);
      return document;
    });
    this.#documentsByPath = nextByPath;
    return projected;
  }
}

export class ReviewStatisticsStore {
  readonly #parsedStats = new WeakMap<FileChange, DiffStats>();

  summarize(changes: readonly FileChange[]): ReviewStats {
    let additions = 0;
    let deletions = 0;
    for (const change of changes) {
      const stats =
        change.lineStats ??
        this.#parsedStats.get(change) ??
        cacheParsedFileChangeStats(this.#parsedStats, change);
      additions += stats.additions;
      deletions += stats.deletions;
    }
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
  let changeCount = 0;
  for (const item of items) {
    changeCount += item.changes.length;
  }
  if (changeCount === 0) {
    return [];
  }

  const pathIndex = new FileChangePathIndex(changeCount);
  const merged: FileChange[] = [];
  for (const item of items) {
    for (const change of item.changes) {
      const existingIndex = pathIndex.find(change.path, merged);
      if (existingIndex === null) {
        pathIndex.insert(change.path, merged.length);
        merged.push(change);
        continue;
      }
      const previous = merged[existingIndex];
      if (previous === undefined) {
        throw new Error("O índice de alterações perdeu seu arquivo de referência.");
      }
      merged[existingIndex] = {
        ...change,
        diff: [previous.diff, change.diff].filter((diff) => diff.length > 0).join("\n"),
        lineStats: mergeLineStats(previous.lineStats, change.lineStats),
      };
    }
  }
  return merged;
}

export function summarizeReviewChanges(changes: readonly FileChange[]): ReviewStats {
  return new ReviewStatisticsStore().summarize(changes);
}

export function summarizeReviewDocuments(documents: readonly ReviewFileDocument[]): ReviewStats {
  return documents.reduce<ReviewStats>(
    (total, entry) => {
      const stats = entry.stats;
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
  if (
    left.path !== right.path ||
    left.diff !== right.diff ||
    left.kind.type !== right.kind.type ||
    left.lineStats?.additions !== right.lineStats?.additions ||
    left.lineStats?.deletions !== right.lineStats?.deletions
  ) {
    return false;
  }
  return (
    left.kind.type !== "update" ||
    (right.kind.type === "update" && left.kind.movePath === right.kind.movePath)
  );
}

function mergeLineStats(
  left: FileChange["lineStats"],
  right: FileChange["lineStats"],
): FileChange["lineStats"] {
  return left === null || right === null
    ? null
    : {
        additions: left.additions + right.additions,
        deletions: left.deletions + right.deletions,
      };
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

class FileChangePathIndex {
  readonly #buckets: Int32Array;
  readonly #mask: number;

  constructor(capacity: number) {
    let bucketCount = 1;
    while (bucketCount < capacity * 2) {
      bucketCount *= 2;
    }
    this.#buckets = new Int32Array(bucketCount);
    this.#mask = bucketCount - 1;
  }

  find(path: string, changes: readonly FileChange[]): number | null {
    let bucket = hashFilePath(path) & this.#mask;
    while (true) {
      const stored = this.#buckets[bucket] ?? 0;
      if (stored === 0) {
        return null;
      }
      const index = stored - 1;
      if (changes[index]?.path === path) {
        return index;
      }
      bucket = (bucket + 1) & this.#mask;
    }
  }

  insert(path: string, index: number): void {
    let bucket = hashFilePath(path) & this.#mask;
    while ((this.#buckets[bucket] ?? 0) !== 0) {
      bucket = (bucket + 1) & this.#mask;
    }
    this.#buckets[bucket] = index + 1;
  }
}

function hashFilePath(path: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < path.length; index += 1) {
    hash = Math.imul(hash ^ path.charCodeAt(index), 16_777_619);
  }
  return hash >>> 0;
}

function cacheParsedFileChangeStats(
  cache: WeakMap<FileChange, DiffStats>,
  change: FileChange,
): DiffStats {
  const stats = fileChangeLineStats(change);
  cache.set(change, stats);
  return stats;
}
