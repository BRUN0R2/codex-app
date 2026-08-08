import { describe, expect, it } from "vitest";

import type { VisibleThreadTurn } from "../state/threadRuntime";

import { latestTurnFileChanges, summarizeReviewChanges } from "./reviewChanges";

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
