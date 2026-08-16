import { describe, expect, it } from "vitest";

import type { VisibleThreadTurn } from "../state/visibleTurnSequence";

import {
  LatestTurnFileChangeStore,
  latestTurnFileChanges,
  ReviewDocumentStore,
  ReviewStatisticsStore,
  summarizeReviewChanges,
} from "./reviewChanges";

describe("review changes", () => {
  it("uses the active turn and merges repeated edits to the same file", () => {
    const turns = [
      turn("old", [fileChange("old-change", "src/old.ts", "+old")]),
      turn("active", [
        fileChange("change-1", "src/App.tsx", "@@ -1 +1 @@\n-old\n+new"),
        fileChange("change-2", "src/App.tsx", "@@ -4,0 +5 @@\n+next"),
      ]),
    ];

    const changes = latestTurnFileChanges(turns, "active");

    expect(changes).toHaveLength(1);
    expect(changes[0]?.path).toBe("src/App.tsx");
    expect(summarizeReviewChanges(changes)).toEqual({
      additions: 2,
      deletions: 1,
      fileCount: 1,
    });
  });

  it("falls back to the latest turn when no turn is active", () => {
    const turns = [
      turn("first", [fileChange("first-change", "first.ts", "+first")]),
      turn("last", [fileChange("last-change", "last.ts", "+last")]),
    ];

    expect(latestTurnFileChanges(turns, null).map((change) => change.path)).toEqual(["last.ts"]);
  });

  it("preserves the projected file list when only non-file turn items change", () => {
    const store = new LatestTurnFileChangeStore();
    const change = fileChange("change", "src/App.tsx", "+new");
    const firstTurn = turn("active", [
      change,
      { type: "agentMessage", id: "message", text: "a", phase: "commentary" },
    ]);
    const first = store.project([firstTurn], "active");
    const updatedTurn = {
      ...firstTurn,
      items: [
        change,
        { type: "agentMessage" as const, id: "message", text: "ab", phase: "commentary" as const },
      ],
    };

    expect(store.project([updatedTurn], "active")).toBe(first);
  });

  it("reuses parsed documents until the corresponding diff actually changes", () => {
    const store = new ReviewDocumentStore();
    const firstChange = {
      path: "src/App.tsx",
      diff: "@@ -1 +1 @@\n-old\n+new",
      kind: { type: "update" as const, movePath: null },
    };
    const first = store.project([firstChange]);
    const unchanged = store.project([{ ...firstChange }]);
    const changed = store.project([{ ...firstChange, diff: `${firstChange.diff}\n+next` }]);

    expect(unchanged[0]).toBe(first[0]);
    expect(changed[0]).not.toBe(first[0]);
    expect(changed[0]?.document.stats.additions).toBe(2);
  });

  it("keeps lightweight statistics stable while unrelated turn state changes", () => {
    const store = new ReviewStatisticsStore();
    const change = {
      path: "src/App.tsx",
      diff: "@@ -1 +1 @@\n-old\n+new",
      kind: { type: "update" as const, movePath: null },
    };

    expect(store.summarize([change])).toEqual({ additions: 1, deletions: 1, fileCount: 1 });
    expect(store.summarize([{ ...change }])).toEqual({
      additions: 1,
      deletions: 1,
      fileCount: 1,
    });
  });
});

function turn(id: string, items: VisibleThreadTurn["items"]): VisibleThreadTurn {
  return {
    id,
    items,
    status: "completed",
    error: null,
    createdAt: 1,
    updatedAt: 2,
  };
}

function fileChange(id: string, path: string, diff: string): VisibleThreadTurn["items"][number] {
  return {
    type: "fileChange",
    id,
    changes: [{ path, diff, kind: { type: "update", movePath: null } }],
    status: "completed",
  };
}
