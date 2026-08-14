import { describe, expect, it } from "vitest";

import type { CodexThread, ThreadTurn } from "../contracts/types";
import { applyThreadSummary, prependThreadHistory } from "./threadHistory";

describe("thread history", () => {
  it("preserves loaded turns when applying a lightweight summary", () => {
    const thread = fixture([turn("new", ["b"])]);
    const { turns, ...summary } = thread;
    const updated = applyThreadSummary(thread, { ...summary, name: "Renamed" });
    expect(updated.name).toBe("Renamed");
    expect(updated.turns).toBe(turns);
  });

  it("prepends pages and merges a turn split at the cursor boundary", () => {
    const current = fixture([turn("shared", ["b"]), turn("new", ["c"])]);
    const older = fixture([turn("old", ["a"]), turn("shared", ["a", "b"])]);
    const merged = prependThreadHistory(current, older);
    expect(merged.turns.map((entry) => entry.id)).toEqual(["old", "shared", "new"]);
    expect(merged.turns[1]?.items.map((item) => item.id)).toEqual(["shared-a", "shared-b"]);
  });
});

function fixture(turns: readonly ThreadTurn[]): CodexThread {
  return {
    id: "thread",
    mode: "codex",
    preview: "History",
    name: null,
    cwd: "C:\\workspace",
    projectPath: "C:\\workspace",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: { type: "idle" },
    turns,
  };
}

function turn(id: string, itemSuffixes: readonly string[]): ThreadTurn {
  return {
    id,
    status: "completed",
    error: null,
    createdAt: 1,
    updatedAt: 2,
    items: itemSuffixes.map((suffix) => ({
      type: "agentMessage" as const,
      id: `${id}-${suffix}`,
      text: suffix,
      phase: null,
    })),
  };
}
