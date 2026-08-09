import type { FileChange } from "../contracts/types";
import type { VisibleThreadTurn } from "../state/threadRuntime";

import { type DiffStats, summarizeDiff } from "./SplitDiffView";

export interface ReviewStats extends DiffStats {
  readonly fileCount: number;
}

export function latestTurnFileChanges(
  turns: readonly VisibleThreadTurn[],
  activeTurnId: string | null,
): readonly FileChange[] {
  const turn =
    (activeTurnId === null
      ? undefined
      : turns.find((candidate) => candidate.id === activeTurnId)) ?? turns.at(-1);
  if (turn === undefined) {
    return [];
  }

  const byPath = new Map<string, FileChange>();
  for (const item of turn.items) {
    if (item.type !== "fileChange") {
      continue;
    }
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
  return changes.reduce<ReviewStats>(
    (total, change) => {
      const stats = summarizeDiff(change.diff);
      return {
        additions: total.additions + stats.additions,
        deletions: total.deletions + stats.deletions,
        fileCount: total.fileCount + 1,
      };
    },
    { additions: 0, deletions: 0, fileCount: 0 },
  );
}
