import { describe, expect, it } from "vitest";

import type { VisibleThreadItem } from "../contracts/types";
import { projectTurnPresentation, TurnPresentationStore } from "./turnPresentation";

describe("turn presentation", () => {
  it("preserves user guidance between agent work and the final response", () => {
    const presentation = projectTurnPresentation([
      userMessage("user-1", "Primeira mensagem"),
      agentMessage("commentary-1", "Primeira orientação", "commentary"),
      command("command-1"),
      userMessage("user-2", "Segunda mensagem"),
      agentMessage("commentary-2", "Segunda orientação", "commentary"),
      userMessage("user-3", "Terceira mensagem"),
      agentMessage("answer-1", "Resposta final", "finalAnswer"),
    ]);

    expect(
      presentation.blocks.map((block) =>
        block.kind === "message"
          ? `${block.item.type}:${block.item.id}`
          : `work:${block.items.map((item) => item.id).join(",")}`,
      ),
    ).toEqual([
      "userMessage:user-1",
      "agentMessage:commentary-1",
      "work:command-1",
      "userMessage:user-2",
      "agentMessage:commentary-2",
      "userMessage:user-3",
      "agentMessage:answer-1",
    ]);
    expect(presentation.firstWorkBlockIndex).toBe(2);
    expect(presentation.lastWorkBlockIndex).toBe(2);
    expect(presentation.trailingAgentMessageBlockIndex).toBe(6);
    expect(presentation.blocks.map((block) => block.key)).toEqual([
      "message:userMessage:user-1",
      "message:agentMessage:commentary-1",
      "work-after:agentMessage:commentary-1",
      "message:userMessage:user-2",
      "message:agentMessage:commentary-2",
      "message:userMessage:user-3",
      "message:agentMessage:answer-1",
    ]);
  });

  it("omits plans without splitting adjacent work activity", () => {
    const presentation = projectTurnPresentation([
      userMessage("user-1", "Mensagem"),
      command("command-1"),
      {
        type: "plan",
        id: "plan-1",
        explanation: null,
        steps: [{ step: "Executar", status: "inProgress" }],
      },
      agentMessage("commentary-1", "Comentário", "commentary"),
    ]);

    expect(presentation.blocks).toHaveLength(3);
    expect(presentation.blocks[1]).toMatchObject({
      kind: "work",
      items: [{ id: "command-1" }],
    });
    expect(presentation.blocks[2]).toMatchObject({
      kind: "message",
      item: { id: "commentary-1" },
    });
    expect(presentation.trailingAgentMessageBlockIndex).toBe(2);
  });

  it("reuses unchanged blocks while a trailing message streams", () => {
    const store = new TurnPresentationStore();
    const user = userMessage("user-1", "Mensagem");
    const work = command("command-1");
    const firstMessage = agentMessage("commentary-1", "a", "commentary");
    const first = store.project([user, work, firstMessage]);
    const next = store.project([user, work, { ...firstMessage, text: "ab" }]);

    expect(next).not.toBe(first);
    expect(next.blocks[0]).toBe(first.blocks[0]);
    expect(next.blocks[1]).toBe(first.blocks[1]);
    expect(next.blocks[2]).not.toBe(first.blocks[2]);
  });

  it("returns the same projection when only ignored plan data changes", () => {
    const store = new TurnPresentationStore();
    const user = userMessage("user-1", "Mensagem");
    const work = command("command-1");
    const first = store.project([
      user,
      work,
      {
        type: "plan",
        id: "plan-1",
        explanation: null,
        steps: [{ step: "Executar", status: "inProgress" }],
      },
    ]);
    const next = store.project([
      user,
      work,
      {
        type: "plan",
        id: "plan-1",
        explanation: "Atualizado",
        steps: [{ step: "Executar", status: "completed" }],
      },
    ]);

    expect(next).toBe(first);
  });

  it("preserves existing message blocks when an earlier message shifts their positions", () => {
    const store = new TurnPresentationStore();
    const firstUser = userMessage("user-1", "Primeira");
    const answer = agentMessage("answer-1", "Resposta", "finalAnswer");
    const initial = store.project([firstUser, answer]);
    const shifted = store.project([userMessage("user-0", "Anterior"), firstUser, answer]);

    expect(shifted.blocks.map((block) => block.key)).toEqual([
      "message:userMessage:user-0",
      "message:userMessage:user-1",
      "message:agentMessage:answer-1",
    ]);
    expect(shifted.blocks[1]).toBe(initial.blocks[0]);
    expect(shifted.blocks[2]).toBe(initial.blocks[1]);
  });
});

function userMessage(
  id: string,
  text: string,
): Extract<VisibleThreadItem, { readonly type: "userMessage" }> {
  return {
    type: "userMessage",
    id,
    content: [{ type: "text", text }],
  };
}

function agentMessage(
  id: string,
  text: string,
  phase: "commentary" | "finalAnswer",
): Extract<VisibleThreadItem, { readonly type: "agentMessage" }> {
  return {
    type: "agentMessage",
    id,
    text,
    phase,
  };
}

function command(id: string): Extract<VisibleThreadItem, { readonly type: "commandExecution" }> {
  return {
    type: "commandExecution",
    id,
    command: "pnpm verify",
    cwd: ".",
    processId: null,
    startedAt: null,
    source: "agent",
    status: "completed",
    aggregatedOutput: null,
    exitCode: 0,
    durationMs: 1,
  };
}
