import { createMemo, createSignal, type Accessor } from "solid-js";

import {
  addProject,
  loadProjectState,
  persistProjectState,
  projectRecords,
  removeProject,
  selectProject,
  type ProjectRecord,
  type ProjectState,
} from "./projectStore";

export interface ProjectWorkspace {
  loadWarning: string | null;
  path: Accessor<string | null>;
  projects: Accessor<ProjectRecord[]>;
  add: (path: string) => void;
  remove: (path: string) => void;
  select: (path: string) => void;
}

export function createProjectWorkspace(): ProjectWorkspace {
  const loaded = loadProjectState();
  const [state, setState] = createSignal(loaded.state);
  const path = createMemo(() => state().activePath);
  const projects = createMemo(() => projectRecords(state()));

  function commit(nextState: ProjectState) {
    persistProjectState(nextState);
    setState(nextState);
  }

  return {
    loadWarning: loaded.warning,
    path,
    projects,
    add: (projectPath) => commit(addProject(state(), projectPath)),
    remove: (projectPath) => commit(removeProject(state(), projectPath)),
    select: (projectPath) => commit(selectProject(state(), projectPath)),
  };
}
