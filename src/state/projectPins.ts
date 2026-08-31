import type { ProjectRecord } from "../contracts/types";
import { PROFILE_STORAGE_KEYS } from "./profileStorage";
import { normalizeProjectPath, pathsEqual } from "./projects";

const STORAGE_KEY = PROFILE_STORAGE_KEYS.pinnedProjects;
const MAX_PINNED_PROJECTS = 32;

interface StoredProjectPins {
  readonly version: 1;
  readonly projectPaths: readonly string[];
}

export interface ProjectPinPartition {
  readonly pinnedProjects: readonly ProjectRecord[];
  readonly unpinnedProjects: readonly ProjectRecord[];
}

export function loadPinnedProjectPaths(): readonly string[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (reason) {
    throw new Error(
      `The pinned-project list contains invalid JSON: ${reason instanceof Error ? reason.message : "unknown error"}`,
    );
  }
  return decodeProjectPins(value).projectPaths;
}

export function savePinnedProjectPaths(projectPaths: readonly string[]): void {
  const validated = decodeProjectPins({ version: 1, projectPaths });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(validated));
}

export function togglePinnedProjectPath(
  projectPaths: readonly string[],
  path: string,
): readonly string[] {
  const normalized = normalizeProjectPath(path);
  if (projectPaths.some((entry) => pathsEqual(entry, normalized))) {
    return projectPaths.filter((entry) => !pathsEqual(entry, normalized));
  }
  if (projectPaths.length >= MAX_PINNED_PROJECTS) {
    throw new Error(`The application accepts at most ${MAX_PINNED_PROJECTS} pinned projects.`);
  }
  return [normalized, ...projectPaths];
}

export function removePinnedProjectPath(
  projectPaths: readonly string[],
  path: string,
): readonly string[] {
  return projectPaths.filter((entry) => !pathsEqual(entry, path));
}

export function partitionProjectsByPinnedPaths(
  projects: readonly ProjectRecord[],
  pinnedProjectPaths: readonly string[],
): ProjectPinPartition {
  const pinnedProjects: ProjectRecord[] = [];
  const unpinnedProjects: ProjectRecord[] = [];
  for (const project of projects) {
    const destination = pinnedProjectPaths.some((path) => pathsEqual(path, project.path))
      ? pinnedProjects
      : unpinnedProjects;
    destination.push(project);
  }
  return { pinnedProjects, unpinnedProjects };
}

function decodeProjectPins(value: unknown): StoredProjectPins {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The pinned-project list is not an object.");
  }
  const object = value as Record<"projectPaths" | "version", unknown>;
  const keys = Object.keys(object).sort();
  if (keys.length !== 2 || keys[0] !== "projectPaths" || keys[1] !== "version") {
    throw new Error("The pinned-project list has incompatible fields.");
  }
  if (object.version !== 1 || !Array.isArray(object.projectPaths)) {
    throw new Error("The pinned-project list version is unsupported.");
  }
  if (object.projectPaths.length > MAX_PINNED_PROJECTS) {
    throw new Error(`A lista excede ${MAX_PINNED_PROJECTS} projetos fixados.`);
  }
  const seen: string[] = [];
  const projectPaths = object.projectPaths.map((entry, index) => {
    const path = normalizeProjectPath(entry);
    if (seen.some((existing) => pathsEqual(existing, path))) {
      throw new Error(`Pinned project ${index + 1} is duplicated.`);
    }
    seen.push(path);
    return path;
  });
  return { version: 1, projectPaths };
}
