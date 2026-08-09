import { describe, expect, it } from "vitest";

import type { CodexThread, CompletedTurn } from "../contracts/types";
import { applyTurnCompletion } from "./turnCompletion";

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

function threadFixture(status: "completed" | "inProgress"): CodexThread {
  return {
    id: "thread-a",
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
