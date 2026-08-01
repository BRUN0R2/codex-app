import { describe, expect, it } from "vitest";

import { appendAgentText, appendReasoningText, upsertItem } from "./conversation";

describe("conversation reducer", () => {
  it("builds deterministic streamed messages", () => {
    const first = appendAgentText([], "message-1", "Olá");
    const second = appendAgentText(first, "message-1", " mundo");
    expect(second).toEqual([
      { type: "agentMessage", id: "message-1", text: "Olá mundo", phase: null },
    ]);
  });

  it("preserves reasoning indices from the provider", () => {
    const result = appendReasoningText([], "reasoning-1", 1, "segundo", "summary");
    expect(result).toEqual([
      {
        type: "reasoning",
        id: "reasoning-1",
        summary: ["", "segundo"],
        content: [],
      },
    ]);
  });

  it("rejects an id that changes semantic type", () => {
    const current = [{ type: "agentMessage", id: "same", text: "x", phase: null }] as const;
    expect(() =>
      upsertItem(current, {
        type: "toolExecution",
        id: "same",
        name: "read_file",
        description: "Read",
        status: "completed",
        output: "ok",
      }),
    ).toThrow(/mudou/u);
  });
});
