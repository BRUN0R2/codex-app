import { getCurrentWindow } from "@tauri-apps/api/window";
import { createSignal, onCleanup, onMount } from "solid-js";

import { isBrowserPreview, isDesktopRuntime } from "../platform/DesktopRuntime";

interface WindowChromeProps {
  readonly onError?: ((reason: unknown) => void) | undefined;
}

interface WindowChromeLayoutProps {
  readonly interactive: boolean;
  readonly maximized: boolean;
  readonly onClose?: () => void;
  readonly onMinimize?: () => void;
  readonly onToggleMaximize?: () => void;
  readonly setControlsReference?: (element: HTMLDivElement) => void;
}

export function WindowChrome(props: WindowChromeProps) {
  if (isDesktopRuntime()) {
    return <DesktopWindowChrome onError={props.onError} />;
  }
  if (isBrowserPreview()) {
    return <WindowChromeLayout interactive={false} maximized={false} />;
  }
  return null;
}

function DesktopWindowChrome(props: WindowChromeProps) {
  const appWindow = getCurrentWindow();
  const [maximized, setMaximized] = createSignal(false);
  let controlsReference: HTMLDivElement | undefined;
  let hoverResetFrame: number | undefined;
  let resizeFrame: number | undefined;
  let unlistenFocusChanged: (() => void) | undefined;
  let disposed = false;

  function reportControlFailure(operation: string, reason: unknown): void {
    const detail = reason instanceof Error ? reason.message : String(reason);
    props.onError?.(new Error(`Não foi possível ${operation}: ${detail}`));
  }

  async function synchronizeMaximizedState(): Promise<void> {
    try {
      const nextMaximized = await appWindow.isMaximized();
      if (!disposed) {
        setMaximized(nextMaximized);
      }
    } catch (reason: unknown) {
      reportControlFailure("consultar o estado da janela", reason);
    }
  }

  function scheduleMaximizedStateSynchronization(): void {
    if (resizeFrame !== undefined) {
      return;
    }
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = undefined;
      void synchronizeMaximizedState();
    });
  }

  function suppressControlHover(): void {
    if (controlsReference === undefined) {
      return;
    }
    controlsReference.setAttribute("data-suppress-hover", "true");
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && controlsReference.contains(activeElement)) {
      activeElement.blur();
    }
  }

  function scheduleControlHoverRestoration(): void {
    const controls = controlsReference;
    if (controls === undefined) {
      return;
    }
    if (hoverResetFrame !== undefined) {
      window.cancelAnimationFrame(hoverResetFrame);
    }
    hoverResetFrame = window.requestAnimationFrame(() => {
      hoverResetFrame = window.requestAnimationFrame(() => {
        hoverResetFrame = undefined;
        if (!disposed) {
          controls.removeAttribute("data-suppress-hover");
        }
      });
    });
  }

  function clearStuckControlHover(): void {
    suppressControlHover();
    scheduleControlHoverRestoration();
  }

  function runControlAction(
    operation: string,
    action: () => Promise<void>,
    refreshMaximizedState = false,
  ): void {
    suppressControlHover();
    void action()
      .then(() => {
        if (refreshMaximizedState) {
          return synchronizeMaximizedState();
        }
        return undefined;
      })
      .catch((reason: unknown) => reportControlFailure(operation, reason))
      .finally(scheduleControlHoverRestoration);
  }

  onMount(() => {
    void synchronizeMaximizedState();
    window.addEventListener("resize", scheduleMaximizedStateSynchronization);
    void appWindow
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          clearStuckControlHover();
        }
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenFocusChanged = unlisten;
        }
      })
      .catch((reason: unknown) => reportControlFailure("acompanhar o foco da janela", reason));
  });

  onCleanup(() => {
    disposed = true;
    unlistenFocusChanged?.();
    window.removeEventListener("resize", scheduleMaximizedStateSynchronization);
    if (hoverResetFrame !== undefined) {
      window.cancelAnimationFrame(hoverResetFrame);
    }
    if (resizeFrame !== undefined) {
      window.cancelAnimationFrame(resizeFrame);
    }
  });

  return (
    <WindowChromeLayout
      interactive={true}
      maximized={maximized()}
      onClose={() => runControlAction("fechar a janela", () => appWindow.close())}
      onMinimize={() => runControlAction("minimizar a janela", () => appWindow.minimize())}
      onToggleMaximize={() =>
        runControlAction(
          maximized() ? "restaurar a janela" : "maximizar a janela",
          () => appWindow.toggleMaximize(),
          true,
        )
      }
      setControlsReference={(element) => {
        controlsReference = element;
      }}
    />
  );
}

function WindowChromeLayout(props: WindowChromeLayoutProps) {
  const maximizeLabel = () => (props.maximized ? "Restaurar janela" : "Maximizar janela");

  return (
    <header class="window-chrome" classList={{ preview: !props.interactive }}>
      <button
        aria-label="Barra de título da janela"
        class="window-chrome-drag-region"
        data-tauri-drag-region={props.interactive ? "" : undefined}
        onDblClick={props.onToggleMaximize}
        tabIndex={-1}
        type="button"
      ></button>
      <div
        aria-hidden={props.interactive ? undefined : "true"}
        class="window-chrome-controls"
        ref={props.setControlsReference}
      >
        <button
          aria-label="Minimizar janela"
          onClick={props.onMinimize}
          tabIndex={props.interactive ? 0 : -1}
          title="Minimizar"
          type="button"
        >
          <WindowChromeMinimizeIcon />
        </button>
        <button
          aria-label={maximizeLabel()}
          onClick={props.onToggleMaximize}
          tabIndex={props.interactive ? 0 : -1}
          title={maximizeLabel()}
          type="button"
        >
          {props.maximized ? <WindowChromeRestoreIcon /> : <WindowChromeMaximizeIcon />}
        </button>
        <button
          aria-label="Fechar janela"
          class="window-chrome-close"
          onClick={props.onClose}
          tabIndex={props.interactive ? 0 : -1}
          title="Fechar"
          type="button"
        >
          <WindowChromeCloseIcon />
        </button>
      </div>
    </header>
  );
}

function WindowChromeMinimizeIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="17"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.7"
      viewBox="0 0 24 24"
      width="17"
    >
      <path d="M5 12h14" />
    </svg>
  );
}

function WindowChromeMaximizeIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="13"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.7"
      viewBox="0 0 24 24"
      width="13"
    >
      <rect height="14" rx="1" width="14" x="5" y="5" />
    </svg>
  );
}

function WindowChromeRestoreIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="14"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.6"
      viewBox="0 0 24 24"
      width="14"
    >
      <path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h9A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H17" />
      <rect height="12" rx="1.5" width="12" x="4" y="8" />
    </svg>
  );
}

function WindowChromeCloseIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="18"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.7"
      viewBox="0 0 24 24"
      width="18"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
