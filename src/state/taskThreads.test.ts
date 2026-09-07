import { describe, expect, it } from "vitest";

import type { ThreadSummary } from "../contracts/types";
import { replaceTaskAgentFamily, updateTaskThread, upsertTaskThread } from "./taskThreads";

function root(id: string): ThreadSummary {
  return {
    id,
    agent: null,
    mode: "codex",
    preview: id,
    name: id,
    cwd: "C:\\workspace",
    projectPath: "C:\\workspace",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: "idle" },
  };
}

function agent(id: string, rootThreadId: string, parentThreadId = rootThreadId): ThreadSummary {
  return {
    ...root(id),
    agent: {
      rootThreadId,
      parentThreadId,
      path: `/root/${id}`,
      taskName: id,
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      serviceTier: "priority",
    },
  };
}

describe("task thread collections", () => {
  it("routes agent notifications to task tabs without creating sidebar tasks", () => {
    const main = root("main");
    const child = agent("agent-1", main.id);

    expect(upsertTaskThread({ rootThreads: [main], agentThreads: [] }, child)).toEqual({
      rootThreads: [main],
      agentThreads: [child],
    });
  });

  it("replaces only the selected task family and rejects malformed families", () => {
    const first = agent("agent-1", "main");
    const second = agent("agent-2", "main");
    const unrelated = agent("agent-other", "other");

    expect(replaceTaskAgentFamily([first, unrelated], root("main"), [second])).toEqual([
      unrelated,
      second,
    ]);
    expect(() => replaceTaskAgentFamily([], root("main"), [unrelated])).toThrow(
      "another task family",
    );
    expect(() => replaceTaskAgentFamily([], root("main"), [second, second])).toThrow(
      "more than once",
    );
  });

  it("updates root and agent runtime summaries through the same transition", () => {
    const main = root("main");
    const child = agent("agent-1", main.id);
    const active = updateTaskThread(
      { rootThreads: [main], agentThreads: [child] },
      child.id,
      (thread) => ({ ...thread, status: { type: "active", activeFlags: [] } }),
    );

    expect(active.rootThreads).toEqual([main]);
    expect(active.agentThreads[0]?.status).toEqual({ type: "active", activeFlags: [] });
  });
});
