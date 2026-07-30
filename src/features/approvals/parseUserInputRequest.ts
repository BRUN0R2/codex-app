import { isJsonObject, type JsonObject } from "../../shared/codex/types";
import {
  decoded,
  isFiniteInteger,
  rejected,
  type DecodeResult,
} from "./requestParsing";
import type {
  ServerRequestId,
  UserInputOption,
  UserInputQuestion,
  UserInputRequest,
} from "./serverRequestTypes";

const MAX_QUESTIONS = 3;

export function parseUserInputRequest(
  id: ServerRequestId,
  params: JsonObject,
): DecodeResult<UserInputRequest> {
  if (
    typeof params.threadId !== "string" ||
    typeof params.turnId !== "string" ||
    typeof params.itemId !== "string"
  ) {
    return rejected("a solicitação de entrada não contém escopo válido");
  }
  if (
    !Array.isArray(params.questions) ||
    params.questions.length === 0 ||
    params.questions.length > MAX_QUESTIONS
  ) {
    return rejected(`a solicitação deve conter de 1 a ${MAX_QUESTIONS} perguntas`);
  }
  const questions: UserInputQuestion[] = [];
  const identifiers = new Set<string>();
  for (const value of params.questions) {
    if (!isJsonObject(value)) {
      return rejected("uma pergunta não é um objeto");
    }
    const question = parseQuestion(value);
    if (!question.ok) {
      return question;
    }
    if (identifiers.has(question.value.id)) {
      return rejected("a solicitação contém identificadores de pergunta repetidos");
    }
    identifiers.add(question.value.id);
    questions.push(question.value);
  }
  const autoResolutionMs = params.autoResolutionMs;
  if (
    autoResolutionMs !== undefined &&
    autoResolutionMs !== null &&
    (!isFiniteInteger(autoResolutionMs) || autoResolutionMs <= 0)
  ) {
    return rejected("o tempo de resolução automática é inválido");
  }
  return decoded({
    id,
    kind: "userInput",
    method: "item/tool/requestUserInput",
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    questions,
    autoResolutionMs:
      typeof autoResolutionMs === "number" ? autoResolutionMs : null,
  });
}

function parseQuestion(value: JsonObject): DecodeResult<UserInputQuestion> {
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.header !== "string" ||
    typeof value.question !== "string" ||
    typeof value.isOther !== "boolean" ||
    typeof value.isSecret !== "boolean"
  ) {
    return rejected("uma pergunta contém campos obrigatórios inválidos");
  }
  const options = parseOptions(value.options);
  if (!options.ok) {
    return options;
  }
  return decoded({
    id: value.id,
    header: value.header,
    question: value.question,
    isOther: value.isOther,
    isSecret: value.isSecret,
    options: options.value.length === 0 ? null : options.value,
  });
}

function parseOptions(value: unknown): DecodeResult<UserInputOption[]> {
  if (value === undefined || value === null) {
    return decoded([]);
  }
  if (!Array.isArray(value)) {
    return rejected("as opções de uma pergunta são inválidas");
  }
  const options: UserInputOption[] = [];
  const labels = new Set<string>();
  for (const candidate of value) {
    if (
      !isJsonObject(candidate) ||
      typeof candidate.label !== "string" ||
      candidate.label.length === 0 ||
      typeof candidate.description !== "string"
    ) {
      return rejected("uma opção de resposta é inválida");
    }
    if (labels.has(candidate.label)) {
      return rejected("uma pergunta contém opções repetidas");
    }
    labels.add(candidate.label);
    options.push({
      label: candidate.label,
      description: candidate.description,
    });
  }
  return decoded(options);
}
