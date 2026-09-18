import { type Accessor, batch, createMemo, createSignal } from "solid-js";

import type { AppProduct, ChatGptMode, ConversationMode, ProjectRecord } from "../contracts/types";
import { captureInitialization, type SessionControllerHost } from "./controllerSupport";
import {
  loadPinnedThreadIds,
  removePinnedThreadId,
  savePinnedThreadIds,
  togglePinnedThreadId,
} from "./pins";
import {
  activeConversationMode,
  defaultProductFlowState,
  loadProductFlowState,
  type ProductFlowState,
  rememberConversationDestination,
  saveProductFlowState,
} from "./productFlow";
import {
  loadPinnedProjectPaths,
  removePinnedProjectPath,
  savePinnedProjectPaths,
  togglePinnedProjectPath,
} from "./projectPins";
import {
  defaultProjectSidebarState,
  loadProjectSidebarState,
  type ProjectSidebarState,
  projectExpanded as readProjectExpanded,
  projectThreadListExpanded as readProjectThreadListExpanded,
  removeProjectSidebarState,
  saveProjectSidebarState,
  toggleProjectSectionExpanded,
  toggleProjectExpanded as toggleStoredProjectExpanded,
  toggleProjectThreadListExpanded as toggleStoredProjectThreadListExpanded,
} from "./projectSidebarState";
import {
  addProject,
  loadProjects,
  pathsEqual,
  removeProject as removeProjectRecord,
  saveProjects,
  updateProject as updateProjectRecord,
} from "./projects";
import { uiError } from "./uiError";

export interface NavigationSessionController {
  readonly chatGptMode: Accessor<ChatGptMode>;
  readonly conversationMode: Accessor<ConversationMode>;
  readonly initializationFailures: readonly Error[];
  readonly pinnedProjectPaths: Accessor<readonly string[]>;
  readonly pinnedThreadIds: Accessor<readonly string[]>;
  readonly product: Accessor<AppProduct>;
  readonly productFlow: Accessor<ProductFlowState>;
  readonly projectSectionExpanded: Accessor<boolean>;
  readonly projects: Accessor<readonly ProjectRecord[]>;
  readonly workspace: Accessor<string | null>;
  readonly addProjectPath: (path: string) => boolean;
  readonly commitProductFlow: (next: ProductFlowState) => boolean;
  readonly hasProject: (path: string) => boolean;
  readonly projectExpanded: (path: string) => boolean;
  readonly projectThreadListExpanded: (path: string) => boolean;
  readonly rememberDestination: (
    mode: ConversationMode,
    threadId: string | null,
    targetWorkspace: string | null,
  ) => boolean;
  readonly removePinnedProject: (path: string) => void;
  readonly removePinnedThread: (threadId: string) => void;
  readonly removeProject: (path: string) => void;
  readonly selectProjectPath: (path: string | null) => boolean;
  readonly setWorkspace: (path: string | null) => void;
  readonly togglePinnedProject: (path: string) => void;
  readonly togglePinnedThread: (threadId: string) => void;
  readonly toggleProjectExpanded: (path: string) => void;
  readonly toggleProjectSection: () => void;
  readonly toggleProjectThreadListExpanded: (path: string) => void;
  readonly updateProject: (
    path: string,
    updates: Partial<Pick<ProjectRecord, "color" | "icon" | "name">>,
  ) => void;
}

export interface NavigationSessionDependencies {
  readonly host: SessionControllerHost;
}

export function createNavigationSessionController(
  dependencies: NavigationSessionDependencies,
): NavigationSessionController {
  const { reportError, setError } = dependencies.host;
  const capturedProductFlow = captureInitialization(() => loadProductFlowState());
  const initialProductFlow =
    capturedProductFlow.failure === undefined
      ? capturedProductFlow.value
      : defaultProductFlowState();
  const capturedProjects = captureInitialization(loadProjects);
  const initialProjects = capturedProjects.failure === undefined ? capturedProjects.value : [];
  const capturedProjectSidebarState = captureInitialization(loadProjectSidebarState);
  const initialProjectSidebarState =
    capturedProjectSidebarState.failure === undefined
      ? capturedProjectSidebarState.value
      : defaultProjectSidebarState();
  const capturedPinnedThreadIds = captureInitialization(loadPinnedThreadIds);
  const initialPinnedThreadIds =
    capturedPinnedThreadIds.failure === undefined ? capturedPinnedThreadIds.value : [];
  const capturedProjectPins = captureInitialization(loadPinnedProjectPaths);
  const initialPinnedProjectPaths =
    capturedProjectPins.failure === undefined ? capturedProjectPins.value : [];

  const [productFlow, setProductFlow] = createSignal<ProductFlowState>(initialProductFlow);
  const [projects, setProjects] = createSignal(initialProjects);
  const [projectSidebarState, setProjectSidebarState] = createSignal<ProjectSidebarState>(
    initialProjectSidebarState,
  );
  const [pinnedThreadIds, setPinnedThreadIds] = createSignal(initialPinnedThreadIds);
  const [pinnedProjectPaths, setPinnedProjectPaths] = createSignal(initialPinnedProjectPaths);
  const [workspace, setWorkspace] = createSignal<string | null>(
    initialProductFlow.destinations[activeConversationMode(initialProductFlow)].workspace,
  );

  const product = createMemo(() => productFlow().product);
  const chatGptMode = createMemo(() => productFlow().chatGptMode);
  const conversationMode = createMemo(() => activeConversationMode(productFlow()));
  const projectSectionExpanded = createMemo(() => projectSidebarState().projectsExpanded);

  const initializationFailures = [
    capturedProductFlow.failure,
    capturedProjects.failure,
    capturedProjectSidebarState.failure,
    capturedPinnedThreadIds.failure,
    capturedProjectPins.failure,
  ].filter((failure): failure is Error => failure !== undefined);

  function commitProductFlow(next: ProductFlowState): boolean {
    if (next === productFlow()) {
      return true;
    }
    try {
      saveProductFlowState(next);
      setProductFlow(next);
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  function rememberDestination(
    mode: ConversationMode,
    threadId: string | null,
    targetWorkspace: string | null,
  ): boolean {
    return commitProductFlow(
      rememberConversationDestination(productFlow(), mode, {
        threadId,
        workspace: targetWorkspace,
      }),
    );
  }

  function addProjectPath(path: string): boolean {
    try {
      const next = addProject(projects(), path);
      saveProjects(next);
      batch(() => {
        setProjects(next);
        setWorkspace(path);
      });
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  function selectProjectPath(path: string | null): boolean {
    if (path === null) {
      setWorkspace(null);
      return true;
    }
    return addProjectPath(path);
  }

  function removeProject(path: string): void {
    try {
      const next = removeProjectRecord(projects(), path);
      saveProjects(next);
      setProjects(next);
    } catch (reason) {
      reportError(reason);
      return;
    }

    removePinnedProject(path);

    const nextProjectSidebarState = removeProjectSidebarState(projectSidebarState(), path);
    if (nextProjectSidebarState === projectSidebarState()) {
      return;
    }
    commitProjectSidebarState(nextProjectSidebarState);
  }

  function commitProjectSidebarState(next: ProjectSidebarState): void {
    if (next === projectSidebarState()) {
      return;
    }
    try {
      saveProjectSidebarState(next);
      setProjectSidebarState(next);
    } catch (reason) {
      reportError(reason);
    }
  }

  function projectExpanded(path: string): boolean {
    return readProjectExpanded(projectSidebarState(), path);
  }

  function projectThreadListExpanded(path: string): boolean {
    return readProjectThreadListExpanded(projectSidebarState(), path);
  }

  function toggleProjectExpanded(path: string): void {
    commitProjectSidebarState(toggleStoredProjectExpanded(projectSidebarState(), path));
  }

  function toggleProjectSection(): void {
    commitProjectSidebarState(toggleProjectSectionExpanded(projectSidebarState()));
  }

  function toggleProjectThreadListExpanded(path: string): void {
    commitProjectSidebarState(toggleStoredProjectThreadListExpanded(projectSidebarState(), path));
  }

  function togglePinnedThread(threadId: string): void {
    try {
      const next = togglePinnedThreadId(pinnedThreadIds(), threadId);
      savePinnedThreadIds(next);
      setPinnedThreadIds(next);
    } catch (reason) {
      reportError(reason);
    }
  }

  function removePinnedThread(threadId: string): void {
    const next = removePinnedThreadId(pinnedThreadIds(), threadId);
    if (next.length === pinnedThreadIds().length) {
      return;
    }
    try {
      savePinnedThreadIds(next);
      setPinnedThreadIds(next);
    } catch (reason) {
      reportError(reason);
    }
  }

  function togglePinnedProject(path: string): void {
    if (!projects().some((project) => pathsEqual(project.path, path))) {
      setError(uiError("projectUnavailable"));
      return;
    }
    try {
      const next = togglePinnedProjectPath(pinnedProjectPaths(), path);
      savePinnedProjectPaths(next);
      setPinnedProjectPaths(next);
    } catch (reason) {
      reportError(reason);
    }
  }

  function removePinnedProject(path: string): void {
    const next = removePinnedProjectPath(pinnedProjectPaths(), path);
    if (next.length === pinnedProjectPaths().length) {
      return;
    }
    try {
      savePinnedProjectPaths(next);
      setPinnedProjectPaths(next);
    } catch (reason) {
      reportError(reason);
    }
  }

  function hasProject(path: string): boolean {
    return projects().some((project) => pathsEqual(project.path, path));
  }

  function updateProject(
    path: string,
    updates: Partial<Pick<ProjectRecord, "color" | "icon" | "name">>,
  ): void {
    setProjects((current) => {
      const next = updateProjectRecord(current, path, updates);
      saveProjects(next);
      return next;
    });
  }

  return {
    addProjectPath,
    chatGptMode,
    commitProductFlow,
    conversationMode,
    hasProject,
    initializationFailures,
    pinnedProjectPaths,
    pinnedThreadIds,
    product,
    productFlow,
    projectExpanded,
    projectSectionExpanded,
    projects,
    projectThreadListExpanded,
    rememberDestination,
    removePinnedProject,
    removePinnedThread,
    removeProject,
    selectProjectPath,
    setWorkspace,
    togglePinnedProject,
    togglePinnedThread,
    toggleProjectExpanded,
    toggleProjectSection,
    toggleProjectThreadListExpanded,
    updateProject,
    workspace,
  };
}
