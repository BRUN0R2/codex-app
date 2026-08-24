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

const AutomationsView = lazy(async () => ({
  default: (await import("./AutomationsView")).AutomationsView,
}));
const BrowserPanel = lazy(async () => ({
  default: (await import("./BrowserPanel")).BrowserPanel,
}));
const ReviewPanel = lazy(async () => ({
  default: (await import("./ReviewPanel")).ReviewPanel,
}));
const SettingsDialog = lazy(async () => ({
  default: (await import("./SettingsDialog")).SettingsDialog,
}));

export function AppShell(props: { readonly controller: AppController }) {
  const previewSettingsPage = readPreviewSettingsPage();
  const previewSurface = readPreviewSurface();
  const [settingsOpen, setSettingsOpen] = createSignal(previewSettingsPage !== null);
  const [settingsPage, setSettingsPage] = createSignal<SettingsPage | null>(previewSettingsPage);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const [reviewOpen, setReviewOpen] = createSignal(false);
  const [browserOpen, setBrowserOpen] = createSignal(readPreviewBrowserOpen());
  const [activeSurface, setActiveSurface] = createSignal<"automations" | "chat">(previewSurface);
  const reviewChangeStore = new LatestTurnFileChangeStore();
  const browserController = createBrowserController(props.controller.reportError);
  let observedBrowserAgentActivity: BrowserAgentActivityNotification | null = null;
  const reviewChanges = createMemo(() =>
    reviewChangeStore.project(props.controller.turns(), props.controller.activeTurnId()),
  );

  function openSettings(page?: SettingsPage): void {
    setBrowserOpen(false);
    setSettingsPage(page ?? null);
    setSettingsOpen(true);
  }
  const [draftRequest, setDraftRequest] = createSignal<ComposerDraftRequest | null>(null);
  let nextDraftRequestId = 0;
  let chatPageElement: HTMLElement | undefined;
  let chatDockElement: HTMLDivElement | undefined;
  let chatDockResizeObserver: ResizeObserver | undefined;
  let chatDockResizeFrame: number | undefined;
  let disposed = false;
  const eventUnlisteners: Array<() => void> = [];

  function handleKeyboardShortcut(event: KeyboardEvent): void {
    if (event.key === "Escape" && reviewOpen()) {
      event.preventDefault();
      setReviewOpen(false);
      return;
    }
    if (event.key === "Escape" && browserOpen()) {
      event.preventDefault();
      setBrowserOpen(false);
      return;
    }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "b") {
      event.preventDefault();
      if (props.controller.currentThread() !== null) {
        setReviewOpen(false);
        setBrowserOpen((value) => !value);
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
      setReviewOpen(false);
    }
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
      setBrowserOpen(false);
      return;
    }
    setSettingsPage(null);
    setSettingsOpen(false);
    setReviewOpen(false);
    setActiveSurface("chat");
    setBrowserOpen(true);
  });

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

  onMount(() => {
    browserController.start();
    window.addEventListener("keydown", handleKeyboardShortcut);
    if (chatDockElement !== undefined) {
      chatDockResizeObserver = new ResizeObserver(scheduleChatDockInset);
      chatDockResizeObserver.observe(chatDockElement);
      scheduleChatDockInset();
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
          setBrowserOpen(false);
          setReviewOpen(false);
          setActiveSurface("automations");
        }}
        onOpenWorkspace={(path) => void openWorkspace(path)}
        onOpenSettings={openSettings}
        onShowChat={() => setActiveSurface("chat")}
      />
      <main class="main-panel" inert={settingsOpen()}>
        <Show when={activeSurface() === "chat" && props.controller.product() === "chatgpt"}>
          <HomeComposerModeToggle
            mode={props.controller.chatGptMode()}
            onChange={(mode) => void props.controller.selectChatGptMode(mode)}
          />
        </Show>
        <div class="main-panel-content">
          <Show
            when={
              activeSurface() === "chat" &&
              !browserOpen() &&
              props.controller.currentThread() !== null
            }
          >
            <button
              aria-label="Abrir navegador interno"
              class="browser-panel-toggle"
              onClick={() => {
                setReviewOpen(false);
                setBrowserOpen(true);
              }}
              title="Abrir navegador interno (Ctrl+Shift+B)"
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
            <Timeline controller={props.controller} onSelectSuggestion={requestDraft} />
            <div class="chat-dock" ref={chatDockElement}>
              <Show when={shouldShowTurnProgress(props.controller.activePlan(), reviewChanges())}>
                <TurnProgress
                  changes={reviewChanges()}
                  onToggleReview={() => {
                    setBrowserOpen(false);
                    setReviewOpen((current) => !current);
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
            keyed
            when={
              activeSurface() === "chat" && browserOpen()
                ? props.controller.currentThread()?.id
                : null
            }
          >
            {(conversationId) => (
              <Suspense fallback={null}>
                <BrowserPanel
                  controller={browserController}
                  conversationId={conversationId}
                  onClose={() => setBrowserOpen(false)}
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
          <Show when={activeSurface() === "chat" && reviewOpen() && reviewChanges().length > 0}>
            <Suspense fallback={null}>
              <ReviewPanel
                changes={reviewChanges()}
                mode={props.controller.config()?.config.desktop.diffDisplay ?? "unified"}
                onClose={() => setReviewOpen(false)}
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
            <button aria-label="Fechar erro" onClick={props.controller.clearError} type="button">
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
          <strong>Você esgotou o uso do Codex e do Work</strong>
          <p>
            Adicione créditos ou faça upgrade do seu plano — ou aguarde a redefinição do uso em{" "}
            {formatResetDate(resetAt())}.
          </p>
        </div>
        <div class="usage-limit-actions">
          <button
            class="usage-upgrade-button"
            onClick={() => void openExternalUrl("https://chatgpt.com/membership/plans")}
            type="button"
          >
            Fazer upgrade para o Pro
          </button>
          <button
            class="usage-credits-button"
            onClick={() => void openExternalUrl("https://chatgpt.com/settings/billing")}
            type="button"
          >
            Adicionar créditos
          </button>
        </div>
      </aside>
    </Show>
  );
}

function formatResetDate(resetAt: number | null): string {
  if (resetAt === null) {
    return "em breve";
  }
  return formatShortDate(resetAt);
}

function ModelSafetyNotice(props: { readonly controller: AppController }) {
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
            <strong>Verificando a resposta por segurança</strong>
            <p>O servidor está concluindo uma checagem antes de finalizar este turno.</p>
          </Show>
          <Show when={props.controller.modelReroute()}>
            {(reroute) => (
              <>
                <strong>Modelo redirecionado pelo servidor</strong>
                <p>
                  Este turno foi movido de {reroute().fromModel} para {reroute().toModel} por uma
                  verificação de segurança.
                </p>
              </>
            )}
          </Show>
          <Show when={props.controller.modelVerifications().includes("trustedAccessForCyber")}>
            <strong>Verificação adicional disponível</strong>
            <p>
              O servidor recomenda solicitar acesso confiável para atividades de cibersegurança.
            </p>
          </Show>
        </div>
      </aside>
    </Show>
  );
}
