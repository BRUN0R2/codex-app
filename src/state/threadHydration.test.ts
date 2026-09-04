import { describe, expect, it, vi } from "vitest";

import type { CodexThread, ThreadTurn } from "../contracts/types";
import { hydrateInitialThreadPage } from "./threadHydration";

describe("initial thread hydration", () => {
  it("keeps the conversation hidden until enough complete recent turns are available", async () => {
    const readOlderPage = vi
      .fn()
      .mockResolvedValueOnce({
        nextCursor: "cursor-2",
        thread: thread([4, 5, 6, 7]),
      })
      .mockResolvedValueOnce({
        nextCursor: null,
        thread: thread([0, 1, 2, 3]),
      });

    const hydrated = await hydrateInitialThreadPage({
      initialPage: { nextCursor: "cursor-1", thread: thread([8]) },
      isCurrent: () => true,
      readOlderPage,
    });

    expect(readOlderPage.mock.calls).toEqual([["cursor-1"], ["cursor-2"]]);
    expect(hydrated?.thread.turns.map(({ id }) => id)).toEqual(
      Array.from({ length: 9 }, (_, index) => `turn-${index}`),
    );
    expect(hydrated?.nextCursor).toBeNull();
  });

  it("abandons stale hydration without publishing another conversation", async () => {
    let current = true;
    const hydrated = await hydrateInitialThreadPage({
      initialPage: { nextCursor: "cursor-1", thread: thread([8]) },
      isCurrent: () => current,
      readOlderPage: async () => {
        current = false;
        return { nextCursor: null, thread: thread([0, 1, 2, 3, 4, 5, 6, 7]) };
      },
    });

    expect(hydrated).toBeNull();
  });

  it("rejects a cursor that does not advance", async () => {
    await expect(
      hydrateInitialThreadPage({
        initialPage: { nextCursor: "cursor-1", thread: thread([8]) },
        isCurrent: () => true,
        readOlderPage: async () => ({ nextCursor: "cursor-1", thread: thread([7]) }),
      }),
    ).rejects.toThrow("did not advance");
  });
});

function thread(turnIndexes: readonly number[]): CodexThread {
  return {
    id: "thread-1",
    mode: "codex",
    preview: "Conversation",
    name: null,
    cwd: "C:\\workspace",
    projectPath: "C:\\workspace",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: { type: "idle" },
    turns: turnIndexes.map(turn),
  };
}

function turn(index: number): ThreadTurn {
  return {
    id: `turn-${index}`,
    items: [],
    status: "completed",
    error: null,
    createdAt: index,
    updatedAt: index,
  };
}
