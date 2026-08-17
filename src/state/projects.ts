import type { ProjectRecord } from "../contracts/types";
import type { IconName } from "../ui/Icon";
import { PROFILE_STORAGE_KEYS } from "./profileStorage";

const STORAGE_KEY = PROFILE_STORAGE_KEYS.projects;
const MAX_PROJECTS = 32;
const MAX_PATH_CHARACTERS = 4_096;
const MAX_NAME_CHARACTERS = 256;

interface StoredProjects {
  readonly version: 1;
  readonly projects: readonly ProjectRecord[];
}

export function loadProjects(): readonly ProjectRecord[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (reason) {
    throw new Error(`A lista local de projetos contém JSON inválido: ${describe(reason)}`);
  }
  return decodeStoredProjects(value).projects;
}

export function saveProjects(projects: readonly ProjectRecord[]): void {
  const validated = decodeStoredProjects({ version: 1, projects });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(validated));
}

export function addProject(
  projects: readonly ProjectRecord[],
  path: string,
): readonly ProjectRecord[] {
  const normalized = normalizeProjectPath(path);
  const existing = projects.find((project) => pathsEqual(project.path, normalized));
  if (existing !== undefined) {
    return projects;
  }
  if (projects.length >= MAX_PROJECTS) {
    throw new Error(`O aplicativo aceita no máximo ${MAX_PROJECTS} projetos fixados.`);
  }
  return [{ name: projectName(normalized), path: normalized }, ...projects];
}

export function removeProject(
  projects: readonly ProjectRecord[],
  path: string,
): readonly ProjectRecord[] {
  return projects.filter((project) => !pathsEqual(project.path, path));
}

export function pathsEqual(left: string | null, right: string | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return normalizeForComparison(left) === normalizeForComparison(right);
}

export function updateProject(
  projects: readonly ProjectRecord[],
  path: string,
  updates: Partial<Pick<ProjectRecord, "color" | "icon" | "name">>,
): readonly ProjectRecord[] {
  const normalized = normalizeProjectPath(path);
  return projects.map((project) => {
    if (pathsEqual(project.path, normalized)) {
      return {
        ...project,
        ...(updates.name !== undefined ? { name: updates.name } : {}),
        ...(updates.icon !== undefined ? { icon: updates.icon } : {}),
        ...(updates.color !== undefined ? { color: updates.color } : {}),
      };
    }
    return project;
  });
}

export function normalizeProjectPath(path: string): string {
  return validatePath(path);
}

function decodeStoredProjects(value: unknown): StoredProjects {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A lista local de projetos não é um objeto.");
  }
  const object = value as Record<"projects" | "version", unknown>;
  const keys = Object.keys(object).sort();
  if (keys.length !== 2 || keys[0] !== "projects" || keys[1] !== "version") {
    throw new Error("A lista local de projetos possui campos incompatíveis.");
  }
  if (object.version !== 1 || !Array.isArray(object.projects)) {
    throw new Error("A versão da lista local de projetos não é suportada.");
  }
  if (object.projects.length > MAX_PROJECTS) {
    throw new Error(`A lista local excede ${MAX_PROJECTS} projetos.`);
  }
  const seen = new Set<string>();
  const projects = object.projects.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`O projeto ${index + 1} é inválido.`);
    }
    const project = entry as Record<"color" | "icon" | "name" | "path", unknown>;
    const path = validatePath(project.path);
    const name = project.name;
    if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_CHARACTERS) {
      throw new Error(`O nome do projeto ${index + 1} é inválido.`);
    }
    const icon = typeof project.icon === "string" ? (project.icon as IconName) : undefined;
    const color = typeof project.color === "string" ? project.color : undefined;
    const comparison = normalizeForComparison(path);
    if (seen.has(comparison)) {
      throw new Error(`O projeto ${index + 1} está duplicado.`);
    }
    seen.add(comparison);
    return { name, path, ...(icon ? { icon } : {}), ...(color ? { color } : {}) };
  });
  return { version: 1, projects };
}

function validatePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_CHARACTERS ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error("O caminho do projeto é inválido.");
  }
  const normalized = value.replaceAll("/", "\\");
  const driveRoot = /^[A-Za-z]:\\$/u.test(normalized);
  const driveAbsolute = /^[A-Za-z]:\\.+/u.test(normalized);
  const uncAbsolute = /^\\\\[^\\]+\\[^\\]+(?:\\.*)?$/u.test(normalized);
  if (!driveRoot && !driveAbsolute && !uncAbsolute) {
    throw new Error("O caminho do projeto deve ser absoluto no Windows.");
  }
  return driveRoot ? normalized : normalized.replace(/\\+$/u, "");
}

function normalizeForComparison(path: string): string {
  return path
    .replaceAll("/", "\\")
    .replace(/[\\]+$/u, "")
    .toLocaleLowerCase("en-US");
}

export function projectName(path: string): string {
  const parts = path.split(/[\\/]/u).filter((part) => part.length > 0);
  return parts.at(-1) ?? path;
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : "erro desconhecido";
}
