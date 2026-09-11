import type { ThreadSummary } from "../contracts/types";

export interface TaskThreadCollections {
  readonly rootThreads: readonly ThreadSummary[];
  readonly agentThreads: readonly ThreadSummary[];
}

export function upsertTaskThread(
  current: TaskThreadCollections,
  incoming: ThreadSummary,
): TaskThreadCollections {
  if (incoming.agent === null) {
    return {
      rootThreads: upsertInPlace(current.rootThreads, incoming),
      agentThreads: current.agentThreads.filter((thread) => thread.id !== incoming.id),
    };
  }
  return {
    rootThreads: current.rootThreads.filter((thread) => thread.id !== incoming.id),
    agentThreads: upsertInPlace(current.agentThreads, incoming),
  };
}

export function replaceTaskAgentFamily(
  current: readonly ThreadSummary[],
  selectedThread: ThreadSummary,
  family: readonly ThreadSummary[],
): readonly ThreadSummary[] {
  const rootThreadId = selectedThread.agent?.rootThreadId ?? selectedThread.id;
  const familyIds = new Set<string>();
  for (const agent of family) {
    if (agent.agent?.rootThreadId !== rootThreadId) {
      throw new Error("The engine returned an agent from another task family.");
    }
    if (familyIds.has(agent.id)) {
      throw new Error("The engine returned the same agent more than once.");
    }
    familyIds.add(agent.id);
  }
  return [...current.filter((agent) => agent.agent?.rootThreadId !== rootThreadId), ...family];
}

export function updateTaskThread(
  current: TaskThreadCollections,
  threadId: string,
  update: (thread: ThreadSummary) => ThreadSummary,
): TaskThreadCollections {
  return {
    rootThreads: current.rootThreads.map((thread) =>
      thread.id === threadId ? update(thread) : thread,
    ),
    agentThreads: current.agentThreads.map((thread) =>
      thread.id === threadId ? update(thread) : thread,
    ),
  };
}

function upsertInPlace(
  current: readonly ThreadSummary[],
  incoming: ThreadSummary,
): readonly ThreadSummary[] {
  const index = current.findIndex((thread) => thread.id === incoming.id);
  if (index === -1) return [incoming, ...current];
  return current.map((thread, entryIndex) => (entryIndex === index ? incoming : thread));
}
