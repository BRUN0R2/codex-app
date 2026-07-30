import {
  isJsonObject,
  readString,
  type JsonObject,
  type JsonValue,
} from "../../shared/codex/types";
import {
  humanizeIdentifier,
  invalid,
  isActivityStatus,
  parsed,
  readBoolean,
  readNumber,
  readOptionalString,
  type ParseResult,
} from "./timelineParsing";
import { formatNarrativeText, formatToolDetail } from "./timelineText";
import type {
  AgentState,
  AgentToolAction,
  AgentToolEntry,
  SubAgentActivityEntry,
  SubAgentActivityKind,
  ToolEntry,
  ToolKind,
} from "./timelineTypes";

export function parseToolItem(
  id: string,
  item: JsonObject,
  kind: ToolKind,
): ParseResult<ToolEntry> {
  const tool = readString(item, "tool");
  if (tool === undefined || !isActivityStatus(item.status, false)) {
    return invalid(id, "não contém nome e status válidos da ferramenta");
  }
  const contractError = validateToolContract(item, kind);
  if (contractError !== null) {
    return invalid(id, contractError);
  }

  const appContext = isJsonObject(item.appContext) ? item.appContext : undefined;
  const argumentsValue = isJsonObject(item.arguments) ? item.arguments : undefined;
  const actionName = readString(appContext, "actionName");
  const rawName = actionName ?? readString(argumentsValue, "title") ?? tool;
  const error = isJsonObject(item.error)
    ? readString(item.error, "message")
    : undefined;
  const detailSource =
    error ?? (kind === "dynamic" ? item.contentItems : item.result);

  return parsed({
    type: "tool",
    id,
    kind,
    name: humanizeIdentifier(rawName),
    provider:
      readString(appContext, "appName") ??
      (kind === "mcp"
        ? (readString(item, "server") ?? null)
        : (readString(item, "namespace") ?? null)),
    detail: formatToolDetail(detailSource),
    progress: [],
    readOnly: kind === "mcp" ? readBoolean(item.readOnlyHint) : null,
    durationMs: readNumber(item.durationMs),
    status: item.status,
  });
}

export function parseAgentToolItem(
  id: string,
  item: JsonObject,
): ParseResult<AgentToolEntry> {
  const action = readAgentToolAction(item.tool);
  const senderThreadId = readString(item, "senderThreadId");
  if (
    action === null ||
    senderThreadId === undefined ||
    !isActivityStatus(item.status, false)
  ) {
    return invalid(id, "contém um contrato de colaboração inválido");
  }
  const receiverThreadIds = readRequiredStringArray(item.receiverThreadIds);
  if (receiverThreadIds === null) {
    return invalid(id, "não contém a lista de agentes destinatários");
  }
  const agents = parseAgentStates(item.agentsStates);
  if (agents === null) {
    return invalid(id, "contém estados de agentes inválidos");
  }
  const prompt = readOptionalString(item, "prompt");
  if (
    !isNullableString(item.prompt) ||
    !isNullableString(item.model) ||
    !isNullableString(item.reasoningEffort)
  ) {
    return invalid(id, "contém metadados de colaboração inválidos");
  }

  return parsed({
    type: "agentTool",
    id,
    action,
    senderThreadId,
    receiverThreadIds,
    prompt: prompt === null ? null : formatNarrativeText(prompt),
    model: readOptionalString(item, "model"),
    reasoningEffort: readOptionalString(item, "reasoningEffort"),
    agents,
    status: item.status,
  });
}

export function parseSubAgentActivityItem(
  id: string,
  item: JsonObject,
  completed: boolean,
): ParseResult<SubAgentActivityEntry> {
  const kind = readSubAgentActivityKind(item.kind);
  const agentThreadId = readString(item, "agentThreadId");
  const agentPath = readString(item, "agentPath");
  if (kind === null || agentThreadId === undefined || agentPath === undefined) {
    return invalid(id, "contém uma atividade de subagente inválida");
  }
  return parsed({
    type: "subAgentActivity",
    id,
    kind,
    agentThreadId,
    agentPath,
    status: completed ? "completed" : "inProgress",
  });
}

function validateToolContract(item: JsonObject, kind: ToolKind): string | null {
  if (!Object.hasOwn(item, "arguments") || !isNullableFiniteNumber(item.durationMs)) {
    return "contém argumentos ou duração inválidos";
  }
  if (kind === "dynamic") {
    if (
      !isNullableString(item.namespace) ||
      !isNullableBoolean(item.success) ||
      !isDynamicContentItems(item.contentItems)
    ) {
      return "contém um resultado de ferramenta dinâmica inválido";
    }
    return null;
  }
  if (
    typeof item.server !== "string" ||
    !isNullableString(item.pluginId) ||
    !isNullableBoolean(item.readOnlyHint) ||
    !isMcpAppContext(item.appContext) ||
    !isMcpResult(item.result) ||
    !isMcpError(item.error)
  ) {
    return "contém um resultado MCP inválido";
  }
  return null;
}

function isDynamicContentItems(value: JsonValue | undefined): boolean {
  if (value === null) {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every((candidate) => {
    if (!isJsonObject(candidate)) {
      return false;
    }
    switch (candidate.type) {
      case "inputText":
        return typeof candidate.text === "string";
      case "inputImage":
        return typeof candidate.imageUrl === "string";
      case "inputAudio":
        return typeof candidate.audioUrl === "string";
      default:
        return false;
    }
  });
}

function isMcpError(value: JsonValue | undefined): boolean {
  return value === null || (isJsonObject(value) && typeof value.message === "string");
}

function isMcpAppContext(value: JsonValue | undefined): boolean {
  return (
    value === null ||
    (isJsonObject(value) &&
      typeof value.connectorId === "string" &&
      isNullableString(value.linkId) &&
      isNullableString(value.resourceUri) &&
      isNullableString(value.appName) &&
      isNullableString(value.actionName))
  );
}

function isMcpResult(value: JsonValue | undefined): boolean {
  return (
    value === null ||
    (isJsonObject(value) &&
      Array.isArray(value.content) &&
      Object.hasOwn(value, "structuredContent") &&
      Object.hasOwn(value, "_meta"))
  );
}

function isNullableBoolean(value: JsonValue | undefined): boolean {
  return value === null || typeof value === "boolean";
}

function isNullableString(value: JsonValue | undefined): boolean {
  return value === null || typeof value === "string";
}

function isNullableFiniteNumber(value: JsonValue | undefined): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function readAgentToolAction(value: JsonValue | undefined): AgentToolAction | null {
  return value === "closeAgent" ||
    value === "resumeAgent" ||
    value === "sendInput" ||
    value === "spawnAgent" ||
    value === "wait"
    ? value
    : null;
}

function readSubAgentActivityKind(
  value: JsonValue | undefined,
): SubAgentActivityKind | null {
  return value === "interacted" || value === "interrupted" || value === "started"
    ? value
    : null;
}

function readRequiredStringArray(value: JsonValue | undefined): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

function parseAgentStates(value: JsonValue | undefined): AgentState[] | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const states: AgentState[] = [];
  for (const [threadId, candidate] of Object.entries(value)) {
    if (!isJsonObject(candidate)) {
      return null;
    }
    const status = readString(candidate, "status");
    const message = candidate.message;
    if (
      status === undefined ||
      !Object.hasOwn(candidate, "message") ||
      (message !== undefined && message !== null && typeof message !== "string")
    ) {
      return null;
    }
    states.push({
      threadId,
      status,
      message: typeof message === "string" ? message : null,
    });
  }
  return states;
}
