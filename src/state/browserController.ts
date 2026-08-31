import { createSignal } from "solid-js";

import type {
  BrowserActionMetric,
  BrowserAgentActivityNotification,
  BrowserSurfaceBounds,
  BrowserTabSnapshot,
  BrowserViewport,
} from "../contracts/types";
import {
  closeBrowserTab,
  createBrowserTab,
  goBackInBrowserTab,
  goForwardInBrowserTab,
  listenBrowserAgentActivity,
  listenBrowserMetric,
  listenBrowserNewWindow,
  listenBrowserState,
  listenThreadDeleted,
  navigateBrowserTab,
  reloadBrowserTab,
  setBrowserViewport,
  synchronizeBrowserSurface,
} from "../infrastructure/browserClient";
import {
  loadPersistedBrowserConversations,
  MAX_BROWSER_URL_BYTES,
  type PersistedBrowserConversation,
  savePersistedBrowserConversations,
} from "./browserPersistence";
import { SingleFlightOperations } from "./singleFlightOperations";

const MAX_BROWSER_TABS = 16;
const DEFAULT_BROWSER_URL = "about:blank";

interface BrowserConversationState {
  readonly activeBrowserTabId: string;
  readonly tabs: readonly BrowserTabSnapshot[];
}

export interface BrowserController {
  readonly agentActivity: () => BrowserAgentActivityNotification | null;
  readonly activeTab: (conversationId: string) => BrowserTabSnapshot | null;
  readonly back: (conversationId: string) => Promise<boolean>;
  readonly closeTab: (conversationId: string, browserTabId: string) => Promise<boolean>;
  readonly dispose: () => void;
  readonly ensureConversation: (conversationId: string) => Promise<boolean>;
  readonly forward: (conversationId: string) => Promise<boolean>;
  readonly metrics: (conversationId: string) => readonly BrowserActionMetric[];
  readonly navigate: (conversationId: string, input: string) => Promise<boolean>;
  readonly newTab: (conversationId: string, url?: string) => Promise<boolean>;
  readonly reload: (conversationId: string) => Promise<boolean>;
  readonly selectTab: (conversationId: string, browserTabId: string) => Promise<boolean>;
  readonly setViewport: (
    conversationId: string,
    viewport: BrowserViewport | null,
  ) => Promise<boolean>;
  readonly start: () => void;
  readonly synchronizeSurface: (input: {
    readonly bounds: BrowserSurfaceBounds | null;
    readonly conversationId: string | null;
    readonly visible: boolean;
  }) => Promise<boolean>;
  readonly tabs: (conversationId: string) => readonly BrowserTabSnapshot[];
}

export function createBrowserController(reportError: (reason: unknown) => void): BrowserController {
  const persisted = loadPersistedBrowserConversations();
  if (persisted.error !== null) {
    reportError(persisted.error);
  }
  const initialStates = new Map<string, BrowserConversationState>(
    persisted.conversations.map((conversation) => [
      conversation.conversationId,
      {
        activeBrowserTabId: conversation.activeBrowserTabId,
        tabs: conversation.tabs.map((tab) => placeholderSnapshot(conversation.conversationId, tab)),
      },
    ]),
  );
  const [states, setStates] =
    createSignal<ReadonlyMap<string, BrowserConversationState>>(initialStates);
  const [agentActivity, setAgentActivity] = createSignal<BrowserAgentActivityNotification | null>(
    null,
  );
  const [metricStates, setMetricStates] = createSignal<
    ReadonlyMap<string, readonly BrowserActionMetric[]>
  >(new Map());
  const nativeTabIds = new Set<string>();
  const deletedConversationIds = new Set<string>();
  const nativeTabInitializations = new SingleFlightOperations<string, boolean>();
  const initializingConversations = new Map<string, Promise<boolean>>();
  const unlisteners: Array<() => void> = [];
  let started = false;
  let disposed = false;
  let persistedTopology = JSON.stringify(toPersistedConversations(initialStates));

  function tabs(conversationId: string): readonly BrowserTabSnapshot[] {
    return states().get(conversationId)?.tabs ?? [];
  }

  function activeTab(conversationId: string): BrowserTabSnapshot | null {
    const state = states().get(conversationId);
    if (state === undefined) {
      return null;
    }
    return state.tabs.find((tab) => tab.browserTabId === state.activeBrowserTabId) ?? null;
  }

  function metrics(conversationId: string): readonly BrowserActionMetric[] {
    return metricStates().get(conversationId) ?? [];
  }

  function persist(): void {
    const conversations = toPersistedConversations(states());
    const topology = JSON.stringify(conversations);
    if (topology === persistedTopology) {
      return;
    }
    persistedTopology = topology;
    try {
      savePersistedBrowserConversations(conversations);
    } catch (reason) {
      reportError(reason);
    }
  }

  function updateConversation(
    conversationId: string,
    update: (current: BrowserConversationState | undefined) => BrowserConversationState | null,
  ): void {
    setStates((current) => {
      const nextState = update(current.get(conversationId));
      const next = new Map(current);
      if (nextState === null) {
        next.delete(conversationId);
      } else {
        next.set(conversationId, nextState);
      }
      return next;
    });
    persist();
  }

  function upsertSnapshot(snapshot: BrowserTabSnapshot): void {
    if (deletedConversationIds.has(snapshot.conversationId)) {
      return;
    }
    nativeTabIds.add(snapshot.browserTabId);
    updateConversation(snapshot.conversationId, (current) => {
      if (current === undefined) {
        return { activeBrowserTabId: snapshot.browserTabId, tabs: [snapshot] };
      }
      const index = current.tabs.findIndex((tab) => tab.browserTabId === snapshot.browserTabId);
      const nextTabs = [...current.tabs];
      if (index === -1) {
        nextTabs.push(snapshot);
      } else {
        nextTabs[index] = snapshot;
      }
      return { ...current, tabs: nextTabs };
    });
  }

  function replaceFromAgent(activity: BrowserAgentActivityNotification): void {
    if (activity.tabs.some((tab) => tab.conversationId !== activity.conversationId)) {
      reportError(new Error("The agent topology contains a tab from another conversation."));
      return;
    }
    if (deletedConversationIds.has(activity.conversationId)) {
      void releaseNativeTabs(
        activity.conversationId,
        activity.tabs.map((tab) => tab.browserTabId),
      );
      return;
    }
    for (const tab of activity.tabs) {
      nativeTabIds.add(tab.browserTabId);
    }
    updateConversation(activity.conversationId, () =>
      activity.tabs.length === 0 || activity.activeBrowserTabId === null
        ? null
        : {
            activeBrowserTabId: activity.activeBrowserTabId,
            tabs: activity.tabs,
          },
    );
    setAgentActivity(activity);
  }

  function appendMetric(metric: BrowserActionMetric): void {
    setMetricStates((current) => {
      const previous = current.get(metric.conversationId) ?? [];
      const next = new Map(current);
      next.set(metric.conversationId, [...previous, metric].slice(-100));
      return next;
    });
  }

  function ensureNativeTab(snapshot: BrowserTabSnapshot): Promise<boolean> {
    if (deletedConversationIds.has(snapshot.conversationId)) {
      return Promise.resolve(false);
    }
    if (nativeTabIds.has(snapshot.browserTabId)) {
      return Promise.resolve(true);
    }
    return nativeTabInitializations.run(snapshot.browserTabId, async () => {
      if (nativeTabIds.has(snapshot.browserTabId)) {
        return true;
      }
      try {
        const created = await createBrowserTab(
          {
            browserTabId: snapshot.browserTabId,
            conversationId: snapshot.conversationId,
          },
          snapshot.url,
        );
        if (deletedConversationIds.has(snapshot.conversationId)) {
          await releaseNativeTabs(snapshot.conversationId, [created.browserTabId]);
          return false;
        }
        upsertSnapshot(created);
        return true;
      } catch (reason) {
        reportError(reason);
        return false;
      }
    });
  }

  async function ensureConversation(conversationId: string): Promise<boolean> {
    const pending = initializingConversations.get(conversationId);
    if (pending !== undefined) {
      return pending;
    }
    const initialization = (async () => {
      const current = states().get(conversationId);
      if (current === undefined) {
        return newTab(conversationId);
      }
      const selected = activeTab(conversationId);
      if (selected === null) {
        reportError(new Error("The browser conversation lost its active tab."));
        return false;
      }
      return ensureNativeTab(selected);
    })();
    initializingConversations.set(conversationId, initialization);
    try {
      return await initialization;
    } finally {
      initializingConversations.delete(conversationId);
    }
  }

  async function newTab(conversationId: string, url = DEFAULT_BROWSER_URL): Promise<boolean> {
    const conversationTabCount = states().get(conversationId)?.tabs.length ?? 0;
    if (conversationTabCount >= MAX_BROWSER_TABS) {
      reportError(
        new Error(`The internal browser accepts at most ${MAX_BROWSER_TABS} tabs per task.`),
      );
      return false;
    }
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeBrowserAddress(url);
    } catch (reason) {
      reportError(reason);
      return false;
    }
    const browserTabId = crypto.randomUUID();
    const placeholder = placeholderSnapshot(conversationId, {
      browserTabId,
      url: normalizedUrl,
    });
    updateConversation(conversationId, (current) => ({
      activeBrowserTabId: browserTabId,
      tabs: [...(current?.tabs ?? []), placeholder],
    }));
    if (await ensureNativeTab(placeholder)) {
      return true;
    }
    discardFailedBrowserTab(conversationId, browserTabId);
    return false;
  }

  function discardFailedBrowserTab(conversationId: string, browserTabId: string): void {
    const current = states().get(conversationId);
    if (current === undefined) {
      return;
    }
    const remaining = current.tabs.filter((tab) => tab.browserTabId !== browserTabId);
    const firstRemaining = remaining[0];
    updateConversation(conversationId, () =>
      firstRemaining === undefined
        ? null
        : { activeBrowserTabId: firstRemaining.browserTabId, tabs: remaining },
    );
  }

  async function selectTab(conversationId: string, browserTabId: string): Promise<boolean> {
    const selected = tabs(conversationId).find((tab) => tab.browserTabId === browserTabId);
    if (selected === undefined) {
      reportError(new Error("The selected tab does not belong to this conversation."));
      return false;
    }
    updateConversation(conversationId, (current) =>
      current === undefined ? null : { ...current, activeBrowserTabId: browserTabId },
    );
    return ensureNativeTab(selected);
  }

  async function closeTab(conversationId: string, browserTabId: string): Promise<boolean> {
    try {
      await closeBrowserTab({ browserTabId, conversationId });
      nativeTabIds.delete(browserTabId);
    } catch (reason) {
      reportError(reason);
      return false;
    }
    const current = states().get(conversationId);
    if (current === undefined) {
      return newTab(conversationId);
    }
    const closedIndex = current.tabs.findIndex((tab) => tab.browserTabId === browserTabId);
    const remaining = current.tabs.filter((tab) => tab.browserTabId !== browserTabId);
    if (remaining.length === 0) {
      updateConversation(conversationId, () => null);
      return newTab(conversationId);
    }
    const successorIndex = Math.min(Math.max(0, closedIndex), remaining.length - 1);
    const successor = remaining[successorIndex];
    if (successor === undefined) {
      reportError(new Error("The closed tab could not be replaced by another remaining tab."));
      return false;
    }
    updateConversation(conversationId, () => ({
      activeBrowserTabId:
        current.activeBrowserTabId === browserTabId
          ? successor.browserTabId
          : current.activeBrowserTabId,
      tabs: remaining,
    }));
    return true;
  }

  async function withActiveTab(
    conversationId: string,
    action: (snapshot: BrowserTabSnapshot) => Promise<BrowserTabSnapshot>,
  ): Promise<boolean> {
    if (!(await ensureConversation(conversationId))) {
      return false;
    }
    const selected = activeTab(conversationId);
    if (selected === null) {
      reportError(new Error("The internal browser has no active tab."));
      return false;
    }
    try {
      upsertSnapshot(await action(selected));
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  function back(conversationId: string): Promise<boolean> {
    return withActiveTab(conversationId, (tab) =>
      goBackInBrowserTab({ browserTabId: tab.browserTabId, conversationId }),
    );
  }

  function forward(conversationId: string): Promise<boolean> {
    return withActiveTab(conversationId, (tab) =>
      goForwardInBrowserTab({ browserTabId: tab.browserTabId, conversationId }),
    );
  }

  function reload(conversationId: string): Promise<boolean> {
    return withActiveTab(conversationId, (tab) =>
      reloadBrowserTab({ browserTabId: tab.browserTabId, conversationId }),
    );
  }

  function setViewport(conversationId: string, viewport: BrowserViewport | null): Promise<boolean> {
    return withActiveTab(conversationId, (tab) =>
      setBrowserViewport({ browserTabId: tab.browserTabId, conversationId }, viewport),
    );
  }

  async function navigate(conversationId: string, input: string): Promise<boolean> {
    let url: string;
    try {
      url = normalizeBrowserAddress(input);
    } catch (reason) {
      reportError(reason);
      return false;
    }
    return withActiveTab(conversationId, (tab) =>
      navigateBrowserTab({ browserTabId: tab.browserTabId, conversationId }, url),
    );
  }

  async function synchronizeSurface(input: {
    readonly bounds: BrowserSurfaceBounds | null;
    readonly conversationId: string | null;
    readonly visible: boolean;
  }): Promise<boolean> {
    if (
      input.visible &&
      input.conversationId !== null &&
      !(await ensureConversation(input.conversationId))
    ) {
      return false;
    }
    const selected = input.conversationId === null ? null : activeTab(input.conversationId);
    try {
      await synchronizeBrowserSurface({
        activeBrowserTabId: selected?.browserTabId ?? null,
        bounds: input.bounds,
        conversationId: input.conversationId,
        visible: input.visible && selected !== null,
      });
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  async function releaseNativeTabs(
    conversationId: string,
    browserTabIds: readonly string[],
  ): Promise<void> {
    const outcomes = await Promise.allSettled(
      browserTabIds.map((browserTabId) => closeBrowserTab({ browserTabId, conversationId })),
    );
    for (let index = 0; index < outcomes.length; index += 1) {
      const browserTabId = browserTabIds[index];
      if (browserTabId !== undefined) {
        nativeTabIds.delete(browserTabId);
      }
      const outcome = outcomes[index];
      if (outcome?.status === "rejected") {
        reportError(outcome.reason);
      }
    }
  }

  async function removeDeletedConversation(conversationId: string): Promise<void> {
    deletedConversationIds.add(conversationId);
    const current = states().get(conversationId);
    const nativeIds =
      current?.tabs
        .map((tab) => tab.browserTabId)
        .filter((browserTabId) => nativeTabIds.has(browserTabId)) ?? [];
    updateConversation(conversationId, () => null);
    setMetricStates((metrics) => {
      if (!metrics.has(conversationId)) {
        return metrics;
      }
      const next = new Map(metrics);
      next.delete(conversationId);
      return next;
    });
    setAgentActivity((activity) => (activity?.conversationId === conversationId ? null : activity));
    await releaseNativeTabs(conversationId, nativeIds);
  }

  function start(): void {
    if (started || disposed) {
      return;
    }
    started = true;
    for (const pending of [
      listenBrowserState(upsertSnapshot, reportError),
      listenBrowserAgentActivity(replaceFromAgent, reportError),
      listenBrowserMetric(appendMetric, reportError),
      listenBrowserNewWindow(
        (request) => void newTab(request.conversationId, request.url),
        reportError,
      ),
      listenThreadDeleted((threadId) => void removeDeletedConversation(threadId), reportError),
    ]) {
      void pending.then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlisteners.push(unlisten);
      });
    }
  }

  function dispose(): void {
    disposed = true;
    for (const unlisten of unlisteners) {
      unlisten();
    }
    unlisteners.length = 0;
  }

  return {
    agentActivity,
    activeTab,
    back,
    closeTab,
    dispose,
    ensureConversation,
    forward,
    metrics,
    navigate,
    newTab,
    reload,
    selectTab,
    setViewport,
    start,
    synchronizeSurface,
    tabs,
  };
}

export function normalizeBrowserAddress(input: string): string {
  const value = input.trim();
  if (
    value.length === 0 ||
    /\p{Cc}/u.test(value) ||
    new TextEncoder().encode(value).length > MAX_BROWSER_URL_BYTES
  ) {
    throw new Error("The browser address is empty or invalid.");
  }
  if (value === DEFAULT_BROWSER_URL) {
    return value;
  }
  const localHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/iu.test(value);
  const hasScheme = /^[a-z][a-z\d+.-]*:/iu.test(value) && !localHost;
  const looksLikeHost =
    !/\s/u.test(value) &&
    (value.includes(".") || /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/iu.test(value));
  const candidate = hasScheme
    ? value
    : looksLikeHost
      ? `${localHost ? "http" : "https"}://${value}`
      : `https://www.google.com/search?q=${encodeURIComponent(value)}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("The browser address is not a valid URL or search query.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("The internal browser accepts only credential-free HTTP(S) addresses.");
  }
  return url.href;
}

function placeholderSnapshot(
  conversationId: string,
  tab: { readonly browserTabId: string; readonly url: string },
): BrowserTabSnapshot {
  return {
    browserTabId: tab.browserTabId,
    conversationId,
    url: tab.url,
    title: null,
    canGoBack: false,
    canGoForward: false,
    isLoading: true,
    viewport: null,
  };
}

function toPersistedConversations(
  states: ReadonlyMap<string, BrowserConversationState>,
): readonly PersistedBrowserConversation[] {
  return [...states].map(([conversationId, state]) => ({
    activeBrowserTabId: state.activeBrowserTabId,
    conversationId,
    tabs: state.tabs.map((tab) => ({ browserTabId: tab.browserTabId, url: tab.url })),
  }));
}
