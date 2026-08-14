import type {
  CodexThread,
  CompletedTurn,
  ThreadItem,
  ThreadSummary,
  TurnSummary,
} from "../contracts/types";

export function applySummaryTurnStarted(thread: ThreadSummary, turn: TurnSummary): ThreadSummary {
  return {
    ...thread,
    status: { type: "active", activeFlags: [] },
    updatedAt: Math.max(thread.updatedAt, turn.updatedAt),
  };
}

export function applySummaryTurnCompletion(
  thread: ThreadSummary,
  completion: CompletedTurn,
): ThreadSummary {
  return {
    ...thread,
    status: { type: "idle" },
    updatedAt: Math.max(thread.updatedAt, completion.updatedAt),
  };
}

export function applyTurnStarted(thread: CodexThread, turn: TurnSummary): CodexThread {
  const existing = thread.turns.find((entry) => entry.id === turn.id);
  if (existing !== undefined) {
    if (
      existing.status === turn.status &&
      existing.createdAt === turn.createdAt &&
      existing.updatedAt === turn.updatedAt
    ) {
      return thread;
    }
    throw new Error(`O turno ${JSON.stringify(turn.id)} foi iniciado com dados conflitantes.`);
  }
  if (turn.status !== "inProgress") {
    throw new Error(`O novo turno ${JSON.stringify(turn.id)} não está em progresso.`);
  }
  return {
    ...thread,
    status: { type: "active", activeFlags: [] },
    turns: [
      ...thread.turns,
      {
        ...turn,
        items: [],
        error: null,
      },
    ],
    updatedAt: Math.max(thread.updatedAt, turn.updatedAt),
  };
}

export function applyTurnItem(thread: CodexThread, turnId: string, item: ThreadItem): CodexThread {
  const turnIndex = thread.turns.findIndex((turn) => turn.id === turnId);
  if (turnIndex < 0) {
    throw new Error(`O item ${JSON.stringify(item.id)} não pertence a um turno carregado.`);
  }
  const turn = thread.turns[turnIndex];
  if (turn === undefined) {
    throw new Error("A posição do turno que recebeu um item ficou inconsistente.");
  }
  const itemIndex = turn.items.findIndex((entry) => entry.id === item.id);
  if (itemIndex >= 0 && turn.items[itemIndex]?.type !== item.type) {
    throw new Error(`O item ${JSON.stringify(item.id)} mudou de tipo durante o turno.`);
  }
  const items = turn.items.slice();
  if (itemIndex < 0) {
    items.push(item);
  } else {
    items[itemIndex] = item;
  }
  const turns = thread.turns.slice();
  turns[turnIndex] = { ...turn, items };
  return { ...thread, turns };
}

export function applyTurnCompletion(thread: CodexThread, completion: CompletedTurn): CodexThread {
  const turnIndex = thread.turns.findIndex((turn) => turn.id === completion.id);
  if (turnIndex < 0) {
    throw new Error(`O turno terminal ${JSON.stringify(completion.id)} não pertence à tarefa.`);
  }
  const current = thread.turns[turnIndex];
  if (current === undefined) {
    throw new Error("A posição do turno terminal ficou inconsistente.");
  }
  if (current.status !== "inProgress") {
    if (
      current.status === completion.status &&
      current.error === completion.error &&
      current.updatedAt === completion.updatedAt
    ) {
      return thread;
    }
    throw new Error(`O turno ${JSON.stringify(completion.id)} recebeu conclusões conflitantes.`);
  }
  if (completion.updatedAt < current.createdAt) {
    throw new Error(`O turno ${JSON.stringify(completion.id)} terminou antes de ser criado.`);
  }

  const turns = thread.turns.slice();
  turns[turnIndex] = {
    ...current,
    status: completion.status,
    error: completion.error,
    updatedAt: completion.updatedAt,
  };
  return {
    ...thread,
    status: { type: "idle" },
    turns,
    updatedAt: Math.max(thread.updatedAt, completion.updatedAt),
  };
}
