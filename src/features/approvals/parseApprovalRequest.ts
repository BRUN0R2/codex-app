import type { JsonObject } from "../../shared/codex/types";
import { parseCommandApprovalFields } from "./parseCommandApprovalFields";
import { parsePermissionProfile } from "./parsePermissionProfile";
import {
  decodeItemFields,
  decoded,
  nullableString,
  optionalString,
  rejected,
  requiredNullableString,
  type DecodeResult,
} from "./requestParsing";
import type {
  CommandApprovalRequest,
  FileChangeApprovalRequest,
  PermissionsApprovalRequest,
  ServerRequestId,
} from "./serverRequestTypes";

export function parseCommandApprovalRequest(
  id: ServerRequestId,
  params: JsonObject,
): DecodeResult<CommandApprovalRequest> {
  const base = decodeItemFields(params);
  if (!base.ok) {
    return base;
  }
  const fields = parseCommandApprovalFields(params);
  if (!fields.ok) {
    return fields;
  }
  return decoded({
    ...base.value,
    ...fields.value,
    id,
    kind: "commandApproval",
    method: "item/commandExecution/requestApproval",
  });
}

export function parseFileChangeApprovalRequest(
  id: ServerRequestId,
  params: JsonObject,
): DecodeResult<FileChangeApprovalRequest> {
  const base = decodeItemFields(params);
  if (!base.ok) {
    return base;
  }
  if (!nullableString(params.reason) || !nullableString(params.grantRoot)) {
    return rejected("a aprovação de arquivos contém campos opcionais inválidos");
  }
  return decoded({
    ...base.value,
    id,
    kind: "fileChangeApproval",
    method: "item/fileChange/requestApproval",
    reason: optionalString(params, "reason"),
    grantRoot: optionalString(params, "grantRoot"),
  });
}

export function parsePermissionsApprovalRequest(
  id: ServerRequestId,
  params: JsonObject,
): DecodeResult<PermissionsApprovalRequest> {
  const base = decodeItemFields(params);
  if (!base.ok) {
    return base;
  }
  if (
    !requiredNullableString(params.environmentId) ||
    !requiredNullableString(params.reason) ||
    typeof params.cwd !== "string"
  ) {
    return rejected("a solicitação de permissões contém contexto inválido");
  }
  const permissions = parsePermissionProfile(params.permissions);
  if (!permissions.ok) {
    return rejected(permissions.error);
  }
  return decoded({
    ...base.value,
    id,
    kind: "permissionsApproval",
    method: "item/permissions/requestApproval",
    environmentId: optionalString(params, "environmentId"),
    cwd: params.cwd,
    reason: optionalString(params, "reason"),
    permissions: permissions.value,
  });
}
