import {
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from "solid-js";
import type { BrowserAgentActivityNotification } from "../contracts/types";
import { useI18n } from "../i18n/context";
import { formatMessage } from "../i18n/messages";
import { openExternalUrl, openWorkspaceDirectory } from "../infrastructure/codexClient";
import { subscribeToMenuEvents } from "../infrastructure/desktopClient";
import { isBrowserPreview } from "../platform/desktopRuntime";
import type { AppController } from "../state/appController";
import { createBrowserController } from "../state/browserController";

import { ApprovalCard } from "./ApprovalCard";
import { applyDesktopAppearance } from "./appearance";
import { Composer, type ComposerDraftRequest } from "./Composer";
import { formatShortDate } from "./dateFormat";
import { HomeComposerModeToggle } from "./HomeComposerModeToggle";
import { Icon } from "./Icon";
import { LatestTurnFileChangeStore } from "./reviewChanges";
import type { SettingsPage } from "./SettingsDialog";
import { Sidebar } from "./Sidebar";
import { Timeline } from "./Timeline";
import { TurnProgress } from "./TurnProgress";
import { shouldShowTurnProgress } from "./turnProgressVisibility";
import {
  readWorkspaceSplitRatio,
  resolveWorkspaceSplitMetrics,
  WORKSPACE_SPLIT_DEFAULT_RATIO,
  workspaceSplitRatioFromPointer,
  writeWorkspaceSplitRatio,
} from "./workspaceSplit";
import {
  activeWorkspaceTab,
  browserWorkspaceTabId,
  closeWorkspaceTab,
  emptyWorkspaceTabsState,
  hideWorkspaceTabs,
  reconcileBrowserWorkspaceTabs,
  removeReviewWorkspaceTab,
  showBrowserWorkspaceTab,
  showReviewWorkspaceTab,
  showWorkspaceTab,
  type WorkspaceTab,
} from "./workspaceTabs";

const AutomationsView = lazy(async () => ({
  default: (await import("./AutomationsView")).AutomationsView,
}));
const WorkspacePanel = lazy(async () => ({
  default: (await import("./WorkspacePanel")).WorkspacePanel,
}));
const SettingsDialog = lazy(async () => ({
  default: (await import("./SettingsDialog")).SettingsDialog,
}));

export function AppShell(props: { readonly controller: AppController }) {
  const i18n = useI18n();
  const messages = () => i18n.messages().shell;
  const previewSettingsPage = readPreviewSettingsPage();
  const previewSurface = readPreviewSurface();
  const [settingsOpen, setSettingsOpen] = createSignal(previewSettingsPage !== null);
  const [settingsPage, setSettingsPage] = createSignal<SettingsPage | null>(previewSettingsPage);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const [activeSurface, setActiveSurface] = createSignal<"automations" | "chat">(previewSurface);
  const reviewChangeStore = new LatestTurnFileChangeStore();
  const browserController = createBrowserController(props.controller.reportError);
  const [workspaceTabs, setWorkspaceTabs] = createSignal(emptyWorkspaceTabsState());
  const [workspaceSplitRatio, setWorkspaceSplitRatio] = createSignal(readWorkspaceSplitRatio());
  const [workspaceSplitMetrics, setWorkspaceSplitMetrics] = createSignal(
    resolveWorkspaceSplitMetrics(workspaceSplitRatio(), 0),
  );
  const [workspaceSplitDragging, setWorkspaceSplitDragging] = createSignal(false);
  let previewBrowserPending = readPreviewBrowserOpen();
  let observedBrowserAgentActivity: BrowserAgentActivityNotification | null = null;
  const reviewChanges = createMemo(() =>
    reviewChangeStore.project(props.controller.turns(), props.controller.activeTurnId()),
  );
  const activeWorkspaceSurface = createMemo(() => activeWorkspaceTab(workspaceTabs()));
  const reviewOpen = createMemo(
    () => workspaceTabs().visible && activeWorkspaceSurface()?.kind === "review",
  );

  function openSettings(page?: SettingsPage): void {
    setWorkspaceTabs(hideWorkspaceTabs);
    setSettingsPage(page ?? null);
    setSettingsOpen(true);
  }
  const [draftRequest, setDraftRequest] = createSignal<ComposerDraftRequest | null>(null);
  const [chatDockHeight, setChatDockHeight] = createSignal(0);
  let nextDraftRequestId = 0;
  let chatPageElement: HTMLElement | undefined;
  let chatDockElement: HTMLDivElement | undefined;
  let mainPanelContentElement: HTMLDivElement | undefined;
  let workspaceSplitterElement: HTMLHRElement | undefined;
  let chatDockResizeObserver: ResizeObserver | undefined;
  let workspaceSplitResizeObserver: ResizeObserver | undefined;
  let chatDockResizeFrame: number | undefined;
  let workspaceSplitPointerId: number | undefined;
  let disposed = false;
  const eventUnlisteners: Array<() => void> = [];

  function handleKeyboardShortcut(event: KeyboardEvent): void {
    if (event.key === "Escape" && workspaceTabs().visible) {
      event.preventDefault();
      setWorkspaceTabs(hideWorkspaceTabs);
      return;
    }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "b") {
      event.preventDefault();
      const conversationId = props.controller.currentThread()?.id;
      if (conversationId !== undefined) {
        if (workspaceTabs().visible && activeWorkspaceSurface()?.kind === "browser") {
          setWorkspaceTabs(hideWorkspaceTabs);
        } else {
          void openBrowserWorkspace(conversationId);
        }
      }
      return;
    }
    if (event.ctrlKey && event.key === ",") {
      event.preventDefault();
      openSettings();
      return;
    }
  }

  createEffect(() => {
    if (reviewChanges().length === 0) {
      setWorkspaceTabs(removeReviewWorkspaceTab);
    }
  });

  createEffect(() => {
    const conversationId = props.controller.currentThread()?.id ?? null;
    const tabs = conversationId === null ? [] : browserController.tabs(conversationId);
    const activeBrowserTabId =
      conversationId === null
        ? null
        : (browserController.activeTab(conversationId)?.browserTabId ?? null);
    setWorkspaceTabs((current) =>
      reconcileBrowserWorkspaceTabs(current, {
        activeBrowserTabId,
        browserTabIds: tabs.map(({ browserTabId }) => browserTabId),
        conversationId,
      }),
    );
  });

  createEffect(() => {
    if (!previewBrowserPending) {
      return;
    }
    const conversationId = props.controller.currentThread()?.id;
    if (conversationId === undefined) {
      return;
    }
    previewBrowserPending = false;
    void openBrowserWorkspace(conversationId);
  });

  createEffect(() => {
    const preferences = props.controller.config()?.config.desktop;
    if (preferences !== undefined) {
      applyDesktopAppearance(preferences);
    }
  });

  createEffect(() => {
    const activity = browserController.agentActivity();
    if (activity === null || activity === observedBrowserAgentActivity) {
      return;
    }
    observedBrowserAgentActivity = activity;
    if (props.controller.currentThread()?.id !== activity.conversationId) {
      return;
    }
    if (activity.panel === "close") {
      setWorkspaceTabs(hideWorkspaceTabs);
      return;
    }
    setSettingsPage(null);
    setSettingsOpen(false);
    setActiveSurface("chat");
    const browserTabId = activity.activeBrowserTabId;
    if (browserTabId !== null) {
      setWorkspaceTabs((current) =>
        showBrowserWorkspaceTab(
          reconcileBrowserWorkspaceTabs(current, {
            activeBrowserTabId: browserTabId,
            browserTabIds: activity.tabs.map((tab) => tab.browserTabId),
            conversationId: activity.conversationId,
          }),
          browserTabId,
        ),
      );
    }
  });

  async function openBrowserWorkspace(
    conversationId: string,
    requestedBrowserTabId?: string,
  ): Promise<void> {
    setSettingsPage(null);
    setSettingsOpen(false);
    setActiveSurface("chat");
    if (!(await browserController.ensureConversation(conversationId))) {
      return;
    }
    const browserTabId =
      requestedBrowserTabId ?? browserController.activeTab(conversationId)?.browserTabId;
    if (browserTabId === undefined) {
      props.controller.reportError(new Error("The internal browser has no active tab."));
      return;
    }
    setWorkspaceTabs((current) =>
      showBrowserWorkspaceTab(
        reconcileBrowserWorkspaceTabs(current, {
          activeBrowserTabId: browserTabId,
          browserTabIds: browserController.tabs(conversationId).map((tab) => tab.browserTabId),
          conversationId,
        }),
        browserTabId,
      ),
    );
  }

  function activateWorkspaceSurface(tab: WorkspaceTab): void {
    if (tab.kind === "review") {
      setWorkspaceTabs((current) => showWorkspaceTab(current, tab.id));
      return;
    }
    const conversationId = props.controller.currentThread()?.id;
    if (conversationId === undefined) {
      return;
    }
    void browserController.selectTab(conversationId, tab.browserTabId).then((selected) => {
      if (selected) {
        setWorkspaceTabs((current) => showWorkspaceTab(current, tab.id));
      }
    });
  }

  function closeWorkspaceSurface(tab: WorkspaceTab): void {
    if (tab.kind === "review") {
      setWorkspaceTabs((current) => closeWorkspaceTab(current, tab.id));
      return;
    }
    const conversationId = props.controller.currentThread()?.id;
    if (conversationId === undefined) {
      return;
    }
    const wasActive = workspaceTabs().activeTabId === tab.id && workspaceTabs().visible;
    setWorkspaceTabs((current) => closeWorkspaceTab(current, tab.id));
    void browserController.closeTab(conversationId, tab.browserTabId).then((closed) => {
      if (!closed) {
        setWorkspaceTabs((current) => {
          const reconciled = reconcileBrowserWorkspaceTabs(current, {
            activeBrowserTabId: browserController.activeTab(conversationId)?.browserTabId ?? null,
            browserTabIds: browserController
              .tabs(conversationId)
              .map(({ browserTabId }) => browserTabId),
            conversationId,
          });
          return wasActive ? showBrowserWorkspaceTab(reconciled, tab.browserTabId) : reconciled;
        });
      }
    });
  }

  function openNewBrowserTab(): void {
    const conversationId = props.controller.currentThread()?.id;
    if (conversationId === undefined) {
      return;
    }
    void browserController.newTab(conversationId).then((created) => {
      if (!created) {
        return;
      }
      const browserTabId = browserController.activeTab(conversationId)?.browserTabId;
      if (browserTabId !== undefined) {
        setWorkspaceTabs((current) =>
          showWorkspaceTab(
            reconcileBrowserWorkspaceTabs(current, {
              activeBrowserTabId: browserTabId,
              browserTabIds: browserController.tabs(conversationId).map((tab) => tab.browserTabId),
              conversationId,
            }),
            browserWorkspaceTabId(browserTabId),
          ),
        );
      }
    });
  }

  function requestDraft(text: string): void {
    nextDraftRequestId += 1;
    setDraftRequest({ id: nextDraftRequestId, text });
  }

  async function openWorkspace(path: string): Promise<void> {
    try {
      await openWorkspaceDirectory(path);
    } catch (reason) {
      props.controller.reportError(reason);
    }
  }

  function synchronizeChatDockInset(): void {
    if (chatPageElement === undefined || chatDockElement === undefined) {
      return;
    }
    const dockHeight = Math.ceil(chatDockElement.getBoundingClientRect().height);
    setChatDockHeight((current) => (current === dockHeight ? current : dockHeight));
    chatPageElement.style.setProperty("--chat-dock-height", `${dockHeight}px`);
  }

  function scheduleChatDockInset(): void {
    if (chatDockResizeFrame !== undefined) {
      return;
    }
    chatDockResizeFrame = requestAnimationFrame(() => {
      chatDockResizeFrame = undefined;
      synchronizeChatDockInset();
    });
  }

  function synchronizeWorkspaceSplitGeometry(requestedRatio = workspaceSplitRatio()): void {
    if (mainPanelContentElement === undefined) {
      return;
    }
    const metrics = resolveWorkspaceSplitMetrics(
      requestedRatio,
      mainPanelContentElement.getBoundingClientRect().width,
    );
    setWorkspaceSplitMetrics(metrics);
    mainPanelContentElement.style.setProperty(
      "--workspace-chat-pane-width",
      `${metrics.chatPaneWidth}px`,
    );
  }

  function commitWorkspaceSplitRatio(requestedRatio: number, persist: boolean): void {
    if (mainPanelContentElement === undefined) {
      return;
    }
    const metrics = resolveWorkspaceSplitMetrics(
      requestedRatio,
      mainPanelContentElement.getBoundingClientRect().width,
    );
    setWorkspaceSplitRatio(metrics.ratio);
    setWorkspaceSplitMetrics(metrics);
    mainPanelContentElement.style.setProperty(
      "--workspace-chat-pane-width",
      `${metrics.chatPaneWidth}px`,
    );
    if (persist) {
      writeWorkspaceSplitRatio(metrics.ratio);
    }
  }

  function updateWorkspaceSplitFromPointer(event: PointerEvent): void {
    if (workspaceSplitPointerId !== event.pointerId || mainPanelContentElement === undefined) {
      return;
    }
    const bounds = mainPanelContentElement.getBoundingClientRect();
    commitWorkspaceSplitRatio(
      workspaceSplitRatioFromPointer(event.clientX, bounds.left, bounds.width),
      false,
    );
  }

  function handleWorkspaceSplitPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || workspaceSplitPointerId !== undefined) {
      return;
    }
    event.preventDefault();
    workspaceSplitPointerId = event.pointerId;
    setWorkspaceSplitDragging(true);
    workspaceSplitterElement?.setPointerCapture(event.pointerId);
    updateWorkspaceSplitFromPointer(event);
  }

  function endWorkspaceSplitPointerDrag(event: PointerEvent, releaseCapture: boolean): void {
    if (workspaceSplitPointerId !== event.pointerId) {
      return;
    }
    workspaceSplitPointerId = undefined;
    setWorkspaceSplitDragging(false);
    writeWorkspaceSplitRatio(workspaceSplitRatio());
    if (releaseCapture && workspaceSplitterElement?.hasPointerCapture(event.pointerId) === true) {
      workspaceSplitterElement.releasePointerCapture(event.pointerId);
    }
  }

  function handleWorkspaceSplitKeyDown(event: KeyboardEvent): void {
    const metrics = workspaceSplitMetrics();
    const step = event.shiftKey ? 0.1 : 0.04;
    let requestedRatio: number;
    switch (event.key) {
      case "ArrowLeft":
        requestedRatio = metrics.ratio - step;
        break;
      case "ArrowRight":
        requestedRatio = metrics.ratio + step;
        break;
      case "Home":
        requestedRatio = metrics.minimumRatio;
        break;
      case "End":
        requestedRatio = metrics.maximumRatio;
        break;
      default:
        return;
    }
    event.preventDefault();
    commitWorkspaceSplitRatio(requestedRatio, true);
  }

  createEffect(() => {
    if (activeSurface() !== "chat" || !workspaceTabs().visible) {
      const pointerId = workspaceSplitPointerId;
      workspaceSplitPointerId = undefined;
      setWorkspaceSplitDragging(false);
      if (
        pointerId !== undefined &&
        workspaceSplitterElement?.hasPointerCapture(pointerId) === true
      ) {
        workspaceSplitterElement.releasePointerCapture(pointerId);
      }
      return;
    }
    queueMicrotask(() => synchronizeWorkspaceSplitGeometry());
  });

  onMount(() => {
    browserController.start();
    window.addEventListener("keydown", handleKeyboardShortcut);
    if (chatDockElement !== undefined) {
      chatDockResizeObserver = new ResizeObserver(scheduleChatDockInset);
      chatDockResizeObserver.observe(chatDockElement);
      scheduleChatDockInset();
    }
    if (mainPanelContentElement !== undefined) {
      workspaceSplitResizeObserver = new ResizeObserver(() => synchronizeWorkspaceSplitGeometry());
      workspaceSplitResizeObserver.observe(mainPanelContentElement);
      synchronizeWorkspaceSplitGeometry();
    }
    void subscribeToMenuEvents({
      onNewThread: () => {
        setActiveSurface("chat");
        props.controller.newThread();
      },
      onToggleSettings: () => openSettings(),
      onToggleSidebar: () => setSidebarCollapsed((value) => !value),
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }
      eventUnlisteners.push(unlisten);
    });
  });
  onCleanup(() => {
    browserController.dispose();
    disposed = true;
    for (const unlisten of eventUnlisteners) {
      unlisten();
    }
    window.removeEventListener("keydown", handleKeyboardShortcut);
    chatDockResizeObserver?.disconnect();
    workspaceSplitResizeObserver?.disconnect();
    if (chatDockResizeFrame !== undefined) {
      cancelAnimationFrame(chatDockResizeFrame);
    }
  });
  return (
    <div
      class="app-shell"
      classList={{
        "sidebar-collapsed": sidebarCollapsed(),
      }}
    >
      <Sidebar
        automationsActive={activeSurface() === "automations"}
        collapsed={sidebarCollapsed()}
        controller={props.controller}
        inert={settingsOpen()}
        onOpenAutomations={() => {
          setWorkspaceTabs(hideWorkspaceTabs);
          setActiveSurface("automations");
        }}
        onOpenWorkspace={(path) => void openWorkspace(path)}
        onOpenSettings={openSettings}
        onShowChat={() => {
          setWorkspaceTabs(hideWorkspaceTabs);
          setActiveSurface("chat");
        }}
      />
      <main class="main-panel" inert={settingsOpen()}>
        <Show when={activeSurface() === "chat" && props.controller.product() === "chatgpt"}>
          <HomeComposerModeToggle
            mode={props.controller.chatGptMode()}
            onChange={(mode) => void props.controller.selectChatGptMode(mode)}
          />
        </Show>
        <div
          class="main-panel-content"
          classList={{
            "workspace-split-dragging": workspaceSplitDragging(),
            "workspace-visible": activeSurface() === "chat" && workspaceTabs().visible,
          }}
          ref={mainPanelContentElement}
        >
          <Show
            when={
              activeSurface() === "chat" &&
              !workspaceTabs().visible &&
              props.controller.currentThread() !== null
            }
          >
            <button
              aria-label={messages().openBrowser}
              class="browser-panel-toggle"
              onClick={() => {
                const conversationId = props.controller.currentThread()?.id;
                if (conversationId !== undefined) {
                  void openBrowserWorkspace(conversationId);
                }
              }}
              title={messages().openBrowserShortcut}
              type="button"
            >
              <Icon name="globe" size={15} />
            </button>
          </Show>
          <section
            class="chat-page"
            classList={{
              "chatgpt-surface": props.controller.product() === "chatgpt",
              "chatgpt-empty":
                props.controller.product() === "chatgpt" &&
                props.controller.currentThread() === null,
              "work-surface": props.controller.conversationMode() === "work",
            }}
            hidden={activeSurface() !== "chat"}
            ref={chatPageElement}
          >
            <Timeline
              bottomOcclusion={chatDockHeight()}
              controller={props.controller}
              onSelectSuggestion={requestDraft}
            />
            <div class="chat-dock" ref={chatDockElement}>
              <Show when={shouldShowTurnProgress(props.controller.activePlan(), reviewChanges())}>
                <TurnProgress
                  changes={reviewChanges()}
                  onToggleReview={() => {
                    setWorkspaceTabs((current) =>
                      reviewOpen() ? hideWorkspaceTabs(current) : showReviewWorkspaceTab(current),
                    );
                  }}
                  plan={props.controller.activePlan()}
                  reviewOpen={reviewOpen()}
                />
              </Show>
              <ApprovalCard controller={props.controller} />
              <ModelSafetyNotice controller={props.controller} />
              <Show when={props.controller.conversationMode() !== "chat"}>
                <UsageLimitBanner controller={props.controller} />
              </Show>
              <Composer
                controller={props.controller}
                draftRequest={draftRequest()}
                onDraftConsumed={(requestId) =>
                  setDraftRequest((current) => (current?.id === requestId ? null : current))
                }
                onOpenSettings={() => openSettings()}
              />
            </div>
          </section>
          <Show
            when={
              activeSurface() === "chat" &&
              workspaceTabs().visible &&
              props.controller.currentThread() !== null
            }
          >
            <hr
              aria-label={messages().resizeWorkspace}
              aria-orientation="vertical"
              aria-valuemax={Math.round(workspaceSplitMetrics().maximumRatio * 100)}
              aria-valuemin={Math.round(workspaceSplitMetrics().minimumRatio * 100)}
              aria-valuenow={Math.round(workspaceSplitMetrics().ratio * 100)}
              aria-valuetext={formatMessage(messages().workspaceRatio, {
                chat: Math.round(workspaceSplitMetrics().ratio * 100),
                workspace: Math.round((1 - workspaceSplitMetrics().ratio) * 100),
              })}
              class="workspace-splitter"
              onDblClick={() => commitWorkspaceSplitRatio(WORKSPACE_SPLIT_DEFAULT_RATIO, true)}
              onKeyDown={handleWorkspaceSplitKeyDown}
              onLostPointerCapture={(event) => endWorkspaceSplitPointerDrag(event, false)}
              onPointerCancel={(event) => endWorkspaceSplitPointerDrag(event, true)}
              onPointerDown={handleWorkspaceSplitPointerDown}
              onPointerMove={updateWorkspaceSplitFromPointer}
              onPointerUp={(event) => endWorkspaceSplitPointerDrag(event, true)}
              ref={workspaceSplitterElement}
              tabIndex={0}
              title={messages().resizeWorkspaceTitle}
            />
          </Show>
          <Show
            keyed
            when={
              activeSurface() === "chat" && workspaceTabs().visible
                ? props.controller.currentThread()?.id
                : null
            }
          >
            {(conversationId) => (
              <Suspense fallback={null}>
                <WorkspacePanel
                  browserController={browserController}
                  changes={reviewChanges()}
                  conversationId={conversationId}
                  mode={props.controller.config()?.config.desktop.diffDisplay ?? "unified"}
                  onActivate={activateWorkspaceSurface}
                  onClose={closeWorkspaceSurface}
                  onHide={() => setWorkspaceTabs(hideWorkspaceTabs)}
                  onNewBrowserTab={openNewBrowserTab}
                  state={workspaceTabs()}
                />
              </Suspense>
            )}
          </Show>
          <Show when={activeSurface() === "automations"}>
            <Suspense fallback={null}>
              <AutomationsView
                controller={props.controller}
                onOpenSettings={() => openSettings("general")}
                onShowChat={() => setActiveSurface("chat")}
              />
            </Suspense>
          </Show>
        </div>
      </main>
      <Show when={settingsOpen()}>
        <Suspense fallback={null}>
          <SettingsDialog
            controller={props.controller}
            initialPage={settingsPage() ?? undefined}
            onClose={() => {
              setSettingsPage(null);
              setSettingsOpen(false);
            }}
          />
        </Suspense>
      </Show>
      <Show when={props.controller.error()}>
        {(message) => (
          <div class="error-toast" role="alert">
            <span>{message()}</span>
            <button
              aria-label={messages().closeError}
              onClick={props.controller.clearError}
              type="button"
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}

const SETTINGS_PAGES = new Set<SettingsPage>([
  "archived",
  "diagnostics",
  "general",
  "personalization",
  "profile",
  "shortcuts",
  "usage",
]);

function readPreviewSettingsPage(): SettingsPage | null {
  if (!import.meta.env.DEV || !isBrowserPreview()) {
    return null;
  }
  const requestedPage = new URLSearchParams(window.location.search).get("settings");
  return requestedPage !== null && SETTINGS_PAGES.has(requestedPage as SettingsPage)
    ? (requestedPage as SettingsPage)
    : null;
}

function readPreviewSurface(): "automations" | "chat" {
  if (!import.meta.env.DEV || !isBrowserPreview()) {
    return "chat";
  }
  const surface = new URLSearchParams(window.location.search).get("surface");
  return surface === "automations" ? surface : "chat";
}

function readPreviewBrowserOpen(): boolean {
  return (
    import.meta.env.DEV &&
    isBrowserPreview() &&
    new URLSearchParams(window.location.search).get("browser") === "1"
  );
}

function UsageLimitBanner(props: { readonly controller: AppController }) {
  const i18n = useI18n();
  const messages = () => i18n.messages().shell;
  const snapshot = () => props.controller.rateLimits()?.rateLimits;
  const exhausted = () => {
    const current = snapshot();
    if (current === undefined) {
      return false;
    }
    return (
      (current.primary?.usedPercent ?? 0) >= 100 ||
      current.spendControlReached === true ||
      current.rateLimitReachedType !== null
    );
  };
  const resetAt = () =>
    snapshot()?.individualLimit?.resetsAt ?? snapshot()?.primary?.resetsAt ?? null;
  return (
    <Show when={exhausted()}>
      <aside class="usage-limit-banner" role="status">
        <div class="usage-limit-copy">
          <strong>{messages().usageExhausted}</strong>
          <p>
            {formatMessage(messages().usageExhaustedDescription, {
              date: formatResetDate(resetAt(), i18n.locale(), i18n.messages().common.soon),
            })}
          </p>
        </div>
        <div class="usage-limit-actions">
          <button
            class="usage-upgrade-button"
            onClick={() => void openExternalUrl("https://chatgpt.com/membership/plans")}
            type="button"
          >
            {messages().upgradePro}
          </button>
          <button
            class="usage-credits-button"
            onClick={() => void openExternalUrl("https://chatgpt.com/settings/billing")}
            type="button"
          >
            {messages().addCredits}
          </button>
        </div>
      </aside>
    </Show>
  );
}

function formatResetDate(resetAt: number | null, locale: string, soonLabel: string): string {
  if (resetAt === null) {
    return soonLabel;
  }
  return formatShortDate(resetAt, locale, soonLabel);
}

function ModelSafetyNotice(props: { readonly controller: AppController }) {
  const i18n = useI18n();
  const messages = () => i18n.messages().shell;
  const visible = () =>
    props.controller.safetyBuffering()?.showBufferingUi === true ||
    props.controller.modelReroute() !== null ||
    props.controller.modelVerifications().length > 0;
  return (
    <Show when={visible()}>
      <aside class="model-safety-notice" role="status">
        <span class="model-safety-icon">
          <Icon name="shield" size={15} />
        </span>
        <div>
          <Show when={props.controller.safetyBuffering()?.showBufferingUi === true}>
            <strong>{messages().checkingSafety}</strong>
            <p>{messages().checkingSafetyDescription}</p>
          </Show>
          <Show when={props.controller.modelReroute()}>
            {(reroute) => (
              <>
                <strong>{messages().modelRerouted}</strong>
                <p>
                  {formatMessage(messages().modelReroutedDescription, {
                    fromModel: reroute().fromModel,
                    toModel: reroute().toModel,
                  })}
                </p>
              </>
            )}
          </Show>
          <Show when={props.controller.modelVerifications().includes("trustedAccessForCyber")}>
            <strong>{messages().additionalVerification}</strong>
            <p>{messages().additionalVerificationDescription}</p>
          </Show>
        </div>
      </aside>
    </Show>
  );
}
