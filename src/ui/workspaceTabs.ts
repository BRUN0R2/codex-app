export const REVIEW_WORKSPACE_TAB_ID = "review" as const;

export type BrowserWorkspaceTabId = `browser:${string}`;
export type WorkspaceTabId = BrowserWorkspaceTabId | typeof REVIEW_WORKSPACE_TAB_ID;

export type WorkspaceTab =
  | {
      readonly id: BrowserWorkspaceTabId;
      readonly kind: "browser";
      readonly browserTabId: string;
    }
  | {
      readonly id: typeof REVIEW_WORKSPACE_TAB_ID;
      readonly kind: "review";
    };

export interface WorkspaceTabsState {
  readonly activeTabId: WorkspaceTabId | null;
  readonly conversationId: string | null;
  readonly tabs: readonly WorkspaceTab[];
  readonly visible: boolean;
}

export function emptyWorkspaceTabsState(): WorkspaceTabsState {
  return {
    activeTabId: null,
    conversationId: null,
    tabs: [],
    visible: false,
  };
}

export function browserWorkspaceTabId(browserTabId: string): BrowserWorkspaceTabId {
  return `browser:${browserTabId}`;
}

export function reconcileBrowserWorkspaceTabs(
  current: WorkspaceTabsState,
  input: {
    readonly activeBrowserTabId: string | null;
    readonly browserTabIds: readonly string[];
    readonly conversationId: string | null;
  },
): WorkspaceTabsState {
  if (input.conversationId === null) {
    return current.conversationId === null && current.tabs.length === 0
      ? current
      : emptyWorkspaceTabsState();
  }

  const nextBrowserIds = new Set(input.browserTabIds);
  const conversationChanged = current.conversationId !== input.conversationId;
  const retainedTabs = conversationChanged
    ? []
    : current.tabs.filter((tab) => tab.kind !== "browser" || nextBrowserIds.has(tab.browserTabId));
  const retainedBrowserIds = new Set(
    retainedTabs.flatMap((tab) => (tab.kind === "browser" ? [tab.browserTabId] : [])),
  );
  const appendedTabs = input.browserTabIds
    .filter((browserTabId) => !retainedBrowserIds.has(browserTabId))
    .map(toBrowserWorkspaceTab);
  const tabs = [...retainedTabs, ...appendedTabs];
  const preferredBrowserTabId =
    input.activeBrowserTabId === null ? null : browserWorkspaceTabId(input.activeBrowserTabId);
  const activeTabId = resolveActiveTabId(
    tabs,
    conversationChanged ? preferredBrowserTabId : current.activeTabId,
    preferredBrowserTabId,
  );
  const next: WorkspaceTabsState = {
    activeTabId,
    conversationId: input.conversationId,
    tabs,
    visible: conversationChanged ? false : current.visible && activeTabId !== null,
  };
  return sameWorkspaceTabsState(current, next) ? current : next;
}

export function showBrowserWorkspaceTab(
  current: WorkspaceTabsState,
  browserTabId: string,
): WorkspaceTabsState {
  return showWorkspaceTab(current, browserWorkspaceTabId(browserTabId));
}

export function showReviewWorkspaceTab(current: WorkspaceTabsState): WorkspaceTabsState {
  const hasReview = current.tabs.some((tab) => tab.kind === "review");
  const tabs = hasReview
    ? current.tabs
    : [...current.tabs, { id: REVIEW_WORKSPACE_TAB_ID, kind: "review" } as const];
  return {
    ...current,
    activeTabId: REVIEW_WORKSPACE_TAB_ID,
    tabs,
    visible: true,
  };
}

export function showWorkspaceTab(
  current: WorkspaceTabsState,
  tabId: WorkspaceTabId,
): WorkspaceTabsState {
  if (!current.tabs.some((tab) => tab.id === tabId)) {
    return current;
  }
  if (current.visible && current.activeTabId === tabId) {
    return current;
  }
  return { ...current, activeTabId: tabId, visible: true };
}

export function hideWorkspaceTabs(current: WorkspaceTabsState): WorkspaceTabsState {
  return current.visible ? { ...current, visible: false } : current;
}

export function closeWorkspaceTab(
  current: WorkspaceTabsState,
  tabId: WorkspaceTabId,
): WorkspaceTabsState {
  const closedIndex = current.tabs.findIndex((tab) => tab.id === tabId);
  if (closedIndex === -1) {
    return current;
  }
  const tabs = current.tabs.filter((tab) => tab.id !== tabId);
  if (current.activeTabId !== tabId) {
    return { ...current, tabs };
  }
  const successor = tabs[Math.min(closedIndex, tabs.length - 1)] ?? null;
  return {
    ...current,
    activeTabId: successor?.id ?? null,
    tabs,
    visible: current.visible && successor !== null,
  };
}

export function removeReviewWorkspaceTab(current: WorkspaceTabsState): WorkspaceTabsState {
  return closeWorkspaceTab(current, REVIEW_WORKSPACE_TAB_ID);
}

export function activeWorkspaceTab(current: WorkspaceTabsState): WorkspaceTab | null {
  return current.tabs.find((tab) => tab.id === current.activeTabId) ?? null;
}

function toBrowserWorkspaceTab(browserTabId: string): WorkspaceTab {
  return {
    id: browserWorkspaceTabId(browserTabId),
    kind: "browser",
    browserTabId,
  };
}

function resolveActiveTabId(
  tabs: readonly WorkspaceTab[],
  requested: WorkspaceTabId | null,
  fallback: BrowserWorkspaceTabId | null,
): WorkspaceTabId | null {
  if (requested !== null && tabs.some((tab) => tab.id === requested)) {
    return requested;
  }
  if (fallback !== null && tabs.some((tab) => tab.id === fallback)) {
    return fallback;
  }
  return tabs[0]?.id ?? null;
}

function sameWorkspaceTabsState(left: WorkspaceTabsState, right: WorkspaceTabsState): boolean {
  return (
    left.activeTabId === right.activeTabId &&
    left.conversationId === right.conversationId &&
    left.visible === right.visible &&
    left.tabs.length === right.tabs.length &&
    left.tabs.every((tab, index) => {
      const candidate = right.tabs[index];
      return (
        candidate !== undefined &&
        tab.id === candidate.id &&
        tab.kind === candidate.kind &&
        (tab.kind !== "browser" ||
          (candidate.kind === "browser" && tab.browserTabId === candidate.browserTabId))
      );
    })
  );
}
