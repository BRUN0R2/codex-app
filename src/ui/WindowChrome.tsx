import { getCurrentWindow } from "@tauri-apps/api/window";
import { onCleanup, onMount } from "solid-js";
import { isDesktopRuntime } from "../platform/DesktopRuntime";

export function WindowChrome() {
  if (!isDesktopRuntime()) {
    return null;
  }

  return <DesktopWindowChrome />;
}

function DesktopWindowChrome() {
  const appWindow = getCurrentWindow();
  let controlsReference: HTMLDivElement | undefined;

  onMount(() => {
    let isCurrent = true;
    let unlistenFocus: (() => void) | undefined;

    function clearStuckHover(): void {
      const controls = controlsReference;

      if (controls === undefined) {
        return;
      }

      // biome-ignore lint/complexity/useLiteralKeys: TypeScript index signature access
      controls.dataset["suppressHover"] = "true";

      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }

      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (isCurrent) {
            // biome-ignore lint/complexity/useLiteralKeys: TypeScript index signature access
            delete controls.dataset["suppressHover"];
          }
        });
      });
    }

    void appWindow
      .onFocusChanged(({ payload: isFocused }) => {
        if (isFocused) {
          clearStuckHover();
        }
      })
      .then((unlisten) => {
        if (isCurrent) {
          unlistenFocus = unlisten;
        } else {
          unlisten();
        }
      });
    onCleanup(() => {
      isCurrent = false;
      unlistenFocus?.();
    });
  });

  function runControlAction(action: Promise<void>): void {
    const controls = controlsReference;

    if (controls !== undefined) {
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript index signature access
      controls.dataset["suppressHover"] = "true";

      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    }

    void action.finally(() => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (controls !== undefined) {
            // biome-ignore lint/complexity/useLiteralKeys: TypeScript index signature access
            delete controls.dataset["suppressHover"];
          }
        });
      });
    });
  }

  return (
    <div class="window-chrome">
      <button
        aria-label="Área de arrasto da janela"
        class="window-chrome-drag-region"
        data-tauri-drag-region
        onDblClick={() => runControlAction(appWindow.toggleMaximize())}
        tabIndex={-1}
        type="button"
      />
      <div class="window-chrome-controls" ref={controlsReference}>
        <button
          aria-label="Minimizar janela"
          type="button"
          onClick={() => runControlAction(appWindow.minimize())}
        >
          <WindowChromeMinimizeIcon />
        </button>
        <button
          aria-label="Maximizar ou restaurar janela"
          type="button"
          onClick={() => runControlAction(appWindow.toggleMaximize())}
        >
          <WindowChromeMaximizeIcon />
        </button>
        <button
          aria-label="Fechar janela"
          class="window-chrome-close"
          type="button"
          onClick={() => runControlAction(appWindow.close())}
        >
          <WindowChromeCloseIcon />
        </button>
      </div>
    </div>
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
