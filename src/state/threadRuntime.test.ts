import { describe, expect, it } from "vitest";

import type { CodexThread, ThreadTurn, VisibleThreadItem } from "../contracts/types";
import {
  applyThreadRuntimeStreamDeltas,
  completeThreadRuntimeTurn,
  deleteThreadRuntime,
  isThreadActive,
  isTimelineVisibleItem,
  mergeRuntimeThreadItems,
  type PersistedVisibleTurnsBySource,
  queuedMessageDispatchDecision,
  readActiveTurnPlan,
  readPersistedVisibleTurns,
  synchronizeThreadRuntime,
  updateThreadRuntime,
} from "./threadRuntime";
import type { VisibleThreadTurn } from "./visibleTurnSequence";

describe("thread runtime reducer", () => {
  it("isolates concurrent streams by thread", () => {
    let state = updateThreadRuntime(new Map(), "thread-a", (runtime) => ({
      ...runtime,
      activeTurnId: "turn-a",
      itemOverlaysByTurn: overlays("turn-a", [
        { type: "agentMessage", id: "message-a", text: "A", phase: null },
      ]),
    }));
    state = updateThreadRuntime(state, "thread-b", (runtime) => ({
      ...runtime,
      activeTurnId: "turn-b",
      itemOverlaysByTurn: overlays("turn-b", [
        { type: "agentMessage", id: "message-b", text: "B", phase: null },
      ]),
    }));

    expect(state.get("thread-a")?.itemOverlaysByTurn.get("turn-a")).toEqual([
      { type: "agentMessage", id: "message-a", text: "A", phase: null },
    ]);
    expect(state.get("thread-b")?.itemOverlaysByTurn.get("turn-b")).toEqual([
      { type: "agentMessage", id: "message-b", text: "B", phase: null },
    ]);
  });

  it("preserves transient deltas while an active thread is refreshed", () => {
    const streamed = updateThreadRuntime(new Map(), "thread-a", (runtime) => ({
      ...runtime,
      activeTurnId: "turn-a",
      itemOverlaysByTurn: overlays("turn-a", [
        { type: "agentMessage", id: "streaming", text: "parcial", phase: null },
      ]),
    }));
    const refreshed = synchronizeThreadRuntime(streamed, threadFixture("inProgress"));

    expect(refreshed.get("thread-a")?.itemOverlaysByTurn.get("turn-a")).toEqual([
      { type: "agentMessage", id: "streaming", text: "parcial", phase: null },
    ]);
    expect(refreshed.get("thread-a")?.activeTurnId).toBe("turn-a");
  });

  it("replaces transient state with canonical completed history", () => {
    const streamed = updateThreadRuntime(new Map(), "thread-a", (runtime) => ({
      ...runtime,
      activeTurnId: "turn-a",
      itemOverlaysByTurn: overlays("turn-a", [
        { type: "agentMessage", id: "streaming", text: "parcial", phase: null },
      ]),
    }));
    const completed = synchronizeThreadRuntime(streamed, threadFixture("completed"));

    expect(completed.get("thread-a")?.itemOverlaysByTurn.size).toBe(0);
    expect(completed.get("thread-a")?.activeTurnId).toBeNull();
    expect(deleteThreadRuntime(completed, "thread-a").has("thread-a")).toBe(false);
  });

  it("releases every transient item when the owning turn becomes terminal", () => {
    const command = backgroundCommand();
    const running = updateThreadRuntime(new Map(), "thread-a", (runtime) => ({
      ...runtime,
      activeTurnId: "turn-a",
      itemOverlaysByTurn: overlays("turn-a", [
        { type: "agentMessage", id: "commentary", text: "Aguardando", phase: "commentary" },
        command,
      ]),
    }));
    const runningRuntime = running.get("thread-a");
    if (runningRuntime === undefined) {
      throw new Error("O runtime do turno concluído não foi criado.");
    }
    const result = completeThreadRuntimeTurn(runningRuntime, {
      id: "turn-a",
    });
    const runtime = result.runtime;

    expect(result.completedActiveTurn).toBe(true);
    expect(runtime.activeTurnId).toBeNull();
    expect(runtime.itemOverlaysByTurn.size).toBe(0);
    expect(isThreadActive(threadFixture("completed"), runtime)).toBe(false);

    const streamed = applyThreadRuntimeStreamDeltas(new Map([["thread-a", runtime]]), [
      {
        kind: "commandOutput",
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: command.id,
        stream: "stdout",
        operation: { type: "append", delta: "test result: ok\n" },
      },
    ]);
    expect(streamed.get("thread-a")?.itemOverlaysByTurn.size).toBe(0);
  });

  it("drops stale overlays before a newer active turn becomes canonical", () => {
    const command = backgroundCommand();
    const current = updateThreadRuntime(new Map(), "thread-a", (runtime) => ({
      ...runtime,
      activeTurnId: "turn-old",
      itemOverlaysByTurn: overlays("turn-old", [
        { type: "agentMessage", id: "commentary-old", text: "antigo", phase: "commentary" },
        command,
      ]),
    }));
    const thread: CodexThread = {
      ...threadFixture("inProgress"),
      turns: [
        {
          id: "turn-old",
          status: "completed",
          error: null,
          createdAt: 1,
          updatedAt: 2,
          items: [],
        },
        {
          id: "turn-new",
          status: "inProgress",
          error: null,
          createdAt: 3,
          updatedAt: 4,
          items: [],
        },
      ],
    };

    const synchronized = synchronizeThreadRuntime(current, thread).get("thread-a");

    expect(synchronized?.activeTurnId).toBe("turn-new");
    expect(synchronized?.itemOverlaysByTurn.has("turn-old")).toBe(false);
    expect(synchronized?.itemOverlaysByTurn.has("turn-new")).toBe(false);
  });

  it("drops transient commands for every terminal status", () => {
    const command = backgroundCommand();
    const runtimeMap = updateThreadRuntime(new Map(), "thread-a", (current) => ({
      ...current,
      activeTurnId: "turn-a",
      itemOverlaysByTurn: overlays("turn-a", [command]),
      safetyBuffering: {
        fasterModel: null,
        model: "gpt-test",
        reasons: [],
        showBufferingUi: true,
        threadId: "thread-a",
        turnId: "turn-a",
        useCases: [],
      },
    }));
    const runtime = runtimeMap.get("thread-a");
    if (runtime === undefined) {
      throw new Error("O runtime do turno interrompido não foi criado.");
    }

    const result = completeThreadRuntimeTurn(runtime, {
      id: "turn-a",
    });

    expect(result.completedActiveTurn).toBe(true);
    expect(result.runtime.activeTurnId).toBeNull();
    expect(result.runtime.itemOverlaysByTurn.size).toBe(0);
    expect(result.runtime.safetyBuffering).toBeNull();
    expect(isThreadActive(threadFixture("completed"), result.runtime)).toBe(false);
  });

  it("keeps internal command polls out of the visible timeline", () => {
    const thread = threadFixture("completed");
    const poll = {
      type: "toolExecution" as const,
      id: "poll-1",
      name: "poll_command",
      description: "Wait for command",
      status: "completed" as const,
      outputPresentation: { type: "plainText" as const },
      output: null,
    };
    const withPoll = {
      ...thread,
      turns: thread.turns.map((turn) => ({ ...turn, items: [...turn.items, poll] })),
    };

    expect(isTimelineVisibleItem(poll)).toBe(false);
    expect(readPersistedVisibleTurns(newTurnCache(), withPoll)[0]?.items).not.toContainEqual(poll);
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

  it("steers only an active turn and starts immediately after ownership is released", () => {
    const activeWithCommand = updateThreadRuntime(new Map(), "thread-a", (runtime) => ({
      ...runtime,
      activeTurnId: "turn-a",
      itemOverlaysByTurn: overlays("turn-a", [backgroundCommand()]),
    })).get("thread-a");
    const backgroundOnly = updateThreadRuntime(new Map(), "thread-a", (runtime) => ({
      ...runtime,
      itemOverlaysByTurn: overlays("turn-a", [backgroundCommand()]),
    })).get("thread-a");

    expect(queuedMessageDispatchDecision(activeWithCommand)).toEqual({
      type: "steerTurn",
      turnId: "turn-a",
    });
    expect(queuedMessageDispatchDecision(backgroundOnly)).toEqual({ type: "startTurn" });
    expect(queuedMessageDispatchDecision(undefined)).toEqual({ type: "startTurn" });
  });

  it("groups streamed items into their canonical turn without exposing context snapshots", () => {
    const thread = threadFixture("inProgress");
    const runtimeItems = [
      { type: "userMessage", id: "user", content: [{ type: "text", text: "Olá" }] },
      { type: "agentMessage", id: "streaming", text: "parcial", phase: null },
    ] as const;

    const turns = mergeRuntimeThreadItems(
      thread,
      readPersistedVisibleTurns(newTurnCache(), thread),
      overlays("turn-a", runtimeItems),
      "turn-a",
    );

    expect(turns).toHaveLength(1);
    expect(turns.at(0)?.items).toEqual(runtimeItems);
    expect(turns.at(0)?.createdAt).toBe(1);
  });

  it("keeps an older background command attached to its owning turn", () => {
    const oldCommand = {
      ...backgroundCommand(),
      id: "command-old",
      liveOutput: { stdout: "old turn\n", stderr: "", truncated: false },
    };
    const activeItem = {
      type: "agentMessage" as const,
      id: "message-new",
      text: "turno novo",
      phase: "commentary" as const,
    };
    const thread: CodexThread = {
      ...threadFixture("inProgress"),
      turns: [
        {
          id: "turn-old",
          status: "completed",
          error: null,
          createdAt: 1,
          updatedAt: 2,
          items: [{ ...oldCommand, liveOutput: null }],
        },
        {
          id: "turn-new",
          status: "inProgress",
          error: null,
          createdAt: 3,
          updatedAt: 4,
          items: [],
        },
      ],
    };
    const turns = mergeRuntimeThreadItems(
      thread,
      readPersistedVisibleTurns(newTurnCache(), thread),
      new Map([
        ["turn-old", [oldCommand]],
        ["turn-new", [activeItem]],
      ]),
      "turn-new",
    );

    expect(turns.at(0)?.id).toBe("turn-old");
    expect(turns.at(0)?.items).toEqual([oldCommand]);
    expect(turns.at(1)?.id).toBe("turn-new");
    expect(turns.at(1)?.items).toEqual([activeItem]);
  });

  it("routes late command deltas only to the owning older turn", () => {
    const oldCommand = { ...backgroundCommand(), id: "command-old" };
    const activeItem = {
      type: "agentMessage" as const,
      id: "message-new",
      text: "novo",
      phase: null,
    };
    const current = updateThreadRuntime(new Map(), "thread-a", (runtime) => ({
      ...runtime,
      activeTurnId: "turn-new",
      itemOverlaysByTurn: new Map([
        ["turn-old", [oldCommand]],
        ["turn-new", [activeItem]],
      ]),
    }));

    const result = applyThreadRuntimeStreamDeltas(current, [
      {
        kind: "commandOutput",
        threadId: "thread-a",
        turnId: "turn-old",
        itemId: oldCommand.id,
        stream: "stdout",
        operation: { type: "append", delta: "done\n" },
      },
    ]);

    expect(result.get("thread-a")?.itemOverlaysByTurn.get("turn-old")?.[0]).toMatchObject({
      liveOutput: { stdout: "done\n", stderr: "", truncated: false },
    });
    expect(result.get("thread-a")?.itemOverlaysByTurn.get("turn-new")).toEqual([activeItem]);
  });

  it("completing the current turn clears only overlays owned by that turn", () => {
    const oldCommand = { ...backgroundCommand(), id: "command-old" };
    const currentCommand = { ...backgroundCommand(), id: "command-current" };
    const runtime = updateThreadRuntime(new Map(), "thread-a", (current) => ({
      ...current,
      activeTurnId: "turn-current",
      itemOverlaysByTurn: new Map([
        ["turn-old", [oldCommand]],
        ["turn-current", [currentCommand]],
      ]),
    })).get("thread-a");
    if (runtime === undefined) {
      throw new Error("O runtime com dois turnos não foi criado.");
    }

    const result = completeThreadRuntimeTurn(runtime, {
      id: "turn-current",
    });

    expect(result.runtime.itemOverlaysByTurn.get("turn-old")).toEqual([oldCommand]);
    expect(result.runtime.itemOverlaysByTurn.has("turn-current")).toBe(false);
  });

  it("reuses persisted turn projections until the immutable turn source changes", () => {
    const thread = threadFixture("completed");
    const turnCache = newTurnCache();
    const first = readPersistedVisibleTurns(turnCache, thread);
    const metadataOnly = readPersistedVisibleTurns(turnCache, {
      ...thread,
      updatedAt: thread.updatedAt + 1,
    });
    const changedTurns = readPersistedVisibleTurns(turnCache, {
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
      readPersistedVisibleTurns(newTurnCache(), thread),
      overlays("turn-a", [
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
      ]),
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
      overlays("turn-9999", [
        { type: "agentMessage", id: "streaming", text: "parcial", phase: null },
      ]),
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
        turnId: "turn-a",
        itemId: "message-a",
        delta: "A",
      },
      {
        kind: "agentText",
        threadId: "thread-b",
        turnId: "turn-b",
        itemId: "message-b",
        delta: "B",
      },
    ]);

    expect(result).not.toBe(current);
    expect(result.get("thread-a")?.itemOverlaysByTurn.get("turn-a")).toEqual([
      { type: "agentMessage", id: "message-a", text: "A", phase: null },
    ]);
    expect(result.get("thread-b")?.itemOverlaysByTurn.get("turn-b")).toEqual([
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
    expect(result.get("thread-a")?.itemOverlaysByTurn.size).toBe(0);
  });
});

function newTurnCache(): PersistedVisibleTurnsBySource {
  return new WeakMap<readonly ThreadTurn[], readonly VisibleThreadTurn[]>();
}

function overlays(
  turnId: string,
  items: readonly VisibleThreadItem[],
): ReadonlyMap<string, readonly VisibleThreadItem[]> {
  return new Map([[turnId, items]]);
}

function backgroundCommand() {
  return {
    type: "commandExecution" as const,
    id: "background-command",
    command: "pnpm verify",
    cwd: ".",
    processId: "session-1",
    startedAt: 1_000,
    source: "agent" as const,
    status: "inProgress" as const,
    aggregatedOutput: null,
    liveOutput: { stdout: "", stderr: "", truncated: false },
    exitCode: null,
    durationMs: null,
  };
}

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
