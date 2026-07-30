import {
  isJsonObject,
  readString,
  type JsonObject,
  type JsonValue,
} from "../../shared/codex/types";
import type {
  ActivityEntry,
  ActivityStatus,
  CommandEntry,
  CommandSource,
  FileChange,
  FileChangeEntry,
  ImageViewEntry,
  PlanEntry,
  ReasoningEntry,
  TimelineEntry,
  ToolEntry,
  ToolKind,
} from "./timelineTypes";
import { parseUserMessage } from "./parseUserMessage";
import { boundCommandOutput, formatToolDetail } from "./timelineText";

export type TimelineItemParseResult =
  | { ok: true; entry: TimelineEntry }
  | { ok: false; error: string };

export function parseTimelineItem(
  value: JsonValue,
  completed: boolean,
): TimelineItemParseResult {
  if (!isJsonObject(value)) {
    return { ok: false, error: "A tarefa retornou um item que não é um objeto." };
  }
  const type = readString(value, "type");
  const id = readString(value, "id");
  if (type === undefined || id === undefined) {
    return {
      ok: false,
      error: "A tarefa retornou um item sem tipo ou identificador.",
    };
  }

  switch (type) {
    case "userMessage":
      return { ok: true, entry: parseUserMessage(id, value) };
    case "agentMessage":
      return {
        ok: true,
        entry: {
          type: "message",
          id,
          role: "assistant",
          text: readString(value, "text") ?? "",
          attachments: [],
          phase: readString(value, "phase") ?? null,
          status: completed ? "complete" : "streaming",
        },
      };
    case "reasoning":
      return { ok: true, entry: parseReasoning(id, value, completed) };
    case "plan":
      return { ok: true, entry: parsePlan(id, value, completed) };
    case "commandExecution":
      return { ok: true, entry: parseCommand(id, value, completed) };
    case "fileChange":
      return { ok: true, entry: parseFileChange(id, value, completed) };
    case "mcpToolCall":
      return { ok: true, entry: parseTool(id, value, "mcp", completed) };
    case "dynamicToolCall":
      return { ok: true, entry: parseTool(id, value, "dynamic", completed) };
    case "collabAgentToolCall":
      return {
        ok: true,
        entry: parseTool(id, value, "collaboration", completed),
      };
    case "contextCompaction":
      return {
        ok: true,
        entry: activity(id, "Contexto compactado automaticamente", null, completed),
      };
    case "imageView":
      return {
        ok: true,
        entry: parseImageView(id, value, completed),
      };
    case "webSearch":
      return {
        ok: true,
        entry: activity(
          id,
          "Pesquisou na web",
          readString(value, "query") ?? null,
          completed,
        ),
      };
    default:
      return {
        ok: true,
        entry: activity(
          id,
          humanizeIdentifier(type),
          "Este tipo de item ainda não possui uma visualização dedicada.",
          completed,
        ),
      };
  }
}

export function parseFileChanges(value: JsonValue | undefined): FileChange[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate) => {
    if (!isJsonObject(candidate)) {
      return [];
    }
    const path = readString(candidate, "path");
    const kind = parseFileChangeKind(candidate.kind);
    if (path === undefined || kind === null) {
      return [];
    }
    return [
      {
        path,
        kind: kind.type,
        movePath: kind.movePath,
        diff: readString(candidate, "diff") ?? "",
      },
    ];
  });
}

function parseReasoning(
  id: string,
  item: JsonObject,
  completed: boolean,
): ReasoningEntry {
  return {
    type: "reasoning",
    id,
    summary: readStringArray(item.summary),
    content: readStringArray(item.content),
    status: completed ? "completed" : "inProgress",
  };
}

function parsePlan(id: string, item: JsonObject, completed: boolean): PlanEntry {
  return {
    type: "plan",
    id,
    text: readString(item, "text") ?? "",
    status: completed ? "completed" : "inProgress",
  };
}

function parseCommand(
  id: string,
  item: JsonObject,
  completed: boolean,
): CommandEntry {
  const output = boundCommandOutput(
    readString(item, "aggregatedOutput") ?? "",
  );
  return {
    type: "command",
    id,
    command: readString(item, "command") ?? "Comando sem descrição",
    cwd: readString(item, "cwd") ?? "",
    processId: readString(item, "processId") ?? null,
    source: readCommandSource(item.source),
    status: readActivityStatus(item.status, completed),
    output: output.text,
    outputOmittedCharacters: output.omittedCharacters,
    exitCode: readNumber(item.exitCode),
    durationMs: readNumber(item.durationMs),
    terminalInput: [],
  };
}

function parseFileChange(
  id: string,
  item: JsonObject,
  completed: boolean,
): FileChangeEntry {
  return {
    type: "fileChange",
    id,
    changes: parseFileChanges(item.changes),
    status: readActivityStatus(item.status, completed),
  };
}

function parseImageView(
  id: string,
  item: JsonObject,
  completed: boolean,
): ImageViewEntry {
  return {
    type: "imageView",
    id,
    path: readString(item, "path") ?? "",
    status: readActivityStatus(item.status, completed),
  };
}

function parseTool(
  id: string,
  item: JsonObject,
  kind: ToolKind,
  completed: boolean,
): ToolEntry {
  const appContext = isJsonObject(item.appContext) ? item.appContext : undefined;
  const argumentsValue = isJsonObject(item.arguments) ? item.arguments : undefined;
  const rawName =
    readString(appContext, "actionName") ??
    readString(argumentsValue, "title") ??
    readString(item, "tool") ??
    "ferramenta";
  const error = isJsonObject(item.error)
    ? readString(item.error, "message")
    : undefined;
  const detail = formatToolDetail(error ?? item.result);
  return {
    type: "tool",
    id,
    kind,
    name: humanizeIdentifier(rawName),
    detail,
    status: readActivityStatus(item.status, completed),
  };
}

function activity(
  id: string,
  label: string,
  detail: string | null,
  completed: boolean,
): ActivityEntry {
  return {
    type: "activity",
    id,
    label,
    detail,
    status: completed ? "completed" : "inProgress",
  };
}

function parseFileChangeKind(
  value: JsonValue | undefined,
): { type: FileChange["kind"]; movePath: string | null } | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const type = readString(value, "type");
  if (type !== "add" && type !== "delete" && type !== "update") {
    return null;
  }
  return {
    type,
    movePath: type === "update" ? (readString(value, "movePath") ?? null) : null,
  };
}

function readActivityStatus(
  value: JsonValue | undefined,
  completed: boolean,
): ActivityStatus {
  if (
    value === "completed" ||
    value === "declined" ||
    value === "failed" ||
    value === "inProgress"
  ) {
    return value;
  }
  return completed ? "completed" : "inProgress";
}

function readCommandSource(value: JsonValue | undefined): CommandSource {
  if (
    value === "unifiedExecInteraction" ||
    value === "unifiedExecStartup" ||
    value === "userShell"
  ) {
    return value;
  }
  return "agent";
}

function readStringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readNumber(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function humanizeIdentifier(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[_-]+/g, " ")
    .trim();
  if (words.length === 0) {
    return "Ferramenta";
  }
  return `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}
