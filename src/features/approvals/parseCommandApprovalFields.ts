import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../../shared/codex/types";
import { parsePermissionProfile } from "./parsePermissionProfile";
import {
  decoded,
  nullableString,
  optionalString,
  rejected,
  requiredNullableString,
  type DecodeResult,
} from "./requestParsing";
import type {
  CommandAction,
  CommandApprovalDecision,
  CommandApprovalRequest,
} from "./serverRequestTypes";

type CommandApprovalFields = Pick<
  CommandApprovalRequest,
  | "additionalPermissions"
  | "approvalId"
  | "availableDecisions"
  | "command"
  | "commandActions"
  | "cwd"
  | "environmentId"
  | "networkApprovalContext"
  | "proposedExecpolicyAmendment"
  | "proposedNetworkPolicyAmendments"
  | "reason"
>;

export function parseCommandApprovalFields(
  params: JsonObject,
): DecodeResult<CommandApprovalFields> {
  if (
    !requiredNullableString(params.environmentId) ||
    !nullableString(params.approvalId) ||
    !nullableString(params.reason) ||
    !nullableString(params.command) ||
    !nullableString(params.cwd)
  ) {
    return rejected("a aprovação de comando contém texto ou ambiente inválido");
  }
  const actions = parseCommandActions(params.commandActions);
  if (!actions.ok) {
    return actions;
  }
  const networkContext = parseNetworkContext(params.networkApprovalContext);
  if (!networkContext.ok) {
    return networkContext;
  }
  const additionalPermissions = parseOptionalPermissions(params.additionalPermissions);
  if (!additionalPermissions.ok) {
    return additionalPermissions;
  }
  const availableDecisions = parseAvailableDecisions(params.availableDecisions);
  if (!availableDecisions.ok) {
    return availableDecisions;
  }
  const execpolicy = parseOptionalStringArray(params.proposedExecpolicyAmendment);
  if (!execpolicy.ok) {
    return execpolicy;
  }
  const networkAmendments = parseNetworkAmendments(
    params.proposedNetworkPolicyAmendments,
  );
  if (!networkAmendments.ok) {
    return networkAmendments;
  }
  if (params.command == null && networkContext.value === null) {
    return rejected("a aprovação não contém comando nem contexto de rede");
  }
  return decoded({
    approvalId: optionalString(params, "approvalId"),
    environmentId: optionalString(params, "environmentId"),
    reason: optionalString(params, "reason"),
    command: optionalString(params, "command"),
    cwd: optionalString(params, "cwd"),
    commandActions: actions.value,
    networkApprovalContext: networkContext.value,
    additionalPermissions: additionalPermissions.value,
    availableDecisions: availableDecisions.value,
    proposedExecpolicyAmendment: execpolicy.value,
    proposedNetworkPolicyAmendments: networkAmendments.value,
  });
}

function parseCommandActions(
  value: JsonValue | undefined,
): DecodeResult<CommandAction[]> {
  if (value === undefined || value === null) {
    return decoded([]);
  }
  if (!Array.isArray(value)) {
    return rejected("as ações derivadas do comando são inválidas");
  }
  const actions: CommandAction[] = [];
  for (const candidate of value) {
    const action = parseCommandAction(candidate);
    if (!action.ok) {
      return action;
    }
    actions.push(action.value);
  }
  return decoded(actions);
}

function parseCommandAction(value: JsonValue): DecodeResult<CommandAction> {
  if (!isJsonObject(value) || typeof value.command !== "string") {
    return rejected("uma ação derivada do comando é inválida");
  }
  switch (value.type) {
    case "read":
      return typeof value.name === "string" && typeof value.path === "string"
        ? decoded({
            type: "read",
            command: value.command,
            name: value.name,
            path: value.path,
            query: null,
          })
        : rejected("uma ação de leitura é inválida");
    case "listFiles":
      return requiredNullableString(value.path)
        ? decoded({
            type: "listFiles",
            command: value.command,
            name: null,
            path: typeof value.path === "string" ? value.path : null,
            query: null,
          })
        : rejected("uma ação de listagem é inválida");
    case "search":
      return requiredNullableString(value.query) && requiredNullableString(value.path)
        ? decoded({
            type: "search",
            command: value.command,
            name: null,
            path: typeof value.path === "string" ? value.path : null,
            query: typeof value.query === "string" ? value.query : null,
          })
        : rejected("uma ação de busca é inválida");
    case "unknown":
      return decoded({
        type: "unknown",
        command: value.command,
        name: null,
        path: null,
        query: null,
      });
    default:
      return rejected("o app-server retornou um tipo de ação de comando desconhecido");
  }
}

function parseNetworkContext(
  value: JsonValue | undefined,
): DecodeResult<CommandApprovalRequest["networkApprovalContext"]> {
  if (value === undefined || value === null) {
    return decoded(null);
  }
  if (
    !isJsonObject(value) ||
    typeof value.host !== "string" ||
    !isNetworkProtocol(value.protocol)
  ) {
    return rejected("o contexto de aprovação de rede é inválido");
  }
  return decoded({ host: value.host, protocol: value.protocol });
}

function parseOptionalPermissions(
  value: JsonValue | undefined,
): DecodeResult<CommandApprovalRequest["additionalPermissions"]> {
  if (value === undefined || value === null) {
    return decoded(null);
  }
  const parsed = parsePermissionProfile(value);
  return parsed.ok ? decoded(parsed.value) : rejected(parsed.error);
}

function parseAvailableDecisions(
  value: JsonValue | undefined,
): DecodeResult<CommandApprovalDecision[] | null> {
  if (value === undefined || value === null) {
    return decoded(null);
  }
  if (!Array.isArray(value) || value.length === 0) {
    return rejected("a lista de decisões disponíveis é inválida");
  }
  const decisions: CommandApprovalDecision[] = [];
  for (const candidate of value) {
    const decision = parseDecision(candidate);
    if (decision === null) {
      return rejected("uma decisão de aprovação é desconhecida");
    }
    decisions.push(decision);
  }
  return decoded(decisions);
}

function parseDecision(value: JsonValue): CommandApprovalDecision | null {
  if (
    value === "accept" ||
    value === "acceptForSession" ||
    value === "decline" ||
    value === "cancel"
  ) {
    return value;
  }
  if (!isJsonObject(value)) {
    return null;
  }
  const exec = value.acceptWithExecpolicyAmendment;
  if (isJsonObject(exec)) {
    const amendment = parseStringArray(exec.execpolicy_amendment);
    return amendment === null
      ? null
      : { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } };
  }
  const network = value.applyNetworkPolicyAmendment;
  if (isJsonObject(network)) {
    const amendment = parseNetworkAmendment(network.network_policy_amendment);
    return amendment === null
      ? null
      : { applyNetworkPolicyAmendment: { network_policy_amendment: amendment } };
  }
  return null;
}

function parseOptionalStringArray(
  value: JsonValue | undefined,
): DecodeResult<string[] | null> {
  if (value === undefined || value === null) {
    return decoded(null);
  }
  const parsed = parseStringArray(value);
  return parsed === null
    ? rejected("a alteração proposta da política de execução é inválida")
    : decoded(parsed);
}

function parseStringArray(value: JsonValue | undefined): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

function parseNetworkAmendments(
  value: JsonValue | undefined,
): DecodeResult<Array<{ action: "allow" | "deny"; host: string }>> {
  if (value === undefined || value === null) {
    return decoded([]);
  }
  if (!Array.isArray(value)) {
    return rejected("as alterações propostas da política de rede são inválidas");
  }
  const amendments = value.map(parseNetworkAmendment);
  return amendments.some((entry) => entry === null)
    ? rejected("uma alteração proposta da política de rede é inválida")
    : decoded(amendments as Array<{ action: "allow" | "deny"; host: string }>);
}

function parseNetworkAmendment(
  value: JsonValue | undefined,
): { action: "allow" | "deny"; host: string } | null {
  return isJsonObject(value) &&
    typeof value.host === "string" &&
    (value.action === "allow" || value.action === "deny")
    ? { host: value.host, action: value.action }
    : null;
}

function isNetworkProtocol(
  value: JsonValue | undefined,
): value is "http" | "https" | "socks5Tcp" | "socks5Udp" {
  return (
    value === "http" ||
    value === "https" ||
    value === "socks5Tcp" ||
    value === "socks5Udp"
  );
}
