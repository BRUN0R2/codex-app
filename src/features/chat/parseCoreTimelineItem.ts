import {
  isJsonObject,
  readString,
  type JsonObject,
  type JsonValue,
} from "../../shared/codex/types";
import {
  invalid,
  isActivityStatus,
  isCommandSource,
  lifecycleStatus,
  parsed,
  readMessagePhase,
  readNumber,
  readStringArray,
  type ParseResult,
} from "./timelineParsing";
import { boundCommandOutput } from "./timelineText";
import type {
  CommandEntry,
  FileChange,
  FileChangeEntry,
  ImageViewEntry,
  MessageEntry,
  PlanEntry,
  ReasoningEntry,
} from "./timelineTypes";

export function parseAgentMessageItem(
  id: string,
  item: JsonObject,
  completed: boolean,
): ParseResult<MessageEntry> {
  const text = readString(item, "text");
  const phase = item.phase;
  if (
    text === undefined ||
    (phase !== undefined &&
      phase !== null &&
      phase !== "commentary" &&
      phase !== "final_answer")
  ) {
    return invalid(id, "contém uma mensagem do agente inválida");
  }
  return parsed({
    type: "message",
    id,
    role: "assistant",
    text,
    attachments: [],
    phase: readMessagePhase(phase),
    status: completed ? "complete" : "streaming",
  });
}

export function parseReasoningItem(
  id: string,
  item: JsonObject,
  completed: boolean,
): ParseResult<ReasoningEntry> {
  if (!isStringArray(item.summary) || !isStringArray(item.content)) {
    return invalid(id, "contém um raciocínio inválido");
  }
  return parsed({
    type: "reasoning",
    id,
    summary: readStringArray(item.summary),
    content: readStringArray(item.content),
    status: completed ? "completed" : "inProgress",
  });
}

export function parsePlanItem(
  id: string,
  item: JsonObject,
  completed: boolean,
): ParseResult<PlanEntry> {
  const text = readString(item, "text");
  return text === undefined
    ? invalid(id, "não contém o texto do plano")
    : parsed({
        type: "plan",
        id,
        text,
        status: completed ? "completed" : "inProgress",
      });
}

export function parseCommandItem(
  id: string,
  item: JsonObject,
): ParseResult<CommandEntry> {
  const command = readString(item, "command");
  const cwd = readString(item, "cwd");
  const processId = item.processId;
  const aggregatedOutput = item.aggregatedOutput;
  const exitCode = item.exitCode;
  const durationMs = item.durationMs;
  if (
    command === undefined ||
    cwd === undefined ||
    !isCommandSource(item.source) ||
    !isActivityStatus(item.status, true) ||
    (processId !== null && typeof processId !== "string") ||
    (aggregatedOutput !== null && typeof aggregatedOutput !== "string") ||
    !isNullableFiniteNumber(exitCode) ||
    !isNullableFiniteNumber(durationMs) ||
    !Array.isArray(item.commandActions)
  ) {
    return invalid(id, "contém uma execução de comando inválida");
  }
  const output = boundCommandOutput(
    typeof aggregatedOutput === "string" ? aggregatedOutput : "",
  );
  return parsed({
    type: "command",
    id,
    command,
    cwd,
    processId: typeof processId === "string" ? processId : null,
    source: item.source,
    status: item.status,
    output: output.text,
    outputOmittedCharacters: output.omittedCharacters,
    exitCode: readNumber(exitCode),
    durationMs: readNumber(durationMs),
    terminalInput: [],
  });
}

export function parseFileChangeItem(
  id: string,
  item: JsonObject,
): ParseResult<FileChangeEntry> {
  const changes = parseFileChanges(item.changes, id);
  if (!isActivityStatus(item.status, true)) {
    return invalid(id, "contém um status de alteração desconhecido");
  }
  return changes.ok
    ? parsed({
        type: "fileChange",
        id,
        changes: changes.value,
        status: item.status,
      })
    : changes;
}

export function parseImageViewItem(
  id: string,
  item: JsonObject,
  completed: boolean,
): ParseResult<ImageViewEntry> {
  const path = readString(item, "path");
  return path === undefined
    ? invalid(id, "não contém o caminho da imagem visualizada")
    : parsed({
        type: "imageView",
        id,
        path,
        status: lifecycleStatus(completed),
      });
}

export function parseFileChanges(
  value: JsonValue | undefined,
  itemId: string,
): ParseResult<FileChange[]> {
  if (!Array.isArray(value)) {
    return invalid(itemId, "não contém uma lista de alterações");
  }
  const changes: FileChange[] = [];
  for (const candidate of value) {
    if (!isJsonObject(candidate)) {
      return invalid(itemId, "contém uma alteração que não é um objeto");
    }
    const path = readString(candidate, "path");
    const kind = parseFileChangeKind(candidate.kind);
    const diff = readString(candidate, "diff");
    if (path === undefined || kind === null || diff === undefined) {
      return invalid(itemId, "contém uma alteração de arquivo inválida");
    }
    changes.push({
      path,
      kind: kind.type,
      movePath: kind.movePath,
      diff,
    });
  }
  return parsed(changes);
}

function parseFileChangeKind(
  value: JsonValue | undefined,
): { type: FileChange["kind"]; movePath: string | null } | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const type = readString(value, "type");
  if (type === "add" || type === "delete") {
    return { type, movePath: null };
  }
  if (type !== "update") {
    return null;
  }
  const movePath = value.move_path;
  return movePath === null || typeof movePath === "string"
    ? { type, movePath }
    : null;
}

function isStringArray(value: JsonValue | undefined): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNullableFiniteNumber(value: JsonValue | undefined): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}
