import { createEffect, ErrorBoundary, Match, Show, Switch } from "solid-js";
import { createI18nController, I18nProvider, useI18n } from "./i18n/context";
import { synchronizeApplicationMenu } from "./infrastructure/desktopClient";
import { isDesktopRuntime, shouldRenderWindowChrome } from "./platform/desktopRuntime";
import { createAppController } from "./state/createAppController";
import { AppShell } from "./ui/AppShell";
import { CodexGlyph } from "./ui/CodexGlyph";
import { ImageViewerProvider } from "./ui/ImageViewer";
import { LoginScreen } from "./ui/LoginScreen";
import { ApplicationRenderFailure } from "./ui/RenderFailure";
import { WindowChrome } from "./ui/WindowChrome";

export default function App() {
  const i18n = createI18nController();

  return (
    <I18nProvider controller={i18n}>
      <Application />
    </I18nProvider>
  );
}

function Application() {
  const i18n = useI18n();
  const controller = createAppController({
    confirmations: () => i18n.messages().confirmations,
  });
  const desktopRuntime = isDesktopRuntime();
  const showWindowChrome = shouldRenderWindowChrome();

  createEffect(() => {
    if (!desktopRuntime) return;
    const translation = i18n.messages().nativeMenu;
    void synchronizeApplicationMenu(translation).catch((reason: unknown) => {
      controller.reportError(reason);
    });
  });

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
                <p class="eyebrow">{i18n.messages().app.initializationEyebrow}</p>
                <h1>{i18n.messages().app.initializationTitle}</h1>
                <p>
                  {controller.runtimeStatus().message ??
                    controller.error() ??
                    i18n.messages().app.missingDiagnostic}
                </p>
                <button
                  class="primary-button"
                  onClick={() => controller.retryInitialization()}
                  type="button"
                >
                  {i18n.messages().app.retry}
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
                <p>{i18n.messages().app.initializing}</p>
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
