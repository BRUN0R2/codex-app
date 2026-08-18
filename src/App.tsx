import { ErrorBoundary, Match, Show, Switch } from "solid-js";

import { shouldRenderWindowChrome } from "./platform/DesktopRuntime";
import { createAppController } from "./state/createAppController";
import { AppShell } from "./ui/AppShell";
import { CodexGlyph } from "./ui/CodexGlyph";
import { ImageViewerProvider } from "./ui/ImageViewer";
import { LoginScreen } from "./ui/LoginScreen";
import { ApplicationRenderFailure } from "./ui/RenderFailure";
import { WindowChrome } from "./ui/WindowChrome";

export default function App() {
  const controller = createAppController();
  const showWindowChrome = shouldRenderWindowChrome();

  return (
    <div class="application-frame" classList={{ "with-window-chrome": showWindowChrome }}>
      <Show when={showWindowChrome}>
        <WindowChrome onError={controller.reportError} />
      </Show>
      <div class="application-frame-content">
        <Switch>
          <Match
            when={controller.runtimeStatus().state === "failed" && controller.engine() === null}
          >
            <main class="boot-screen error-state">
              <div class="boot-card">
                <span aria-hidden="true" class="brand-mark large">
                  <CodexGlyph size={30} />
                </span>
                <p class="eyebrow">Falha de inicialização</p>
                <h1>O engine nativo não iniciou</h1>
                <p>
                  {controller.runtimeStatus().message ??
                    controller.error() ??
                    "Falha sem diagnóstico."}
                </p>
                <button
                  class="primary-button"
                  onClick={() => controller.retryInitialization()}
                  type="button"
                >
                  Tentar novamente
                </button>
              </div>
            </main>
          </Match>
          <Match when={controller.engine() === null || controller.account() === undefined}>
            <main class="boot-screen">
              <div class="boot-loader">
                <span aria-hidden="true" class="brand-mark large">
                  <CodexGlyph size={30} />
                </span>
                <i />
                <p>Inicializando o engine nativo…</p>
              </div>
            </main>
          </Match>
          <Match when={!controller.signedIn()}>
            <LoginScreen controller={controller} />
          </Match>
          <Match when={controller.signedIn()}>
            <ErrorBoundary
              fallback={(error) => (
                <ApplicationRenderFailure
                  error={error}
                  onReport={controller.reportError}
                  onReload={() => window.location.reload()}
                />
              )}
            >
              <ImageViewerProvider>
                <AppShell controller={controller} />
              </ImageViewerProvider>
            </ErrorBoundary>
          </Match>
        </Switch>
      </div>
    </div>
  );
}
