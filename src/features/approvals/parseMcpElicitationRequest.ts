import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../../shared/codex/types";
import { parseMcpFormField } from "./parseMcpFormField";
import {
  decoded,
  rejected,
  requiredNullableString,
  type DecodeResult,
} from "./requestParsing";
import type {
  McpFormField,
  McpFormRequest,
  McpUnsupportedFormRequest,
  McpUrlRequest,
  ServerRequestId,
} from "./serverRequestTypes";

const MAX_FORM_FIELDS = 32;

type ParsedMcpRequest =
  | McpFormRequest
  | McpUnsupportedFormRequest
  | McpUrlRequest;

export function parseMcpElicitationRequest(
  id: ServerRequestId,
  params: JsonObject,
): DecodeResult<ParsedMcpRequest> {
  const base = parseBase(id, params);
  if (!base.ok) {
    return base;
  }
  switch (params.mode) {
    case "form": {
      const fields = parseFormSchema(params.requestedSchema);
      if (!fields.ok) {
        return fields;
      }
      const approval = parseApprovalMeta(params._meta);
      if (!approval.ok) {
        return approval;
      }
      return decoded({
        ...base.value,
        kind: "mcpForm",
        fields: fields.value,
        isToolApproval: approval.value.isToolApproval,
        persistModes: approval.value.persistModes,
      });
    }
    case "openai/form":
      return decoded({
        ...base.value,
        kind: "mcpUnsupportedForm",
        explanation:
          "O servidor enviou um formulário OpenAI estendido que este cliente não anunciou como suportado.",
      });
    case "url":
      return typeof params.elicitationId === "string" && isSafeWebUrl(params.url)
        ? decoded({
            ...base.value,
            kind: "mcpUrl",
            elicitationId: params.elicitationId,
            url: params.url,
          })
        : rejected("a solicitação MCP contém uma URL ou identificação inválida");
    default:
      return rejected("o app-server retornou um modo de elicitação MCP desconhecido");
  }
}

function parseBase(
  id: ServerRequestId,
  params: JsonObject,
): DecodeResult<{
  id: ServerRequestId;
  message: string;
  method: "mcpServer/elicitation/request";
  serverName: string;
  threadId: string;
  turnId: string | null;
}> {
  if (
    typeof params.threadId !== "string" ||
    !requiredNullableString(params.turnId) ||
    typeof params.serverName !== "string" ||
    typeof params.message !== "string"
  ) {
    return rejected("a elicitação MCP não contém escopo e mensagem válidos");
  }
  return decoded({
    id,
    method: "mcpServer/elicitation/request",
    threadId: params.threadId,
    turnId: typeof params.turnId === "string" ? params.turnId : null,
    serverName: params.serverName,
    message: params.message,
  });
}

function parseFormSchema(value: JsonValue | undefined): DecodeResult<McpFormField[]> {
  if (
    !isJsonObject(value) ||
    value.type !== "object" ||
    !isJsonObject(value.properties)
  ) {
    return rejected("o formulário MCP não possui um esquema de objeto válido");
  }
  const entries = Object.entries(value.properties);
  if (entries.length > MAX_FORM_FIELDS) {
    return rejected(`o formulário MCP excede o limite de ${MAX_FORM_FIELDS} campos`);
  }
  const required = parseRequiredFields(value.required);
  if (!required.ok) {
    return required;
  }
  const knownNames = new Set(entries.map(([name]) => name));
  if (required.value.some((name) => !knownNames.has(name))) {
    return rejected("o formulário marca como obrigatório um campo inexistente");
  }
  const fields: McpFormField[] = [];
  for (const [name, schema] of entries) {
    const field = parseMcpFormField(name, schema, required.value.includes(name));
    if (!field.ok) {
      return field;
    }
    fields.push(field.value);
  }
  return decoded(fields);
}

function parseRequiredFields(value: JsonValue | undefined): DecodeResult<string[]> {
  if (value === undefined) {
    return decoded([]);
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return rejected("a lista de campos obrigatórios do formulário é inválida");
  }
  return new Set(value).size === value.length
    ? decoded(value)
    : rejected("o formulário contém campos obrigatórios repetidos");
}

function parseApprovalMeta(value: JsonValue | undefined): DecodeResult<{
  isToolApproval: boolean;
  persistModes: Array<"always" | "session">;
}> {
  if (!isJsonObject(value) || value.codex_approval_kind !== "mcp_tool_call") {
    return decoded({ isToolApproval: false, persistModes: [] });
  }
  const persist = value.persist;
  if (persist === undefined) {
    return decoded({ isToolApproval: true, persistModes: [] });
  }
  const values = typeof persist === "string" ? [persist] : persist;
  if (
    !Array.isArray(values) ||
    !values.every((entry) => entry === "session" || entry === "always")
  ) {
    return rejected("os modos de persistência da aprovação MCP são inválidos");
  }
  return decoded({
    isToolApproval: true,
    persistModes: [...new Set(values)] as Array<"always" | "session">,
  });
}

function isSafeWebUrl(value: JsonValue | undefined): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
