import { createSignal, onCleanup, onMount, Show } from "solid-js";

import type { AppController } from "../state/createAppController";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { Icon } from "./Icon";
import { SettingsDialog } from "./SettingsDialog";
import { Sidebar } from "./Sidebar";
import { Timeline } from "./Timeline";

export function AppShell(props: { readonly controller: AppController }) {
  const [environmentOpen, setEnvironmentOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);

  function handleKeyboardShortcut(event: KeyboardEvent): void {
    if (event.ctrlKey && event.key === ",") {
      event.preventDefault();
      setSettingsOpen(true);
    }
  }

  onMount(() => window.addEventListener("keydown", handleKeyboardShortcut));
  onCleanup(() => window.removeEventListener("keydown", handleKeyboardShortcut));

  return (
    <div
      class="app-shell"
      classList={{
        "environment-closed": !environmentOpen(),
      }}
    >
      <Sidebar
        collapsed={false}
        controller={props.controller}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main class="main-panel">
        <div class="main-panel-actions">
          <button
            aria-label="Alternar painel do ambiente"
            class="icon-button"
            classList={{ active: environmentOpen() }}
            onClick={() => setEnvironmentOpen((value) => !value)}
            title="Ambiente"
            type="button"
          >
            <Icon name="panel" size={17} />
          </button>
          <button
            aria-label="Abrir configurações"
            class="icon-button"
            onClick={() => setSettingsOpen(true)}
            title="Configurações"
            type="button"
          >
            <Icon name="settings" size={17} />
          </button>
        </div>
        <section class="chat-page">
          <Timeline controller={props.controller} />
          <ApprovalCard controller={props.controller} />
          <Composer controller={props.controller} onOpenSettings={() => setSettingsOpen(true)} />
        </section>
      </main>
      <Show when={environmentOpen()}>
        <EnvironmentPanel controller={props.controller} onClose={() => setEnvironmentOpen(false)} />
      </Show>
      <Show when={settingsOpen()}>
        <SettingsDialog controller={props.controller} onClose={() => setSettingsOpen(false)} />
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

function EnvironmentPanel(props: {
  readonly controller: AppController;
  readonly onClose: () => void;
}) {
  const usage = () => props.controller.rateLimits()?.rateLimits.primary;
  const permission = () => props.controller.config()?.config.permissionProfile;
  return (
    <aside class="environment-panel">
      <header>
        <div>
          <p class="eyebrow">Contexto atual</p>
          <h2>Ambiente</h2>
        </div>
        <button
          aria-label="Fechar ambiente"
          class="icon-button"
          onClick={props.onClose}
          type="button"
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <section>
        <h3>
          <Icon name="folder" size={15} /> Projeto
        </h3>
        <Show
          when={props.controller.workspace()}
          fallback={<p class="muted">Nenhum projeto selecionado.</p>}
        >
          {(workspace) => <code class="workspace-path">{workspace()}</code>}
        </Show>
        <button
          class="secondary-button compact"
          onClick={() => void props.controller.chooseWorkspace()}
          type="button"
        >
          Trocar projeto
        </button>
      </section>
      <section>
        <h3>
          <Icon name="shield" size={15} /> Permissões
        </h3>
        <strong>{permissionTitle(permission()?.sandbox)}</strong>
        <p class="muted">
          {permission()?.sandbox ?? "carregando"} · {permission()?.approvals ?? "—"}
        </p>
      </section>
      <section>
        <h3>
          <Icon name="bot" size={15} /> Modelo
        </h3>
        <strong>{currentModelName(props.controller)}</strong>
        <p class="muted">
          {props.controller.config()?.config.modelReasoningEffort ?? "esforço automático"}
        </p>
      </section>
      <section>
        <div class="environment-section-title">
          <h3>
            <Icon name="terminal" size={15} /> Uso
          </h3>
          <button onClick={() => void props.controller.refreshRateLimits()} type="button">
            Atualizar
          </button>
        </div>
        <Show when={usage()} fallback={<p class="muted">Uso indisponível.</p>}>
          {(window) => (
            <>
              <progress class="usage-meter" max={100} value={window().usedPercent}>
                {window().usedPercent}%
              </progress>
              <p class="usage-copy">
                <strong>{Math.round(window().usedPercent)}%</strong> utilizado
              </p>
            </>
          )}
        </Show>
      </section>
      <footer>
        <span class="native-badge">
          <i /> Nativo
        </span>
        <small>HTTPS/SSE · SQLite · OAuth</small>
      </footer>
    </aside>
  );
}

function permissionTitle(mode: string | undefined): string {
  switch (mode) {
    case "read-only":
      return "Somente leitura";
    case "workspace-write":
      return "Acesso ao projeto";
    case "danger-full-access":
      return "Acesso completo";
    default:
      return "Carregando";
  }
}

function currentModelName(controller: AppController): string {
  const configured = controller.config()?.config.model;
  return (
    controller.models().find((model) => model.id === configured)?.displayName ??
    controller.models().find((model) => model.isDefault)?.displayName ??
    "Carregando"
  );
}
