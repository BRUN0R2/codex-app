import { describe, expect, it } from "vitest";

import {
  appendAgentText,
  appendReasoningText,
  applyStreamDeltas,
  readConversationState,
  readLatestTurnFailure,
  upsertItem,
} from "./conversation";

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
        output: { id: "output-1", preview: "ok", byteLength: 2, nextCursor: null },
      }),
    ).toThrow(/mudou/u);
  });

  it("separates the latest context snapshot from visible timeline items", () => {
    const state = readConversationState({
      id: "thread-1",
      mode: "codex",
      preview: "Teste",
      name: null,
      cwd: "C:\\workspace",
      projectPath: "C:\\workspace",
      createdAt: 1,
      updatedAt: 2,
      recencyAt: 2,
      status: { type: "idle" },
      turns: [
        {
          id: "turn-1",
          status: "completed",
          error: null,
          createdAt: 1,
          updatedAt: 2,
          items: [
            { type: "agentMessage", id: "message-1", text: "Pronto", phase: "finalAnswer" },
            {
              type: "contextUsage",
              id: "context-turn-1-0",
              model: "gpt-test",
              usage: {
                inputTokens: 164_000,
                cachedInputTokens: 120_000,
                outputTokens: 10_000,
                reasoningOutputTokens: 8_000,
                totalTokens: 174_000,
              },
              contextWindow: null,
            },
          ],
        },
      ],
    });

    expect(state.items.map((item) => item.id)).toEqual(["message-1"]);
    expect(state.contextUsage?.id).toBe("context-turn-1-0");
  });

  it("keeps the latest persisted turn failure visible", () => {
    expect(
      readLatestTurnFailure({
        id: "thread-1",
        mode: "codex",
        preview: "Teste",
        name: null,
        cwd: "C:\\workspace",
        projectPath: "C:\\workspace",
        createdAt: 1,
        updatedAt: 2,
        recencyAt: 2,
        status: { type: "idle" },
        turns: [
          {
            id: "turn-1",
            status: "failed",
            error: "Falha persistida",
            createdAt: 1,
            updatedAt: 2,
            items: [],
          },
        ],
      }),
    ).toBe("Falha persistida");
  });

  it("applies a large stream batch with one immutable item-array replacement", () => {
    const stable = Array.from({ length: 20_000 }, (_, index) => ({
      type: "agentMessage" as const,
      id: `message-${index}`,
      text: "stable",
      phase: null,
    }));
    const target = stable.length - 1;
    const result = applyStreamDeltas(stable, [
      {
        kind: "agentText",
        threadId: "thread-a",
        itemId: `message-${target}`,
        delta: "A",
      },
      {
        kind: "agentText",
        threadId: "thread-a",
        itemId: `message-${target}`,
        delta: "B",
      },
    ]);

    expect(result).not.toBe(stable);
    expect(result[0]).toBe(stable[0]);
    expect(result[target]).toEqual({ ...stable[target], text: "stableAB" });
  });

  it("creates and updates sparse reasoning parts within one stream batch", () => {
    const result = applyStreamDeltas(
      [],
      [
        {
          kind: "reasoningText",
          threadId: "thread-a",
          itemId: "reasoning-a",
          index: 2,
          target: "summary",
          delta: "parte",
        },
        {
          kind: "reasoningText",
          threadId: "thread-a",
          itemId: "reasoning-a",
          index: 2,
          target: "summary",
          delta: " final",
        },
      ],
    );

    expect(result).toEqual([
      {
        type: "reasoning",
        id: "reasoning-a",
        summary: ["", "", "parte final"],
        content: [],
      },
    ]);
  });
});
