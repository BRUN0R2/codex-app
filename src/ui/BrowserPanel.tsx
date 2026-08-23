import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { openExternalUrl } from "../infrastructure/codexClient";
import { isBrowserPreview } from "../platform/DesktopRuntime";
import type { BrowserController } from "../state/browserController";
import { Icon } from "./Icon";

export function BrowserPanel(props: {
  readonly controller: BrowserController;
  readonly conversationId: string;
  readonly onClose: () => void;
}) {
  let surfaceElement: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let synchronizationFrame: number | undefined;
  let lastSurfaceSignature: string | null = null;
  let addressFocused = false;
  const [address, setAddress] = createSignal("");
  const activeTab = createMemo(() => props.controller.activeTab(props.conversationId));
  const tabs = createMemo(() => props.controller.tabs(props.conversationId));

  createEffect(() => {
    const current = activeTab();
    if (!addressFocused) {
      setAddress(current?.url === "about:blank" ? "" : (current?.url ?? ""));
    }
    scheduleSurfaceSynchronization();
  });

  createEffect(() => {
    const conversationId = props.conversationId;
    void props.controller.ensureConversation(conversationId).then(() => {
      if (props.conversationId === conversationId) {
        scheduleSurfaceSynchronization();
      }
    });
  });

  function scheduleSurfaceSynchronization(): void {
    if (synchronizationFrame !== undefined) {
      return;
    }
    synchronizationFrame = requestAnimationFrame(() => {
      synchronizationFrame = undefined;
      const selected = activeTab();
      if (surfaceElement === undefined || selected === null) {
        void props.controller.synchronizeSurface({
          bounds: null,
          conversationId: props.conversationId,
          visible: false,
        });
        return;
      }
      const rect = surfaceElement.getBoundingClientRect();
      const bounds = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      const signature = [
        props.conversationId,
        selected.browserTabId,
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
      ].join(":");
      if (signature === lastSurfaceSignature) {
        return;
      }
      lastSurfaceSignature = signature;
      void props.controller.synchronizeSurface({
        bounds,
        conversationId: props.conversationId,
        visible: true,
      });
    });
  }

  function submitAddress(event: SubmitEvent): void {
    event.preventDefault();
    void props.controller.navigate(props.conversationId, address());
  }

  onMount(() => {
    if (surfaceElement !== undefined) {
      resizeObserver = new ResizeObserver(scheduleSurfaceSynchronization);
      resizeObserver.observe(surfaceElement);
    }
    scheduleSurfaceSynchronization();
  });

  onCleanup(() => {
    resizeObserver?.disconnect();
    if (synchronizationFrame !== undefined) {
      cancelAnimationFrame(synchronizationFrame);
    }
    void props.controller.synchronizeSurface({
      bounds: null,
      conversationId: props.conversationId,
      visible: false,
    });
  });

  return (
    <aside aria-label="Navegador interno" class="browser-panel">
      <div aria-label="Abas do navegador" class="browser-tab-strip" role="tablist">
        <div class="browser-tabs-scroll">
          <For each={tabs()}>
            {(tab) => (
              <div
                class="browser-tab"
                classList={{ active: activeTab()?.browserTabId === tab.browserTabId }}
                role="presentation"
              >
                <button
                  aria-selected={activeTab()?.browserTabId === tab.browserTabId}
                  class="browser-tab-select"
                  onClick={() =>
                    void props.controller.selectTab(props.conversationId, tab.browserTabId)
                  }
                  role="tab"
                  title={tab.title ?? tab.url}
                  type="button"
                >
                  <Icon name="globe" size={12} />
                  <span>{browserTabLabel(tab.title, tab.url)}</span>
                </button>
                <button
                  aria-label={`Fechar ${browserTabLabel(tab.title, tab.url)}`}
                  class="browser-tab-close"
                  onClick={() =>
                    void props.controller.closeTab(props.conversationId, tab.browserTabId)
                  }
                  type="button"
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
            )}
          </For>
        </div>
        <button
          aria-label="Nova aba"
          class="browser-toolbar-button"
          onClick={() => void props.controller.newTab(props.conversationId)}
          type="button"
        >
          <Icon name="plus" size={14} />
        </button>
        <button
          aria-label="Fechar navegador"
          class="browser-toolbar-button"
          onClick={props.onClose}
          type="button"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <div class="browser-toolbar">
        <button
          aria-label="Voltar"
          class="browser-toolbar-button"
          disabled={activeTab()?.canGoBack !== true}
          onClick={() => void props.controller.back(props.conversationId)}
          type="button"
        >
          <Icon name="arrowLeft" size={15} />
        </button>
        <button
          aria-label="Avançar"
          class="browser-toolbar-button browser-forward-button"
          disabled={activeTab()?.canGoForward !== true}
          onClick={() => void props.controller.forward(props.conversationId)}
          type="button"
        >
          <Icon name="arrowLeft" size={15} />
        </button>
        <button
          aria-label="Recarregar"
          class="browser-toolbar-button"
          onClick={() => void props.controller.reload(props.conversationId)}
          type="button"
        >
          <Icon name="reset" size={14} />
        </button>
        <form aria-label="Barra de endereço" class="browser-address" onSubmit={submitAddress}>
          <Icon name="globe" size={13} />
          <input
            aria-label="Pesquisar ou digitar endereço"
            onBlur={() => {
              addressFocused = false;
            }}
            onFocus={() => {
              addressFocused = true;
            }}
            onInput={(event) => setAddress(event.currentTarget.value)}
            placeholder="Pesquisar ou digitar endereço"
            spellcheck={false}
            value={address()}
          />
          <Show when={activeTab()?.isLoading === true}>
            <span aria-label="Carregando" class="browser-loading-indicator" role="status" />
          </Show>
        </form>
        <button
          aria-label="Abrir no navegador padrão"
          class="browser-toolbar-button"
          disabled={activeTab() === null || activeTab()?.url === "about:blank"}
          onClick={() => {
            const url = activeTab()?.url;
            if (url !== undefined) {
              void openExternalUrl(url);
            }
          }}
          type="button"
        >
          <Icon name="externalLink" size={14} />
        </button>
      </div>
      <section
        aria-label="Conteúdo do navegador"
        class="browser-native-surface"
        ref={surfaceElement}
      >
        <Show when={isBrowserPreview()}>
          <div class="browser-preview-page">
            <Icon name="globeStand" size={34} />
            <strong>Navegador interno</strong>
            <span>{activeTab()?.url === "about:blank" ? "Nova aba" : activeTab()?.url}</span>
          </div>
        </Show>
      </section>
    </aside>
  );
}

function browserTabLabel(title: string | null, url: string): string {
  if (title !== null && title.trim().length > 0) {
    return title;
  }
  if (url === "about:blank") {
    return "Nova aba";
  }
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}
