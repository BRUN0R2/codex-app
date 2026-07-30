import type { JsonObject } from "../../shared/codex/types";

export interface AdditionalNetworkPermissions extends JsonObject {
  enabled: boolean | null;
}

export type FileSystemAccessMode = "deny" | "read" | "write";

export type FileSystemSpecialPath =
  | { kind: "minimal" }
  | { kind: "project_roots"; subpath: string | null }
  | { kind: "root" }
  | { kind: "slash_tmp" }
  | { kind: "tmpdir" }
  | { kind: "unknown"; path: string; subpath: string | null };

export type FileSystemPath =
  | { type: "glob_pattern"; pattern: string }
  | { type: "path"; path: string }
  | { type: "special"; value: FileSystemSpecialPath };

export interface FileSystemSandboxEntry extends JsonObject {
  access: FileSystemAccessMode;
  path: FileSystemPath;
}

export interface AdditionalFileSystemPermissions extends JsonObject {
  read: string[] | null;
  write: string[] | null;
  entries: FileSystemSandboxEntry[] | null;
  globScanMaxDepth: number | null;
}

export interface PermissionProfile extends JsonObject {
  fileSystem: AdditionalFileSystemPermissions | null;
  network: AdditionalNetworkPermissions | null;
}

export interface GrantedPermissionProfile extends JsonObject {
  fileSystem?: {
    read: string[] | null;
    write: string[] | null;
    entries?: FileSystemSandboxEntry[];
    globScanMaxDepth?: number;
  };
  network?: AdditionalNetworkPermissions;
}

export type PermissionGrantScope = "session" | "turn";

export type PermissionGrantOption =
  | { id: "network"; kind: "network"; label: string; detail: string }
  | {
      id: `entry:${number}`;
      index: number;
      kind: "entry";
      label: string;
      detail: string;
    }
  | {
      id: `read:${number}`;
      index: number;
      kind: "read";
      label: string;
      detail: string;
    }
  | {
      id: `write:${number}`;
      index: number;
      kind: "write";
      label: string;
      detail: string;
    };
