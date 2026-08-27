import { describe, expect, it } from "vitest";

import type { CodexThread, CompletedTurn, ThreadItem } from "../contracts/types";
import { applyTurnCompletion, applyTurnItem } from "./turnCompletion";

describe("turn completion reducer", () => {
  it("applies an interrupted terminal projection immediately", () => {
    const completed = applyTurnCompletion(threadFixture("inProgress"), completionFixture());

    expect(completed.turns[0]).toMatchObject({
      status: "interrupted",
      error: null,
      updatedAt: 8,
    });
    expect(completed.status).toEqual({ type: "idle" });
    expect(completed.updatedAt).toBe(8);
  });

  it("is referentially idempotent for the same terminal event", () => {
    const completion = completionFixture();
    const completed = applyTurnCompletion(threadFixture("inProgress"), completion);

    expect(applyTurnCompletion(completed, completion)).toBe(completed);
  });

  it("reserves an item slot at start and keeps later commentary after it", () => {
    const command = runningCommand();
    const commentary: ThreadItem = {
      type: "agentMessage",
      id: "commentary-later",
      text: "Comentário mais recente",
      phase: "commentary",
    };
    let thread = applyTurnItem(threadFixture("inProgress"), "turn-a", command);
    thread = applyTurnItem(thread, "turn-a", commentary);
    thread = applyTurnItem(thread, "turn-a", {
      ...command,
      liveOutput: { stdout: "done\n", stderr: "", truncated: false },
    });

    expect(thread.turns[0]?.items.map((item) => item.id)).toEqual([command.id, commentary.id]);
  });

  it("cannot leave an in-progress activity inside a terminal turn", () => {
    const thread = applyTurnItem(threadFixture("inProgress"), "turn-a", runningCommand());
    const completed = applyTurnCompletion(thread, completionFixture());

    expect(completed.turns[0]?.items[0]).toMatchObject({
      type: "commandExecution",
      processId: null,
      status: "failed",
      liveOutput: null,
    });
  });

  it("rejects missing, conflicting and impossible terminal state", () => {
    expect(() =>
      applyTurnCompletion(threadFixture("inProgress"), {
        ...completionFixture(),
        id: "missing",
      }),
    ).toThrow("não pertence");

    const completed = applyTurnCompletion(threadFixture("inProgress"), completionFixture());
    expect(() =>
      applyTurnCompletion(completed, { ...completionFixture(), status: "completed" }),
    ).toThrow("conflitantes");
    expect(() =>
      applyTurnCompletion(threadFixture("inProgress"), {
        ...completionFixture(),
        updatedAt: 0,
      }),
    ).toThrow("antes de ser criado");
  });
});

function completionFixture(): CompletedTurn {
  return { id: "turn-a", status: "interrupted", error: null, updatedAt: 8 };
}

function runningCommand(): Extract<ThreadItem, { type: "commandExecution" }> {
  return {
    type: "commandExecution",
    id: "command-old",
    command: "pnpm test",
    cwd: "C:\\workspace",
    processId: "session-old",
    startedAt: 1_000,
    source: "agent",
    status: "inProgress",
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
        updatedAt: status === "inProgress" ? 2 : 8,
        items: [],
      },
    ],
  };
}
