import {
  isJsonObject,
  readString,
  type JsonObject,
} from "../../shared/codex/types";
import {
  parseCommandApprovalRequest,
  parseFileChangeApprovalRequest,
  parsePermissionsApprovalRequest,
} from "./parseApprovalRequest";
import { parseMcpElicitationRequest } from "./parseMcpElicitationRequest";
import { decodeRequestId, type DecodeResult } from "./requestParsing";
import { parseUserInputRequest } from "./parseUserInputRequest";
import type {
  InteractiveServerRequest,
  PendingServerRequest,
  ServerRequestId,
  UnsupportedServerRequest,
} from "./serverRequestTypes";

export type ServerRequestParseResult =
  | { ok: true; request: InteractiveServerRequest }
  | { ok: false; error: string; request: UnsupportedServerRequest | null };

export function parseServerRequest(value: unknown): ServerRequestParseResult {
  if (!isJsonObject(value)) {
    return failed("O runtime enviou uma solicitação que não é um objeto.", null);
  }
  const id = decodeRequestId(value.id);
  const method = readString(value, "method");
  if (id === null || method === undefined) {
    return failed(
      "O runtime enviou uma solicitação sem método ou identificador válido.",
      null,
    );
  }
  const params = isJsonObject(value.params) ? value.params : undefined;
  if (params === undefined) {
    return unsupported(id, method, undefined, "os parâmetros não são um objeto");
  }
  switch (method) {
    case "item/commandExecution/requestApproval":
      return fromDecoded(id, method, params, parseCommandApprovalRequest(id, params));
    case "item/fileChange/requestApproval":
      return fromDecoded(id, method, params, parseFileChangeApprovalRequest(id, params));
    case "item/tool/requestUserInput":
      return fromDecoded(id, method, params, parseUserInputRequest(id, params));
    case "mcpServer/elicitation/request":
      return fromDecoded(id, method, params, parseMcpElicitationRequest(id, params));
    case "item/permissions/requestApproval":
      return fromDecoded(id, method, params, parsePermissionsApprovalRequest(id, params));
    case "item/tool/call":
      return unsupported(
        id,
        method,
        params,
        "nenhuma ferramenta dinâmica foi registrada por este cliente",
      );
    case "account/chatgptAuthTokens/refresh":
      return unsupported(
        id,
        method,
        params,
        "a autenticação externa por tokens não foi anunciada por este cliente",
      );
    case "attestation/generate":
      return unsupported(
        id,
        method,
        params,
        "a geração de atestados não foi anunciada por este cliente",
      );
    case "currentTime/read":
      return unsupported(
        id,
        method,
        params,
        "o relógio externo experimental não foi anunciado por este cliente",
      );
    case "applyPatchApproval":
    case "execCommandApproval":
      return unsupported(
        id,
        method,
        params,
        "o app recebeu uma aprovação da API legada em um turno v2",
      );
    default:
      return unsupported(
        id,
        method,
        params,
        "o método não pertence ao catálogo atual do app-server",
      );
  }
}

function fromDecoded<T extends InteractiveServerRequest>(
  id: ServerRequestId,
  method: string,
  params: JsonObject,
  result: DecodeResult<T>,
): ServerRequestParseResult {
  return result.ok
    ? { ok: true, request: result.value }
    : unsupported(id, method, params, result.error);
}

function unsupported(
  id: ServerRequestId,
  method: string,
  params: JsonObject | undefined,
  reason: string,
): ServerRequestParseResult {
  const error = `A solicitação ${method} não pode ser exibida: ${reason}.`;
  return failed(error, {
    id,
    kind: "unsupported",
    method,
    error,
    threadId: readString(params, "threadId") ?? null,
    turnId: readString(params, "turnId") ?? null,
  });
}

function failed(
  error: string,
  request: UnsupportedServerRequest | null,
): ServerRequestParseResult {
  return { ok: false, error, request };
}

export function isInteractiveRequest(
  request: PendingServerRequest,
): request is InteractiveServerRequest {
  return request.kind !== "unsupported";
}
