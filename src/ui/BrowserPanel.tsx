import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { BrowserActionMetric } from "../contracts/types";
import { openExternalUrl } from "../infrastructure/codexClient";
import { isBrowserPreview } from "../platform/desktopRuntime";
import type { BrowserController } from "../state/browserController";
import {
  BROWSER_VIEWPORT_SCALES,
  browserViewportPreset,
  initialBrowserViewport,
  MAX_BROWSER_VIEWPORT_HEIGHT,
  MAX_BROWSER_VIEWPORT_WIDTH,
  MIN_BROWSER_VIEWPORT_HEIGHT,
  MIN_BROWSER_VIEWPORT_WIDTH,
  parseBrowserViewport,
  STANDARD_BROWSER_VIEWPORTS,
} from "./browserViewport";
import { Icon } from "./Icon";

export function BrowserPanel(props: {
  readonly controller: BrowserController;
  readonly conversationId: string;
}) {
  let surfaceElement: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let synchronizationFrame: number | undefined;
  let lastSurfaceSignature: string | null = null;
  let addressFocused = false;
  let disposed = false;
  const [address, setAddress] = createSignal("");
  const [debugOpen, setDebugOpen] = createSignal(false);
  const [viewportWidth, setViewportWidth] = createSignal("");
  const [viewportHeight, setViewportHeight] = createSignal("");
  const [viewportScale, setViewportScale] = createSignal(1);
  const [viewportError, setViewportError] = createSignal<string | null>(null);
  const activeTab = createMemo(() => props.controller.activeTab(props.conversationId));
  const responsiveViewport = createMemo(() => activeTab()?.viewport ?? null);
  const metrics = createMemo(() => props.controller.metrics(props.conversationId));

  createEffect(() => {
    const current = activeTab();
    if (!addressFocused) {
      setAddress(current?.url === "about:blank" ? "" : (current?.url ?? ""));
    }
    if (current?.viewport !== null && current?.viewport !== undefined) {
      setViewportWidth(String(current.viewport.width));
      setViewportHeight(String(current.viewport.height));
      setViewportScale(current.viewport.scale);
    }
    scheduleSurfaceSynchronization();
  });

  createEffect(() => {
    const conversationId = props.conversationId;
    void props.controller.ensureConversation(conversationId).then(() => {
      if (!disposed && props.conversationId === conversationId) {
        scheduleSurfaceSynchronization();
      }
    });
  });

  createEffect(() => {
    debugOpen();
    scheduleSurfaceSynchronization();
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

  function applyViewport(width: string, height: string, scale: number): void {
    const result = parseBrowserViewport(width, height, scale);
    if (!result.ok) {
      setViewportError(result.message);
      return;
    }
    setViewportWidth(String(result.viewport.width));
    setViewportHeight(String(result.viewport.height));
    setViewportScale(result.viewport.scale);
    setViewportError(null);
    void props.controller.setViewport(props.conversationId, result.viewport);
  }

  function submitViewport(event: SubmitEvent): void {
    event.preventDefault();
    applyViewport(viewportWidth(), viewportHeight(), viewportScale());
  }

  function toggleResponsiveViewport(): void {
    if (responsiveViewport() !== null) {
      setViewportError(null);
      void props.controller.setViewport(props.conversationId, null);
      return;
    }
    const bounds = surfaceElement?.getBoundingClientRect();
    const viewport = initialBrowserViewport(bounds?.width ?? 1_280, bounds?.height ?? 720);
    applyViewport(String(viewport.width), String(viewport.height), viewport.scale);
  }

  onMount(() => {
    if (surfaceElement !== undefined) {
      resizeObserver = new ResizeObserver(scheduleSurfaceSynchronization);
      resizeObserver.observe(surfaceElement);
    }
    scheduleSurfaceSynchronization();
  });

  onCleanup(() => {
    disposed = true;
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
    <section aria-label="Navegador interno" class="browser-panel">
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
          aria-label="Alternar viewport responsivo"
          aria-pressed={responsiveViewport() !== null}
          class="browser-toolbar-button"
          classList={{ active: responsiveViewport() !== null }}
          onClick={toggleResponsiveViewport}
          title="Viewport responsivo"
          type="button"
        >
          <Icon name="monitor" size={14} />
        </button>
        <button
          aria-pressed={debugOpen()}
          aria-label="Alternar diagnóstico do navegador"
          class="browser-toolbar-button"
          classList={{ active: debugOpen() }}
          onClick={() => setDebugOpen((value) => !value)}
          title="Diagnóstico e métricas"
          type="button"
        >
          <Icon name="bug" size={14} />
        </button>
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
      <Show when={responsiveViewport() !== null}>
        <form
          aria-label="Configuração do viewport responsivo"
          class="browser-responsive-toolbar"
          onSubmit={submitViewport}
        >
          <strong>Dimensões:</strong>
          <select
            aria-label="Resolução padrão"
            onChange={(event) => {
              const preset = browserViewportPreset(event.currentTarget.value);
              if (preset !== null) {
                applyViewport(String(preset.width), String(preset.height), viewportScale());
                event.currentTarget.value = "";
              }
            }}
            value=""
          >
            <option value="">Responsivo</option>
            <For each={STANDARD_BROWSER_VIEWPORTS}>
              {(preset) => <option value={preset.id}>{preset.label}</option>}
            </For>
          </select>
          <input
            aria-label="Largura do viewport"
            inputmode="numeric"
            max={MAX_BROWSER_VIEWPORT_WIDTH}
            min={MIN_BROWSER_VIEWPORT_WIDTH}
            onChange={() => applyViewport(viewportWidth(), viewportHeight(), viewportScale())}
            onInput={(event) => setViewportWidth(event.currentTarget.value)}
            type="number"
            value={viewportWidth()}
          />
          <span aria-hidden="true">×</span>
          <input
            aria-label="Altura do viewport"
            inputmode="numeric"
            max={MAX_BROWSER_VIEWPORT_HEIGHT}
            min={MIN_BROWSER_VIEWPORT_HEIGHT}
            onChange={() => applyViewport(viewportWidth(), viewportHeight(), viewportScale())}
            onInput={(event) => setViewportHeight(event.currentTarget.value)}
            type="number"
            value={viewportHeight()}
          />
          <button
            aria-label="Inverter largura e altura"
            class="browser-responsive-button"
            onClick={() => applyViewport(viewportHeight(), viewportWidth(), viewportScale())}
            title="Girar viewport"
            type="button"
          >
            <Icon name="reset" size={14} />
          </button>
          <select
            aria-label="Escala do viewport"
            onChange={(event) =>
              applyViewport(viewportWidth(), viewportHeight(), Number(event.currentTarget.value))
            }
            value={viewportScale()}
          >
            <For each={BROWSER_VIEWPORT_SCALES}>
              {(scale) => <option value={scale}>{Math.round(scale * 100)}%</option>}
            </For>
          </select>
          <Show when={viewportError()}>
            {(message) => (
              <span class="browser-responsive-error" role="alert">
                {message()}
              </span>
            )}
          </Show>
          <span aria-hidden="true" class="browser-responsive-spacer" />
          <button
            aria-label="Redefinir viewport responsivo"
            class="browser-responsive-button"
            onClick={toggleResponsiveViewport}
            title="Usar viewport da janela"
            type="button"
          >
            <Icon name="close" size={14} />
          </button>
        </form>
      </Show>
      <Show when={debugOpen()}>
        <BrowserDebugPanel metrics={metrics()} />
      </Show>
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
            <Show when={responsiveViewport()}>
              {(viewport) => (
                <small>
                  {viewport().width} × {viewport().height} · {Math.round(viewport().scale * 100)}%
                </small>
              )}
            </Show>
          </div>
        </Show>
      </section>
    </section>
  );
}

function BrowserDebugPanel(props: { readonly metrics: readonly BrowserActionMetric[] }) {
  const recent = createMemo(() => props.metrics.slice(-20));
  const latest = createMemo(() => recent().at(-1) ?? null);
  const latestPage = createMemo(
    () => [...recent()].reverse().find((metric) => metric.page !== null)?.page ?? null,
  );
  const averageTotal = createMemo(() => average(recent().map((metric) => metric.totalMs)));
  const p95Total = createMemo(() =>
    percentile(
      recent().map((metric) => metric.totalMs),
      0.95,
    ),
  );
  const failures = createMemo(() => recent().filter((metric) => metric.status === "failed").length);

  return (
    <section aria-label="Diagnóstico do navegador" class="browser-debug-panel">
      <header>
        <div>
          <strong>Diagnóstico</strong>
          <span>{recent().length} ações recentes</span>
        </div>
        <small>Persistido em browser-actions.jsonl</small>
      </header>
      <div class="browser-debug-summary">
        <BrowserDebugValue label="Média" value={formatMilliseconds(averageTotal())} />
        <BrowserDebugValue label="p95" value={formatMilliseconds(p95Total())} />
        <BrowserDebugValue label="Falhas" value={String(failures())} />
        <BrowserDebugValue
          label="Última captura"
          value={formatBytes(latest()?.screenshotBytes ?? null)}
        />
      </div>
      <Show
        fallback={
          <p class="browser-debug-empty">As métricas aparecem quando o agente usa o navegador.</p>
        }
        when={latest()}
      >
        {(metric) => (
          <>
            <div class="browser-debug-stages">
              <span>fila {formatMilliseconds(metric().queueMs)}</span>
              <span>ação {formatMilliseconds(metric().actionMs)}</span>
              <span>carga {formatMilliseconds(metric().loadMs)}</span>
              <span>snapshot {formatMilliseconds(metric().snapshotMs)}</span>
              <span>captura {formatMilliseconds(metric().screenshotMs)}</span>
            </div>
            <Show when={latestPage()}>
              {(page) => (
                <div class="browser-debug-findings">
                  <span>console {page().consoleErrors}</span>
                  <span>página {page().pageErrors}</span>
                  <span>recursos {page().resourceFailures}</span>
                  <span>overflow {Math.round(page().horizontalOverflowPx)} px</span>
                  <span>sem rótulo {page().unlabeledControls}</span>
                  <span>CLS {page().cumulativeLayoutShift.toFixed(3)}</span>
                  <span>
                    LCP{" "}
                    {page().largestContentfulPaintMs === null
                      ? "—"
                      : formatMilliseconds(page().largestContentfulPaintMs)}
                  </span>
                </div>
              )}
            </Show>
            <Show when={metric().error}>
              {(error) => <p class="browser-debug-error">{error()}</p>}
            </Show>
          </>
        )}
      </Show>
      <div class="browser-debug-history">
        <For each={[...recent()].reverse().slice(0, 6)}>
          {(metric) => (
            <div class="browser-debug-row" data-status={metric.status}>
              <span>{metric.action.replaceAll("_", " ")}</span>
              <code>{formatMilliseconds(metric.totalMs)}</code>
            </div>
          )}
        </For>
      </div>
    </section>
  );
}

function BrowserDebugValue(props: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? null;
}

function formatMilliseconds(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} ms`;
}

function formatBytes(value: number | null): string {
  if (value === null) {
    return "—";
  }
  if (value < 1_024) {
    return `${value} B`;
  }
  return `${(value / 1_024).toFixed(value < 10_240 ? 1 : 0)} KiB`;
}
