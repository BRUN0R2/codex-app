import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../../shared/codex/types";
import type {
  AdditionalFileSystemPermissions,
  FileSystemAccessMode,
  FileSystemPath,
  FileSystemSandboxEntry,
  FileSystemSpecialPath,
  PermissionProfile,
} from "./permissionTypes";

export type PermissionProfileParseResult =
  | { ok: true; value: PermissionProfile }
  | { ok: false; error: string };

export function parsePermissionProfile(
  value: JsonValue | undefined,
): PermissionProfileParseResult {
  if (!isJsonObject(value)) {
    return invalid("o perfil de permissões não é um objeto");
  }
  const network = parseNetwork(value.network);
  if (typeof network === "string") {
    return invalid(network);
  }
  const fileSystem = parseFileSystem(value.fileSystem);
  if (typeof fileSystem === "string") {
    return invalid(fileSystem);
  }
  return { ok: true, value: { network, fileSystem } };
}

function parseNetwork(
  value: JsonValue | undefined,
): PermissionProfile["network"] | string {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isJsonObject(value) || !isNullableBoolean(value.enabled)) {
    return "a permissão de rede é inválida";
  }
  return { enabled: typeof value.enabled === "boolean" ? value.enabled : null };
}

function parseFileSystem(
  value: JsonValue | undefined,
): AdditionalFileSystemPermissions | null | string {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isJsonObject(value)) {
    return "a permissão de arquivos não é um objeto";
  }
  const read = parseNullableStringArray(value.read);
  const write = parseNullableStringArray(value.write);
  const entries = parseEntries(value.entries);
  const depth = value.globScanMaxDepth;
  if (typeof read === "string") {
    return "a lista de caminhos de leitura é inválida";
  }
  if (typeof write === "string") {
    return "a lista de caminhos de escrita é inválida";
  }
  if (typeof entries === "string") {
    return entries;
  }
  if (
    depth !== undefined &&
    (typeof depth !== "number" || !Number.isSafeInteger(depth) || depth <= 0)
  ) {
    return "a profundidade máxima de varredura é inválida";
  }
  return {
    read,
    write,
    entries,
    globScanMaxDepth: typeof depth === "number" ? depth : null,
  };
}

function parseEntries(
  value: JsonValue | undefined,
): FileSystemSandboxEntry[] | null | string {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    return "a lista de regras de arquivos é inválida";
  }
  const entries: FileSystemSandboxEntry[] = [];
  for (const candidate of value) {
    if (!isJsonObject(candidate)) {
      return "uma regra de arquivos não é um objeto";
    }
    const access = parseAccess(candidate.access);
    const path = parsePath(candidate.path);
    if (access === null || typeof path === "string") {
      return "uma regra de arquivos contém acesso ou caminho inválido";
    }
    entries.push({ access, path });
  }
  return entries;
}

function parsePath(value: JsonValue | undefined): FileSystemPath | string {
  if (!isJsonObject(value)) {
    return "caminho inválido";
  }
  switch (value.type) {
    case "path":
      return typeof value.path === "string"
        ? { type: "path", path: value.path }
        : "caminho absoluto inválido";
    case "glob_pattern":
      return typeof value.pattern === "string"
        ? { type: "glob_pattern", pattern: value.pattern }
        : "padrão glob inválido";
    case "special": {
      const special = parseSpecialPath(value.value);
      return typeof special === "string"
        ? special
        : { type: "special", value: special };
    }
    default:
      return "tipo de caminho desconhecido";
  }
}

function parseSpecialPath(
  value: JsonValue | undefined,
): FileSystemSpecialPath | string {
  if (!isJsonObject(value) || typeof value.kind !== "string") {
    return "caminho especial inválido";
  }
  switch (value.kind) {
    case "root":
    case "minimal":
    case "tmpdir":
    case "slash_tmp":
      return { kind: value.kind };
    case "project_roots":
      return isNullableString(value.subpath)
        ? {
            kind: "project_roots",
            subpath: typeof value.subpath === "string" ? value.subpath : null,
          }
        : "subcaminho de projeto inválido";
    case "unknown":
      return typeof value.path === "string" && isNullableString(value.subpath)
        ? {
            kind: "unknown",
            path: value.path,
            subpath: typeof value.subpath === "string" ? value.subpath : null,
          }
        : "caminho especial desconhecido inválido";
    default:
      return "tipo de caminho especial desconhecido";
  }
}

function parseAccess(value: JsonValue | undefined): FileSystemAccessMode | null {
  return value === "deny" || value === "read" || value === "write"
    ? value
    : null;
}

function parseNullableStringArray(
  value: JsonValue | undefined,
): string[] | null | string {
  if (value === undefined || value === null) {
    return null;
  }
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : "invalid";
}

function isNullableBoolean(value: JsonValue | undefined): boolean {
  return value === undefined || value === null || typeof value === "boolean";
}

function isNullableString(value: JsonValue | undefined): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function invalid(error: string): PermissionProfileParseResult {
  return { ok: false, error };
}
