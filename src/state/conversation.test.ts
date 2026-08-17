import { describe, expect, it } from "vitest";

import { applyStreamDeltas, readLatestTurnFailure, upsertItem } from "./conversation";

describe("conversation reducer", () => {
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
