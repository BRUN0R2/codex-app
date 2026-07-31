import {
  isJsonObject,
  type CodexThread,
} from "../../shared/codex/types";
import { pathsEqual } from "../projects/projectStore";

export function validateSafetyRetryForkPoint(
  thread: CodexThread,
  interruptedTurnId: string,
) {
  const interruptedIndex = thread.turns.findIndex(
    ({ id }) => id === interruptedTurnId,
  );
  if (interruptedIndex < 0) {
    throw new Error(
      "O turno interrompido não existe mais no histórico autoritativo.",
    );
  }
  if (interruptedIndex !== thread.turns.length - 1) {
    throw new Error(
      "O turno interrompido deixou de ser o turno mais recente da tarefa.",
    );
  }
  if (thread.turns[interruptedIndex]?.status === "inProgress") {
    throw new Error(
      "O Codex ainda não concluiu a interrupção; o retry seguro não foi iniciado.",
    );
  }
  const previousTurn = thread.turns[interruptedIndex - 1];
  if (previousTurn?.status === "inProgress") {
    throw new Error(
      "O turno anterior ainda está em andamento; não é seguro criar o fork.",
    );
  }
}

export function validateSafetyRetryFork(
  source: CodexThread,
  fork: CodexThread,
  beforeTurnId: string,
) {
  if (fork.id.trim().length === 0 || fork.id === source.id) {
    throw new Error("O Codex retornou um identificador de fork inválido.");
  }
  if (!pathsEqual(source.cwd, fork.cwd)) {
    throw new Error("O fork foi criado fora do projeto de origem.");
  }

  const expectedTurnCount = source.turns.findIndex(
    ({ id }) => id === beforeTurnId,
  );
  if (
    expectedTurnCount < 0
    || fork.turns.some(({ id }) => id === beforeTurnId)
    || fork.turns.length !== expectedTurnCount
    || fork.turns.some(
      (turn, index) =>
        turn.id !== source.turns[index]?.id || turn.status === "inProgress",
    )
  ) {
    throw new Error(
      "O histórico retornado pelo fork não corresponde ao ponto seguro solicitado.",
    );
  }
}

export function threadTurnHasUserMessage(
  thread: CodexThread,
  turnId: string,
): boolean {
  return thread.turns
    .find(({ id }) => id === turnId)
    ?.items.some(
      (item) => isJsonObject(item) && item.type === "userMessage",
    ) === true;
}
