import type {
  FileSystemPath,
  FileSystemSandboxEntry,
  FileSystemSpecialPath,
  GrantedPermissionProfile,
  PermissionGrantOption,
  PermissionProfile,
} from "./permissionTypes";

export function permissionGrantOptions(
  profile: PermissionProfile,
): PermissionGrantOption[] {
  const options: PermissionGrantOption[] = [];
  if (profile.network !== null && profile.network.enabled !== null) {
    options.push({
      id: "network",
      kind: "network",
      label: profile.network.enabled ? "Acesso à internet" : "Rede desativada",
      detail: profile.network.enabled
        ? "Permite conexões de rede solicitadas pela tarefa."
        : "Aplica a restrição de rede solicitada pela tarefa.",
    });
  }
  const fileSystem = profile.fileSystem;
  if (fileSystem === null) {
    return options;
  }
  if (fileSystem.entries !== null) {
    for (const [index, entry] of fileSystem.entries.entries()) {
      options.push({
        id: `entry:${index}`,
        index,
        kind: "entry",
        label: accessLabel(entry),
        detail: describePath(entry.path),
      });
    }
    return options;
  }
  for (const [index, path] of (fileSystem.read ?? []).entries()) {
    options.push({
      id: `read:${index}`,
      index,
      kind: "read",
      label: "Ler caminho",
      detail: path,
    });
  }
  for (const [index, path] of (fileSystem.write ?? []).entries()) {
    options.push({
      id: `write:${index}`,
      index,
      kind: "write",
      label: "Alterar caminho",
      detail: path,
    });
  }
  return options;
}

export function buildGrantedPermissions(
  profile: PermissionProfile,
  selected: ReadonlySet<string>,
): GrantedPermissionProfile {
  const granted: GrantedPermissionProfile = {};
  if (selected.has("network") && profile.network !== null) {
    granted.network = profile.network;
  }
  const source = profile.fileSystem;
  if (source === null) {
    return granted;
  }
  if (source.entries !== null) {
    const entries = selectedIndexes(selected, "entry")
      .map((index) => source.entries?.[index])
      .filter((entry): entry is FileSystemSandboxEntry => entry !== undefined);
    if (entries.length === 0) {
      return granted;
    }
    granted.fileSystem = {
      read: null,
      write: null,
      entries,
      ...(source.globScanMaxDepth === null
        ? {}
        : { globScanMaxDepth: source.globScanMaxDepth }),
    };
    return granted;
  }
  const read = selectedIndexes(selected, "read").map(
    (index) => source.read?.[index],
  ).filter((path): path is string => path !== undefined);
  const write = selectedIndexes(selected, "write").map(
    (index) => source.write?.[index],
  ).filter((path): path is string => path !== undefined);
  if (read.length === 0 && write.length === 0) {
    return granted;
  }
  granted.fileSystem = {
    read: source.read === null ? null : read,
    write: source.write === null ? null : write,
  };
  if (source.globScanMaxDepth !== null) {
    granted.fileSystem.globScanMaxDepth = source.globScanMaxDepth;
  }
  return granted;
}

export function describePath(path: FileSystemPath): string {
  switch (path.type) {
    case "path":
      return path.path;
    case "glob_pattern":
      return path.pattern;
    case "special":
      return describeSpecialPath(path.value);
  }
}

function selectedIndexes(
  selected: ReadonlySet<string>,
  prefix: "entry" | "read" | "write",
): number[] {
  const indexes: number[] = [];
  for (const id of selected) {
    if (!id.startsWith(`${prefix}:`)) {
      continue;
    }
    const index = Number(id.slice(prefix.length + 1));
    if (Number.isSafeInteger(index) && index >= 0) {
      indexes.push(index);
    }
  }
  return indexes.sort((left, right) => left - right);
}

function accessLabel(entry: FileSystemSandboxEntry): string {
  switch (entry.access) {
    case "read":
      return "Ler arquivos";
    case "write":
      return "Alterar arquivos";
    case "deny":
      return "Bloquear caminho";
  }
}

function describeSpecialPath(path: FileSystemSpecialPath): string {
  switch (path.kind) {
    case "root":
      return "Raiz do sistema";
    case "minimal":
      return "Conjunto mínimo do sistema";
    case "project_roots":
      return path.subpath === null
        ? "Raízes do projeto"
        : `Raízes do projeto · ${path.subpath}`;
    case "tmpdir":
      return "Diretório temporário do sistema";
    case "slash_tmp":
      return "/tmp";
    case "unknown":
      return path.subpath === null ? path.path : `${path.path} · ${path.subpath}`;
  }
}
