import type { CodexThread, CompletedTurn } from "../contracts/types";

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
