const PROJECTS_STORAGE_KEY = "codex-app.projects.v1";

interface PersistedProjectStateV1 {
  version: 1;
  paths: string[];
  activePath: string | null;
}

export interface ProjectRecord {
  path: string;
  name: string;
}

export interface ProjectState {
  paths: string[];
  activePath: string | null;
}

export interface ProjectStateLoadResult {
  state: ProjectState;
  warning: string | null;
}

export function loadProjectState(): ProjectStateLoadResult {
  try {
    const serialized = localStorage.getItem(PROJECTS_STORAGE_KEY);
    if (serialized === null) {
      return { state: emptyProjectState(), warning: null };
    }
    const value: unknown = JSON.parse(serialized);
    if (!isPersistedProjectState(value)) {
      return {
        state: emptyProjectState(),
        warning: "As preferências de projetos estão inválidas e não foram carregadas.",
      };
    }
    return { state: normalizeProjectState(value), warning: null };
  } catch {
    return {
      state: emptyProjectState(),
      warning: "As preferências de projetos não puderam ser lidas.",
    };
  }
}

export function persistProjectState(state: ProjectState): void {
  const normalized = normalizeProjectState({ version: 1, ...state });
  const value: PersistedProjectStateV1 = { version: 1, ...normalized };
  localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(value));
}

export function addProject(state: ProjectState, path: string): ProjectState {
  const paths = state.paths.some((candidate) => pathsEqual(candidate, path))
    ? state.paths
    : [...state.paths, path];
  return { paths, activePath: path };
}

export function selectProject(state: ProjectState, path: string): ProjectState {
  const existing = state.paths.find((candidate) => pathsEqual(candidate, path));
  return addProject(state, existing ?? path);
}

export function removeProject(state: ProjectState, path: string): ProjectState {
  const paths = state.paths.filter((candidate) => !pathsEqual(candidate, path));
  const activePath = pathsEqual(state.activePath, path)
    ? (paths[0] ?? null)
    : state.activePath;
  return { paths, activePath };
}

export function projectRecords(state: ProjectState): ProjectRecord[] {
  return state.paths.map((path) => ({ path, name: projectName(path) }));
}

export function projectName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).at(-1) ?? path;
}

export function pathsEqual(left: string | null, right: string | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return projectKey(left) === projectKey(right);
}

function normalizeProjectState(value: PersistedProjectStateV1): ProjectState {
  const paths = value.paths.reduce<string[]>((unique, path) => {
    const trimmed = path.trim();
    if (
      trimmed.length > 0 &&
      !unique.some((candidate) => pathsEqual(candidate, trimmed))
    ) {
      unique.push(trimmed);
    }
    return unique;
  }, []);
  const requestedActivePath = value.activePath?.trim() || null;
  const activePath =
    paths.find((path) => pathsEqual(path, requestedActivePath)) ?? paths[0] ?? null;
  return { paths, activePath };
}

function isPersistedProjectState(value: unknown): value is PersistedProjectStateV1 {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PersistedProjectStateV1>;
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.paths) &&
    candidate.paths.every((path) => typeof path === "string") &&
    (candidate.activePath === null || typeof candidate.activePath === "string")
  );
}

function emptyProjectState(): ProjectState {
  return { paths: [], activePath: null };
}

function projectKey(path: string): string {
  return path.replaceAll("/", "\\").replace(/[\\]+$/, "").toLowerCase();
}
