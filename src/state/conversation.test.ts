import { describe, expect, it } from "vitest";

import {
  applyCommandStreamDeltasToThread,
  applyStreamDeltas,
  readLatestTurnFailure,
  removeItem,
  upsertItem,
} from "./conversation";

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
        outputPresentation: { type: "sourceFile", path: "src/main.rs" },
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

  it("removes completed overlays without replacing unchanged collections", () => {
    const items = [
      { type: "agentMessage", id: "first", text: "A", phase: null },
      { type: "agentMessage", id: "second", text: "B", phase: null },
    ] as const;

    expect(removeItem(items, "missing")).toBe(items);
    expect(removeItem(items, "first")).toEqual([items[1]]);
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

  it("applies live command operations without corrupting Unicode", () => {
    const command = {
      type: "commandExecution" as const,
      id: "command-a",
      command: "build",
      cwd: ".",
      processId: null,
      startedAt: 1,
      source: "agent" as const,
      status: "inProgress" as const,
      aggregatedOutput: null,
      liveOutput: { stdout: "", stderr: "", truncated: false },
      exitCode: null,
      durationMs: null,
    };
    const result = applyStreamDeltas(
      [command],
      [
        commandDelta("stdout", { type: "append", delta: "loading 10%" }),
        commandDelta("stdout", { type: "clearCurrentLine" }),
        commandDelta("stdout", { type: "append", delta: "done😀" }),
        commandDelta("stdout", { type: "backspace" }),
        commandDelta("stderr", { type: "append", delta: "warning" }),
        commandDelta("stderr", { type: "truncated" }),
      ],
    );

    expect(result).toEqual([
      {
        ...command,
        liveOutput: { stdout: "done", stderr: "warning", truncated: true },
      },
    ]);
  });

  it("routes background command deltas to their persisted turn", () => {
    const thread = {
      id: "thread-a",
      mode: "codex" as const,
      preview: "Build",
      name: null,
      cwd: ".",
      projectPath: ".",
      createdAt: 1,
      updatedAt: 2,
      recencyAt: 2,
      status: { type: "idle" as const },
      turns: [
        {
          id: "turn-a",
          status: "completed" as const,
          error: null,
          createdAt: 1,
          updatedAt: 2,
          items: [
            {
              type: "commandExecution" as const,
              id: "command-a",
              command: "build",
              cwd: ".",
              processId: "session-a",
              startedAt: 1,
              source: "agent" as const,
              status: "inProgress" as const,
              aggregatedOutput: null,
              liveOutput: { stdout: "start\n", stderr: "", truncated: false },
              exitCode: null,
              durationMs: null,
            },
          ],
        },
      ],
    };

    const updated = applyCommandStreamDeltasToThread(thread, [
      commandDelta("stdout", { type: "append", delta: "done\n" }),
    ]);

    expect(updated.turns[0]?.items[0]).toMatchObject({
      liveOutput: { stdout: "start\ndone\n", stderr: "", truncated: false },
    });
    expect(
      applyCommandStreamDeltasToThread(thread, [
        { ...commandDelta("stdout", { type: "append", delta: "ignored" }), turnId: "missing" },
      ]),
    ).toBe(thread);
  });
});

function commandDelta(
  stream: "stderr" | "stdout",
  operation:
    | { readonly type: "append"; readonly delta: string }
    | { readonly type: "backspace" | "clearCurrentLine" | "truncated" },
) {
  return {
    kind: "commandOutput" as const,
    threadId: "thread-a",
    turnId: "turn-a",
    itemId: "command-a",
    stream,
    operation,
  };
}
