import { Show, createSignal } from "solid-js";

import { ApprovalDialog } from "../approvals/ApprovalDialog";
import { ChatPage } from "../chat/ChatPage";
import { ProjectSidebar } from "../projects/ProjectSidebar";
import type { CodexSession } from "../session/createCodexSession";
import { SettingsDrawer } from "../settings/SettingsDrawer";
import {
  ChevronDownIcon,
  CloseIcon,
  FolderIcon,
  PanelRightIcon,
  PlusIcon,
  SettingsIcon,
  SidebarIcon,
} from "../../shared/components/Icons";
import { EnvironmentPanel } from "./EnvironmentPanel";

interface AppShellProps {
  session: CodexSession;
}

export function AppShell(props: AppShellProps) {
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const [environmentOpen, setEnvironmentOpen] = createSignal(true);
  const accountName = () => {
    const account = props.session.account()?.account;
    if (account !== null && account !== undefined && "email" in account) {
      return typeof account.email === "string" ? account.email : "Conta ChatGPT";
    }
    return account?.type ?? "Codex";
  };
  const taskTitle = () => props.session.currentThreadTitle();

  return (
    <div
      class="app-shell"
      classList={{
        "environment-closed": !environmentOpen(),
        "sidebar-collapsed": sidebarCollapsed(),
      }}
    >
      <aside class="sidebar">
        <div class="sidebar-brand-row">
          <button
            class="mode-button"
            onClick={() => setSettingsOpen(true)}
            title="Configurações do Codex"
            type="button"
          >
            <span class="brand-mark">C</span>
            <span class="sidebar-label">Codex</span>
            <ChevronDownIcon size={14} />
          </button>
        </div>

        <nav aria-label="Navegação principal" class="sidebar-nav">
          <button
            class="sidebar-action"
            disabled={props.session.busy()}
            onClick={props.session.newThread}
            type="button"
          >
            <PlusIcon size={17} />
            <span class="sidebar-label">Nova tarefa</span>
          </button>
        </nav>

        <ProjectSidebar session={props.session} />

        <div class="sidebar-spacer" />

        <footer class="sidebar-footer">
          <button onClick={() => setSettingsOpen(true)} type="button">
            <span class="account-avatar account-avatar-small">
              {accountName().slice(0, 1).toUpperCase()}
            </span>
            <span class="account-copy sidebar-label">
              <strong>{accountName()}</strong>
              <small>Configurações</small>
            </span>
            <span class="sidebar-label">
              <SettingsIcon size={16} />
            </span>
          </button>
        </footer>
      </aside>

      <main class="main-panel">
        <header class="topbar">
          <div class="topbar-leading">
            <button
              aria-label={sidebarCollapsed() ? "Mostrar barra lateral" : "Ocultar barra lateral"}
              class="icon-button topbar-icon"
              onClick={() => setSidebarCollapsed((current) => !current)}
              title={sidebarCollapsed() ? "Mostrar barra lateral" : "Ocultar barra lateral"}
              type="button"
            >
              <SidebarIcon size={17} />
            </button>
            <FolderIcon size={16} />
            <h1>{taskTitle()}</h1>
          </div>
          <div class="topbar-actions">
            <span class={`runtime-indicator runtime-${props.session.runtimeStatus().state}`}>
              <i />
              {runtimeLabel(props.session.runtimeStatus().state)}
            </span>
            <button
              aria-label="Alternar painel de ambiente"
              class="icon-button topbar-icon"
              classList={{ active: environmentOpen() }}
              onClick={() => setEnvironmentOpen((current) => !current)}
              title="Painel de ambiente"
              type="button"
            >
              <PanelRightIcon size={17} />
            </button>
            <button
              aria-label="Abrir configurações"
              class="icon-button topbar-icon"
              onClick={() => setSettingsOpen(true)}
              title="Configurações"
              type="button"
            >
              <SettingsIcon size={17} />
            </button>
          </div>
        </header>
        <ChatPage
          onOpenSettings={() => setSettingsOpen(true)}
          session={props.session}
        />
      </main>

      <Show when={environmentOpen()}>
        <EnvironmentPanel
          onClose={() => setEnvironmentOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
          session={props.session}
        />
      </Show>

      <Show when={settingsOpen()}>
        <SettingsDrawer onClose={() => setSettingsOpen(false)} session={props.session} />
      </Show>

      <Show when={props.session.approvalQueue()[0]}>
        {(request) => <ApprovalDialog request={request()} session={props.session} />}
      </Show>

      <Show when={props.session.error()}>
        {(message) => (
          <div class="error-toast" role="alert">
            <span>{message()}</span>
            <button aria-label="Fechar erro" onClick={props.session.clearError} type="button">
              <CloseIcon size={16} />
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}

function runtimeLabel(state: string): string {
  switch (state) {
    case "ready":
      return "Conectado";
    case "starting":
      return "Conectando";
    case "failed":
      return "Falha";
    default:
      return "Parado";
  }
}
