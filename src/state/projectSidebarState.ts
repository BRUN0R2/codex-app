import { PROFILE_STORAGE_KEYS } from "./profileStorage";
import { normalizeProjectPath, pathsEqual } from "./projects";

const STORAGE_KEY = PROFILE_STORAGE_KEYS.projectSidebar;
const MAX_PROJECT_STATE_ENTRIES = 32;
const MAX_STORED_VALUE_CHARACTERS = 1_048_576;

export interface ProjectSidebarState {
  readonly version: 1;
  readonly projectsExpanded: boolean;
  readonly collapsedProjectPaths: readonly string[];
  readonly expandedProjectThreadListPaths: readonly string[];
}

interface StoredProjectSidebarState {
  readonly version: 1;
  readonly projectsExpanded: boolean;
  readonly collapsedProjectPaths: readonly string[];
  readonly expandedProjectThreadListPaths: readonly string[];
}

export function defaultProjectSidebarState(): ProjectSidebarState {
  return {
    version: 1,
    projectsExpanded: true,
    collapsedProjectPaths: [],
    expandedProjectThreadListPaths: [],
  };
}

export function loadProjectSidebarState(): ProjectSidebarState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    return defaultProjectSidebarState();
  }
  if (raw.length > MAX_STORED_VALUE_CHARACTERS) {
    throw new Error("The project sidebar state exceeds the allowed limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (reason) {
    throw new Error(`The project sidebar state contains invalid JSON: ${describe(reason)}`);
  }
  return decodeProjectSidebarState(value);
}

export function saveProjectSidebarState(state: ProjectSidebarState): void {
  const validated = decodeProjectSidebarState(state);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(validated));
}

export function projectExpanded(state: ProjectSidebarState, path: string): boolean {
  return !state.collapsedProjectPaths.some((entry) => pathsEqual(entry, path));
}

export function projectThreadListExpanded(state: ProjectSidebarState, path: string): boolean {
  return state.expandedProjectThreadListPaths.some((entry) => pathsEqual(entry, path));
}

export function toggleProjectSectionExpanded(state: ProjectSidebarState): ProjectSidebarState {
  return {
    ...state,
    projectsExpanded: !state.projectsExpanded,
  };
}

export function toggleProjectExpanded(
  state: ProjectSidebarState,
  path: string,
): ProjectSidebarState {
  return setProjectExpanded(state, path, !projectExpanded(state, path));
}

export function toggleProjectThreadListExpanded(
  state: ProjectSidebarState,
  path: string,
): ProjectSidebarState {
  return setProjectThreadListExpanded(state, path, !projectThreadListExpanded(state, path));
}

export function removeProjectSidebarState(
  state: ProjectSidebarState,
  path: string,
): ProjectSidebarState {
  const collapsedProjectPaths = withoutPath(state.collapsedProjectPaths, path);
  const expandedProjectThreadListPaths = withoutPath(state.expandedProjectThreadListPaths, path);
  if (
    collapsedProjectPaths === state.collapsedProjectPaths &&
    expandedProjectThreadListPaths === state.expandedProjectThreadListPaths
  ) {
    return state;
  }
  return {
    ...state,
    collapsedProjectPaths,
    expandedProjectThreadListPaths,
  };
}

function setProjectExpanded(
  state: ProjectSidebarState,
  path: string,
  expanded: boolean,
): ProjectSidebarState {
  const collapsedProjectPaths = expanded
    ? withoutPath(state.collapsedProjectPaths, path)
    : withPath(state.collapsedProjectPaths, path);
  if (collapsedProjectPaths === state.collapsedProjectPaths) {
    return state;
  }
  return { ...state, collapsedProjectPaths };
}

function setProjectThreadListExpanded(
  state: ProjectSidebarState,
  path: string,
  expanded: boolean,
): ProjectSidebarState {
  const expandedProjectThreadListPaths = expanded
    ? withPath(state.expandedProjectThreadListPaths, path)
    : withoutPath(state.expandedProjectThreadListPaths, path);
  if (expandedProjectThreadListPaths === state.expandedProjectThreadListPaths) {
    return state;
  }
  return { ...state, expandedProjectThreadListPaths };
}

function withPath(paths: readonly string[], path: string): readonly string[] {
  const normalized = normalizeProjectPath(path);
  if (paths.some((entry) => pathsEqual(entry, normalized))) {
    return paths;
  }
  if (paths.length >= MAX_PROJECT_STATE_ENTRIES) {
    throw new Error(
      `The application accepts at most ${MAX_PROJECT_STATE_ENTRIES} saved project states.`,
    );
  }
  return [...paths, normalized];
}

function withoutPath(paths: readonly string[], path: string): readonly string[] {
  const next = paths.filter((entry) => !pathsEqual(entry, path));
  return next.length === paths.length ? paths : next;
}

function decodeProjectSidebarState(value: unknown): StoredProjectSidebarState {
  const object = exactObject(value);
  if (object.version !== 1) {
    throw new Error("The project sidebar state version is not supported.");
  }
  if (typeof object.projectsExpanded !== "boolean") {
    throw new Error("The project section state is invalid.");
  }
  return {
    version: 1,
    projectsExpanded: object.projectsExpanded,
    collapsedProjectPaths: decodePaths(object.collapsedProjectPaths, "collapsed projects"),
    expandedProjectThreadListPaths: decodePaths(
      object.expandedProjectThreadListPaths,
      "expanded chat lists",
    ),
  };
}

function exactObject(
  value: unknown,
): Record<
  "collapsedProjectPaths" | "expandedProjectThreadListPaths" | "projectsExpanded" | "version",
  unknown
> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The project sidebar state is not an object.");
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  const expected = [
    "collapsedProjectPaths",
    "expandedProjectThreadListPaths",
    "projectsExpanded",
    "version",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("The project sidebar state has incompatible fields.");
  }
  return object as Record<
    "collapsedProjectPaths" | "expandedProjectThreadListPaths" | "projectsExpanded" | "version",
    unknown
  >;
}

function decodePaths(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`The ${label} list is invalid.`);
  }
  if (value.length > MAX_PROJECT_STATE_ENTRIES) {
    throw new Error(`The ${label} list exceeds ${MAX_PROJECT_STATE_ENTRIES} projects.`);
  }
  const paths: string[] = [];
  for (const [index, entry] of value.entries()) {
    const path = normalizeProjectPath(entry);
    if (paths.some((current) => pathsEqual(current, path))) {
      throw new Error(`Project ${index + 1} in ${label} is duplicated.`);
    }
    paths.push(path);
  }
  return paths;
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : "unknown error";
}
