import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

import type { AppController } from "../state/createAppController";
import { projectName } from "../state/projects";
import { ApprovalCard } from "./ApprovalCard";
import { Composer, type ComposerDraftRequest } from "./Composer";
import { Icon } from "./Icon";
import { SettingsDialog } from "./SettingsDialog";
import { Sidebar } from "./Sidebar";
import { Timeline } from "./Timeline";

export function AppShell(props: { readonly controller: AppController }) {
  const [environmentOpen, setEnvironmentOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [draftRequest, setDraftRequest] = createSignal<ComposerDraftRequest | null>(null);
  let nextDraftRequestId = 0;
  let appShellElement: HTMLDivElement | undefined;
  let chatPageElement: HTMLElement | undefined;
  let chatDockElement: HTMLDivElement | undefined;
  let chatDockResizeObserver: ResizeObserver | undefined;

  function handleKeyboardShortcut(event: KeyboardEvent): void {
    if (event.ctrlKey && event.key === ",") {
      event.preventDefault();
      setSettingsOpen(true);
      return;
    }
    if (event.key === "Escape" && environmentOpen()) {
      setEnvironmentOpen(false);
    }
  }

  function requestDraft(text: string): void {
    nextDraftRequestId += 1;
    setDraftRequest({ id: nextDraftRequestId, text });
  }

  function dismissToolbarMenus(event: PointerEvent): void {
    if (!(event.target instanceof Node)) {
      return;
    }
    const menus = appShellElement?.querySelectorAll<HTMLDetailsElement>(
      ".open-workspace-menu[open], .task-header-menu[open]",
    );
    for (const menu of menus ?? []) {
      if (!menu.contains(event.target)) {
        menu.open = false;
      }
    }
  }

  function synchronizeChatDockInset(): void {
    if (chatPageElement === undefined || chatDockElement === undefined) {
      return;
    }
    const dockHeight = Math.ceil(chatDockElement.getBoundingClientRect().height);
    chatPageElement.style.setProperty("--chat-dock-height", `${dockHeight}px`);
  }

  onMount(() => {
    window.addEventListener("keydown", handleKeyboardShortcut);
    document.addEventListener("pointerdown", dismissToolbarMenus);
    if (chatDockElement !== undefined) {
      chatDockResizeObserver = new ResizeObserver(synchronizeChatDockInset);
      chatDockResizeObserver.observe(chatDockElement);
      synchronizeChatDockInset();
    }
  });
  onCleanup(() => {
    window.removeEventListener("keydown", handleKeyboardShortcut);
    document.removeEventListener("pointerdown", dismissToolbarMenus);
    chatDockResizeObserver?.disconnect();
  });

  return (
    <div
      class="app-shell"
      classList={{ "environment-open": environmentOpen() }}
      ref={appShellElement}
    >
      <Sidebar
        collapsed={false}
        controller={props.controller}
        inert={settingsOpen()}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main class="main-panel" inert={settingsOpen()}>
        <header class="main-toolbar">
          <TaskHeader controller={props.controller} />
          <div class="main-panel-actions">
            <Show when={props.controller.workspace()}>
              <OpenWorkspaceMenu
                controller={props.controller}
                onOpenEnvironment={() => setEnvironmentOpen(true)}
              />
            </Show>
            <button
              aria-controls="environment-panel"
              aria-expanded={environmentOpen()}
              aria-label="Alternar painel do ambiente"
              class="icon-button"
              classList={{ active: environmentOpen() }}
              onClick={() => setEnvironmentOpen((value) => !value)}
              title="Ambiente"
              type="button"
            >
              <Icon name="panel" size={16} />
            </button>
            <button
              aria-label="Abrir configurações"
              class="icon-button"
              onClick={() => setSettingsOpen(true)}
              title="Configurações"
              type="button"
            >
              <Icon name="settings" size={16} />
            </button>
          </div>
        </header>
        <section class="chat-page" ref={chatPageElement}>
          <Timeline controller={props.controller} onSelectSuggestion={requestDraft} />
          <div class="chat-dock" ref={chatDockElement}>
            <ApprovalCard controller={props.controller} />
            <ModelSafetyNotice controller={props.controller} />
            <Composer
              controller={props.controller}
              draftRequest={draftRequest()}
              onDraftConsumed={(requestId) =>
                setDraftRequest((current) => (current?.id === requestId ? null : current))
              }
              onOpenSettings={() => setSettingsOpen(true)}
            />
          </div>
        </section>
      </main>
      <Show when={environmentOpen()}>
        <EnvironmentPanel
          controller={props.controller}
          inert={settingsOpen()}
          onClose={() => setEnvironmentOpen(false)}
        />
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

function OpenWorkspaceMenu(props: {
  readonly controller: AppController;
  readonly onOpenEnvironment: () => void;
}) {
  let menu: HTMLDetailsElement | undefined;

  function closeMenu(): void {
    if (menu !== undefined) {
      menu.open = false;
    }
  }

  return (
    <details class="open-workspace-menu" ref={menu}>
      <summary class="open-workspace-button" title="Abrir projeto">
        <span>Abrir em</span>
        <Icon name="chevronDown" size={13} />
      </summary>
      <div class="open-workspace-popover" role="menu">
        <button
          onClick={() => {
            closeMenu();
            void props.controller.openWorkspace();
          }}
          role="menuitem"
          type="button"
        >
          <Icon name="folderOpen" size={15} />
          <span>Explorador de Arquivos</span>
        </button>
        <button
          onClick={() => {
            closeMenu();
            props.onOpenEnvironment();
          }}
          role="menuitem"
          type="button"
        >
          <Icon name="panel" size={15} />
          <span>Painel do projeto</span>
        </button>
      </div>
    </details>
  );
}

function TaskHeader(props: { readonly controller: AppController }) {
  let menu: HTMLDetailsElement | undefined;
  const [renaming, setRenaming] = createSignal(false);
  const [renameValue, setRenameValue] = createSignal("");
  const thread = () => props.controller.currentThread();
  const workspaceLabel = () => {
    const path = thread()?.cwd ?? props.controller.workspace();
    return path === null ? "Codex" : projectName(path);
  };

  function closeMenu(): void {
    if (menu !== undefined) {
      menu.open = false;
    }
    setRenaming(false);
  }

  async function submitRename(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const current = thread();
    if (current === null) {
      return;
    }
    if (await props.controller.renameThread(current.id, renameValue())) {
      closeMenu();
    }
  }

  return (
    <div class="task-header">
      <span
        class="task-header-project"
        title={thread()?.cwd ?? props.controller.workspace() ?? "Codex"}
      >
        <Icon name="folder" size={14} />
        <span>{workspaceLabel()}</span>
      </span>
      <span aria-hidden="true" class="task-header-separator">
        /
      </span>
      <strong title={props.controller.currentThreadTitle()}>
        {props.controller.currentThreadTitle()}
      </strong>
      <Show when={thread()}>
        {(current) => (
          <details
            class="task-header-menu"
            onToggle={(event) => {
              if (!event.currentTarget.open) {
                setRenaming(false);
              }
            }}
            ref={menu}
          >
            <summary aria-label="Ações da tarefa" title="Ações da tarefa">
              <Icon name="more" size={15} />
            </summary>
            <div class="task-header-menu-popover" role="menu">
              <Show
                when={renaming()}
                fallback={
                  <>
                    <button
                      onClick={() => {
                        setRenameValue(props.controller.currentThreadTitle());
                        setRenaming(true);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <Icon name="edit" size={14} /> Renomear
                    </button>
                    <button
                      disabled={current().status.type === "active"}
                      onClick={() => {
                        closeMenu();
                        void props.controller.forkThread(current().id);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <Icon name="layers" size={14} /> Criar fork
                    </button>
                    <button
                      disabled={current().status.type === "active" || current().turns.length === 0}
                      onClick={() => {
                        closeMenu();
                        void props.controller.compactThread(current().id);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <Icon name="reset" size={14} /> Compactar contexto
                    </button>
                    <button
                      disabled={current().status.type === "active"}
                      onClick={() => {
                        closeMenu();
                        void props.controller.archiveThread(current().id);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <Icon name="archive" size={14} /> Arquivar
                    </button>
                  </>
                }
              >
                <form class="task-header-rename" onSubmit={(event) => void submitRename(event)}>
                  <label for="task-header-rename-input">Renomear tarefa</label>
                  <input
                    autofocus
                    id="task-header-rename-input"
                    maxlength={256}
                    onInput={(event) => setRenameValue(event.currentTarget.value)}
                    value={renameValue()}
                  />
                  <div>
                    <button onClick={closeMenu} type="button">
                      Cancelar
                    </button>
                    <button disabled={renameValue().trim().length === 0} type="submit">
                      Salvar
                    </button>
                  </div>
                </form>
              </Show>
            </div>
          </details>
        )}
      </Show>
    </div>
  );
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

function EnvironmentPanel(props: {
  readonly controller: AppController;
  readonly inert: boolean;
  readonly onClose: () => void;
}) {
  const [tab, setTab] = createSignal<"changes" | "environment">("environment");
  const usage = () => props.controller.rateLimits()?.rateLimits.primary;
  const permission = () => props.controller.config()?.config.permissionProfile;
  const changes = () => {
    const repository = props.controller.workspaceRepository();
    return repository?.type === "gitBranch" || repository?.type === "gitDetached"
      ? repository.changes
      : [];
  };
  return (
    <aside
      aria-label="Ambiente atual"
      class="environment-panel"
      id="environment-panel"
      inert={props.inert}
    >
      <header>
        <nav aria-label="Painel do projeto">
          <button
            aria-current={tab() === "environment" ? "page" : undefined}
            classList={{ active: tab() === "environment" }}
            onClick={() => setTab("environment")}
            type="button"
          >
            Ambiente
          </button>
          <button
            aria-current={tab() === "changes" ? "page" : undefined}
            classList={{ active: tab() === "changes" }}
            onClick={() => {
              setTab("changes");
              void props.controller.refreshWorkspaceRepository();
            }}
            type="button"
          >
            Alterações <span>{changes().length}</span>
          </button>
        </nav>
        <button
          aria-label="Fechar ambiente"
          class="icon-button"
          onClick={props.onClose}
          type="button"
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <Show
        when={tab() === "environment"}
        fallback={
          <section class="workspace-changes">
            <div class="workspace-changes-toolbar">
              <strong>Arquivos locais</strong>
              <button
                onClick={() => void props.controller.refreshWorkspaceRepository()}
                type="button"
              >
                Atualizar
              </button>
            </div>
            <Show
              when={changes().length > 0}
              fallback={
                <div class="workspace-changes-empty">
                  <Icon name="check" size={18} />
                  <strong>Nenhuma alteração local</strong>
                  <p>O diretório de trabalho está limpo.</p>
                </div>
              }
            >
              <ul>
                <For each={changes()}>
                  {(change) => (
                    <li>
                      <span data-kind={gitChangeKind(change.status)}>
                        {gitChangeLabel(change.status)}
                      </span>
                      <code title={change.path}>{change.path}</code>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
        }
      >
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
          <RepositorySummary controller={props.controller} />
          <button
            class="secondary-button compact"
            onClick={() => void props.controller.openWorkspace()}
            type="button"
          >
            Abrir no sistema
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
      </Show>
      <footer>
        <span class="native-badge">
          <i /> Nativo
        </span>
        <small>HTTPS/SSE · SQLite · OAuth</small>
      </footer>
    </aside>
  );
}

function RepositorySummary(props: { readonly controller: AppController }) {
  const repository = () => props.controller.workspaceRepository();
  const label = () => {
    const current = repository();
    if (current?.type === "gitBranch") {
      return current.branch;
    }
    return current?.type === "gitDetached" ? current.revision : "";
  };
  return (
    <Show when={repository()?.type !== "none" && repository() !== null}>
      <p class="repository-summary">
        <Icon name="computer" size={14} /> Local
        <span>
          <Icon name="gitBranch" size={13} />
          {label()}
        </span>
      </p>
    </Show>
  );
}

function gitChangeKind(status: string): "added" | "conflicted" | "deleted" | "modified" {
  if (status.includes("U") || status === "AA" || status === "DD") {
    return "conflicted";
  }
  if (status.includes("D")) {
    return "deleted";
  }
  if (status === "??" || status.includes("A")) {
    return "added";
  }
  return "modified";
}

function gitChangeLabel(status: string): string {
  switch (gitChangeKind(status)) {
    case "added":
      return "A";
    case "conflicted":
      return "!";
    case "deleted":
      return "D";
    case "modified":
      return "M";
  }
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
