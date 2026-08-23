import { describe, expect, it } from "vitest";

import type { CodexThread } from "../contracts/types";
import {
  applyThreadRuntimeStreamDeltas,
  deleteThreadRuntime,
  isThreadActive,
  mergeRuntimeThreadItems,
  readActiveTurnPlan,
  readPersistedVisibleTurns,
  synchronizeThreadRuntime,
  updateThreadRuntime,
} from "./threadRuntime";

describe("thread runtime reducer", () => {
  it("isolates concurrent streams by thread", () => {
    let state = updateThreadRuntime(new Map(), "thread-a", (runtime) => ({
      ...runtime,
      activeTurnId: "turn-a",
      itemOverlays: [{ type: "agentMessage", id: "message-a", text: "A", phase: null }],
    }));
    state = updateThreadRuntime(state, "thread-b", (runtime) => ({
      ...runtime,
      activeTurnId: "turn-b",
      itemOverlays: [{ type: "agentMessage", id: "message-b", text: "B", phase: null }],
    }));

    expect(state.get("thread-a")?.itemOverlays).toEqual([
      { type: "agentMessage", id: "message-a", text: "A", phase: null },
    ]);
    expect(state.get("thread-b")?.itemOverlays).toEqual([
      { type: "agentMessage", id: "message-b", text: "B", phase: null },
    ]);
  });

  it("preserves transient deltas while an active thread is refreshed", () => {
    const streamed = updateThreadRuntime(new Map(), "thread-a", (runtime) => ({
      ...runtime,
      activeTurnId: "turn-a",
      itemOverlays: [{ type: "agentMessage", id: "streaming", text: "parcial", phase: null }],
    }));
    const refreshed = synchronizeThreadRuntime(streamed, threadFixture("inProgress"));

    expect(refreshed.get("thread-a")?.itemOverlays).toEqual([
      { type: "agentMessage", id: "streaming", text: "parcial", phase: null },
    ]);
    expect(refreshed.get("thread-a")?.activeTurnId).toBe("turn-a");
  });

  it("replaces transient state with canonical completed history", () => {
    const streamed = updateThreadRuntime(new Map(), "thread-a", (runtime) => ({
      ...runtime,
      activeTurnId: "turn-a",
      itemOverlays: [{ type: "agentMessage", id: "streaming", text: "parcial", phase: null }],
    }));
    const completed = synchronizeThreadRuntime(streamed, threadFixture("completed"));

    expect(completed.get("thread-a")?.itemOverlays).toEqual([]);
    expect(completed.get("thread-a")?.activeTurnId).toBeNull();
    expect(deleteThreadRuntime(completed, "thread-a").has("thread-a")).toBe(false);
  });

  it("treats runtime ownership as active even when the persisted snapshot is stale", () => {
    const thread = threadFixture("completed");
    const runtime = updateThreadRuntime(new Map(), thread.id, (current) => ({
      ...current,
      activeTurnId: "turn-runtime",
    })).get(thread.id);

    expect(isThreadActive(thread, runtime)).toBe(true);
    expect(isThreadActive(thread, undefined)).toBe(false);
    expect(isThreadActive(threadFixture("inProgress"), undefined)).toBe(true);
  });

  it("groups streamed items into their canonical turn without exposing context snapshots", () => {
    const thread = threadFixture("inProgress");
    const runtimeItems = [
      { type: "userMessage", id: "user", content: [{ type: "text", text: "Olá" }] },
      { type: "agentMessage", id: "streaming", text: "parcial", phase: null },
    ] as const;

    const turns = mergeRuntimeThreadItems(
      thread,
      readPersistedVisibleTurns(thread),
      runtimeItems,
      "turn-a",
    );

    expect(turns).toHaveLength(1);
    expect(turns.at(0)?.items).toEqual(runtimeItems);
    expect(turns.at(0)?.createdAt).toBe(1);
  });

  it("reuses persisted turn projections until the immutable turn source changes", () => {
    const thread = threadFixture("completed");
    const first = readPersistedVisibleTurns(thread);
    const metadataOnly = readPersistedVisibleTurns({ ...thread, updatedAt: thread.updatedAt + 1 });
    const changedTurns = readPersistedVisibleTurns({
      ...thread,
      turns: [...thread.turns],
    });

    expect(metadataOnly).toBe(first);
    expect(changedTurns).not.toBe(first);
    expect(changedTurns).toEqual(first);
  });

  it("selects only the latest plan from the active turn", () => {
    const thread = threadFixture("inProgress");
    const turns = mergeRuntimeThreadItems(
      thread,
      readPersistedVisibleTurns(thread),
      [
        {
          type: "plan",
          id: "plan-1",
          explanation: null,
          steps: [{ step: "Mapear", status: "completed" }],
        },
        {
          type: "plan",
          id: "plan-2",
          explanation: "Plano atualizado",
          steps: [
            { step: "Mapear", status: "completed" },
            { step: "Validar", status: "inProgress" },
          ],
        },
      ],
      "turn-a",
    );

    expect(readActiveTurnPlan(turns, "turn-a")?.id).toBe("plan-2");
    expect(readActiveTurnPlan(turns, null)).toBeNull();
  });

  it("projects an active overlay without cloning a long persisted turn array", () => {
    const persisted = Array.from({ length: 10_000 }, (_, index) => ({
      id: `turn-${index}`,
      items: [],
      status: "completed" as const,
      error: null,
      createdAt: index,
      updatedAt: index,
    }));
    const turns = mergeRuntimeThreadItems(
      threadFixture("inProgress"),
      persisted,
      [{ type: "agentMessage", id: "streaming", text: "parcial", phase: null }],
      "turn-9999",
    );

    expect(Array.isArray(turns)).toBe(false);
    expect(turns).toHaveLength(persisted.length);
    expect(turns.at(0)).toBe(persisted[0]);
    expect(turns.slice(-1)[0]?.items).toEqual([
      { type: "agentMessage", id: "streaming", text: "parcial", phase: null },
    ]);
  });

  it("updates multiple streaming threads with one outer map replacement", () => {
    const firstThread = updateThreadRuntime(new Map(), "thread-a", (runtime) => runtime);
    const current = updateThreadRuntime(firstThread, "thread-b", (runtime) => runtime);
    const result = applyThreadRuntimeStreamDeltas(current, [
      {
        kind: "agentText",
        threadId: "thread-a",
        itemId: "message-a",
        delta: "A",
      },
      {
        kind: "agentText",
        threadId: "thread-b",
        itemId: "message-b",
        delta: "B",
      },
    ]);

    expect(result).not.toBe(current);
    expect(result.get("thread-a")?.itemOverlays).toEqual([
      { type: "agentMessage", id: "message-a", text: "A", phase: null },
    ]);
    expect(result.get("thread-b")?.itemOverlays).toEqual([
      { type: "agentMessage", id: "message-b", text: "B", phase: null },
    ]);
  });
  it("leaves persisted background command deltas outside the active overlay map", () => {
    const current = updateThreadRuntime(new Map(), "thread-a", (runtime) => runtime);
    const result = applyThreadRuntimeStreamDeltas(current, [
      {
        kind: "commandOutput",
        threadId: "thread-a",
        turnId: "turn-old",
        itemId: "background-command",
        stream: "stdout",
        operation: { type: "append", delta: "done" },
      },
    ]);

    expect(result).toBe(current);
    expect(result.get("thread-a")?.itemOverlays).toEqual([]);
  });
});

function threadFixture(status: "completed" | "inProgress"): CodexThread {
  return {
    id: "thread-a",
    mode: "codex",
    preview: "Teste",
    name: null,
    cwd: "C:\\workspace",
    projectPath: "C:\\workspace",
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
