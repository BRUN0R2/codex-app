import type { AppController } from "../state/appController";

export type SidebarController = Pick<
  AppController,
  | "account"
  | "activeTaskRootId"
  | "archiveThread"
  | "chooseWorkspace"
  | "currentThread"
  | "deleteThread"
  | "forkThread"
  | "isThreadActive"
  | "loadMoreThreads"
  | "logout"
  | "newThread"
  | "openThread"
  | "pendingOperations"
  | "pinnedProjectPaths"
  | "pinnedThreadIds"
  | "product"
  | "projectExpanded"
  | "projectSectionExpanded"
  | "projectThreadListExpanded"
  | "projects"
  | "rateLimits"
  | "refreshAccountProfile"
  | "refreshRateLimitsIfStale"
  | "removeProject"
  | "renameThread"
  | "selectProduct"
  | "threads"
  | "threadsNextCursor"
  | "togglePinnedProject"
  | "togglePinnedThread"
  | "toggleProjectExpanded"
  | "toggleProjectSection"
  | "toggleProjectThreadListExpanded"
  | "unreadAutomationRuns"
  | "updateProject"
  | "workspace"
>;

export const MAX_VISIBLE_PROJECT_GROUPS = 5;
export const MAX_UNGROUPED_RECENT_THREADS = 8;
export const MAX_INLINE_PROJECT_THREADS = 5;
export const THREAD_BADGE_COUNT_SATURATION: number = 99;
export const DEFAULT_PROJECT_COLOR: string = "#4ade80";
