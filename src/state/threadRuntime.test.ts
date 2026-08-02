import { describe, expect, it } from "vitest";

import type { CodexThread } from "../contracts/types";
import {
  deleteThreadRuntime,
  readVisibleThreadTurns,
  synchronizeThreadRuntime,
  updateThreadRuntime,
} from "./threadRuntime";

describe("thread runtime reducer", () => {
  it("isolates concurrent streams by thread", () => {
    let state = updateThreadRuntime(new Map(), "thread-a", (runtime) => ({
      ...runtime,
      activeTurnId: "turn-a",
      items: [{ type: "agentMessage", id: "message-a", text: "A", phase: null }],
    }));
    state = updateThreadRuntime(state, "thread-b", (runtime) => ({
      ...runtime,
      activeTurnId: "turn-b",
      items: [{ type: "agentMessage", id: "message-b", text: "B", phase: null }],
    }));

    expect(state.get("thread-a")?.items).toEqual([
      { type: "agentMessage", id: "message-a", text: "A", phase: null },
    ]);
    expect(state.get("thread-b")?.items).toEqual([
      { type: "agentMessage", id: "message-b", text: "B", phase: null },
    ]);
  });

  it("preserves transient deltas while an active thread is refreshed", () => {
    const streamed = updateThreadRuntime(new Map(), "thread-a", (runtime) => ({
      ...runtime,
      activeTurnId: "turn-a",
      items: [{ type: "agentMessage", id: "streaming", text: "parcial", phase: null }],
    }));
    const refreshed = synchronizeThreadRuntime(streamed, threadFixture("inProgress"));

    expect(refreshed.get("thread-a")?.items).toEqual([
      { type: "agentMessage", id: "streaming", text: "parcial", phase: null },
    ]);
    expect(refreshed.get("thread-a")?.activeTurnId).toBe("turn-a");
  });

  it("replaces transient state with canonical completed history", () => {
    const streamed = updateThreadRuntime(new Map(), "thread-a", (runtime) => ({
      ...runtime,
      activeTurnId: "turn-a",
      items: [{ type: "agentMessage", id: "streaming", text: "parcial", phase: null }],
    }));
    const completed = synchronizeThreadRuntime(streamed, threadFixture("completed"));

    expect(completed.get("thread-a")?.items).toEqual([
      { type: "agentMessage", id: "final", text: "pronto", phase: "finalAnswer" },
    ]);
    expect(completed.get("thread-a")?.activeTurnId).toBeNull();
    expect(deleteThreadRuntime(completed, "thread-a").has("thread-a")).toBe(false);
  });

  it("groups streamed items into their canonical turn without exposing context snapshots", () => {
    const thread = threadFixture("inProgress");
    const runtimeItems = [
      { type: "userMessage", id: "user", content: [{ type: "text", text: "Olá" }] },
      { type: "agentMessage", id: "streaming", text: "parcial", phase: null },
    ] as const;

    const turns = readVisibleThreadTurns(thread, runtimeItems, "turn-a");

    expect(turns).toHaveLength(1);
    expect(turns[0]?.items).toEqual(runtimeItems);
    expect(turns[0]?.createdAt).toBe(1);
  });
});

function threadFixture(status: "completed" | "inProgress"): CodexThread {
  return {
    id: "thread-a",
    preview: "Teste",
    name: null,
    cwd: "C:\\workspace",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: status === "inProgress" ? { type: "active", activeFlags: [] } : { type: "idle" },
    turns: [
      {
        id: "turn-a",
        status,
        error: null,
        createdAt: 1,
        updatedAt: 2,
        items:
          status === "completed"
            ? [{ type: "agentMessage", id: "final", text: "pronto", phase: "finalAnswer" }]
            : [],
      },
    ],
  };
}
