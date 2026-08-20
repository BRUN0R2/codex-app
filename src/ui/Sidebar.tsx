import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";

import type { ProjectRecord, ThreadSummary } from "../contracts/types";
import type { AppController } from "../state/appController";

type SidebarController = Pick<
  AppController,
  | "account"
  | "archiveThread"
  | "chooseWorkspace"
  | "compactThread"
  | "currentThread"
  | "deleteThread"
  | "forkThread"
  | "isThreadActive"
  | "loadMoreThreads"
  | "logout"
  | "newThread"
  | "openThread"
  | "pendingOperations"
  | "pinnedProjectPaths"
  | "pinnedThreadIds"
  | "product"
  | "projectExpanded"
  | "projectSectionExpanded"
  | "projectThreadListExpanded"
  | "projects"
  | "rateLimits"
  | "refreshAccountProfile"
  | "refreshRateLimitsIfStale"
  | "removeProject"
  | "renameThread"
  | "selectProduct"
  | "threads"
  | "threadsNextCursor"
  | "togglePinnedProject"
  | "togglePinnedThread"
  | "toggleProjectExpanded"
  | "toggleProjectSection"
  | "toggleProjectThreadListExpanded"
  | "unreadAutomationRuns"
  | "updateProject"
  | "workspace"
>;

import { pathsEqual } from "../state/projects";
import { threadsWithoutConfiguredProject } from "../state/sidebarThreads";
import { AccountAvatar, accountDisplayName } from "./AccountAvatar";
import { CodexGlyph } from "./CodexGlyph";
import { Icon, type IconName } from "./Icon";
import type { SettingsPage } from "./SettingsDialog";

const MAX_VISIBLE_PROJECT_GROUPS = 5;
const MAX_UNGROUPED_RECENT_THREADS = 8;
const MAX_INLINE_PROJECT_THREADS = 5;

export interface SidebarProps {
  readonly automationsActive: boolean;
  readonly collapsed: boolean;
  readonly controller: SidebarController;
  readonly inert: boolean;
  readonly onOpenAutomations: () => void;
  readonly onOpenSettings: (page?: SettingsPage) => void;
  readonly onShowChat: () => void;
}

export function Sidebar(props: SidebarProps) {
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal("");
  const [pinnedExpanded, setPinnedExpanded] = createSignal(true);
  const [showAllProjects, setShowAllProjects] = createSignal(false);
  const [recentsExpanded, setRecentsExpanded] = createSignal(true);
  const [accountMenuOpen, setAccountMenuOpen] = createSignal(false);
  const [brandMenuOpen, setBrandMenuOpen] = createSignal(false);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  let sidebarElement: HTMLElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  const normalizedSearchQuery = createMemo(() => searchQuery().trim().toLocaleLowerCase("pt-BR"));
  const grouped = createMemo(() => {
    const query = normalizedSearchQuery();
    return props.controller.projects().flatMap((project) => {
      const threads = props.controller
        .threads()
        .filter((thread) => pathsEqual(thread.projectPath, project.path))
        .sort((left, right) => right.updatedAt - left.updatedAt);
      if (query.length === 0 || matchesProject(project, query)) {
        return [{ project, threads }];
      }
      const matchingThreads = threads.filter((thread) => matchesThread(thread, query));
      return matchingThreads.length > 0 ? [{ project, threads: matchingThreads }] : [];
    });
  });
  const visibleGrouped = createMemo(() => {
    if (normalizedSearchQuery().length > 0 || showAllProjects()) {
      return grouped();
    }
    return grouped().slice(0, MAX_VISIBLE_PROJECT_GROUPS);
  });
  const ungrouped = createMemo(() =>
    threadsWithoutConfiguredProject(props.controller.threads(), props.controller.projects())
      .filter(
        (thread) =>
          normalizedSearchQuery().length === 0 || matchesThread(thread, normalizedSearchQuery()),
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_UNGROUPED_RECENT_THREADS),
  );
  const pinnedThreads = createMemo(() => {
    const pinned = new Set(props.controller.pinnedThreadIds());
    return props.controller
      .threads()
      .filter((thread) => pinned.has(thread.id))
      .filter(
        (thread) =>
          normalizedSearchQuery().length === 0 || matchesThread(thread, normalizedSearchQuery()),
      )
      .sort((left, right) => right.updatedAt - left.updatedAt);
  });
  const pinnedProjects = createMemo(() => {
    const pinned = props.controller.pinnedProjectPaths();
    return props.controller
      .projects()
      .filter((project) => pinned.some((path) => pathsEqual(path, project.path)))
      .filter(
        (project) =>
          normalizedSearchQuery().length === 0 || matchesProject(project, normalizedSearchQuery()),
      );
  });

  createEffect(() => {
    if (props.collapsed) {
      setAccountMenuOpen(false);
      setBrandMenuOpen(false);
    }
  });

  function dismissSidebarMenusFromPointer(event: PointerEvent): void {
    if (!(event.target instanceof Element)) {
      setAccountMenuOpen(false);
      setBrandMenuOpen(false);
      return;
    }
    if (event.target.closest(".sidebar-account-trigger, #account-menu") === null) {
      setAccountMenuOpen(false);
    }
    if (event.target.closest(".sidebar-brand, .brand-menu") === null) {
      setBrandMenuOpen(false);
    }
    const menus = sidebarElement?.querySelectorAll<HTMLDetailsElement>(
      ".thread-menu-control[open]",
    );
    for (const menu of menus ?? []) {
      if (!menu.contains(event.target)) {
        menu.open = false;
      }
    }
  }

  function closeAccountMenuFromKeyboard(event: KeyboardEvent): void {
    if (event.ctrlKey && event.key.toLocaleLowerCase("en-US") === "k") {
      event.preventDefault();
      setAccountMenuOpen(false);
      setBrandMenuOpen(false);
      setSearchOpen(true);
      queueMicrotask(() => searchInput?.focus());
      return;
    }
    if (event.key === "Escape") {
      if (searchOpen()) {
        setSearchOpen(false);
        setSearchQuery("");
      }
      setAccountMenuOpen(false);
      setBrandMenuOpen(false);
      for (const menu of sidebarElement?.querySelectorAll<HTMLDetailsElement>(
        ".thread-menu-control[open]",
      ) ?? []) {
        menu.open = false;
      }
    }
  }

  onMount(() => {
    document.addEventListener("pointerdown", dismissSidebarMenusFromPointer);
    document.addEventListener("keydown", closeAccountMenuFromKeyboard);
  });
  onCleanup(() => {
    document.removeEventListener("pointerdown", dismissSidebarMenusFromPointer);
    document.removeEventListener("keydown", closeAccountMenuFromKeyboard);
  });

  function beginRename(thread: ThreadSummary): void {
    setRenamingId(thread.id);
    setRenameValue(threadTitle(thread));
  }

  async function submitRename(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const id = renamingId();
    if (id !== null && (await props.controller.renameThread(id, renameValue()))) {
      setRenamingId(null);
    }
  }

  function isProjectExpanded(project: ProjectRecord): boolean {
    return normalizedSearchQuery().length > 0 || props.controller.projectExpanded(project.path);
  }

  function startNewThread(workspace?: string): void {
    props.onShowChat();
    props.controller.newThread(workspace);
  }

  return (
    <aside
      aria-label="Navegação principal"
      class="sidebar"
      classList={{ collapsed: props.collapsed }}
      inert={props.inert}
      ref={sidebarElement}
    >
      <header class="sidebar-titlebar">
        <Show when={!props.collapsed}>
          <div class="brand-menu-anchor">
            <button
              aria-expanded={brandMenuOpen()}
              aria-haspopup="menu"
              class="sidebar-brand"
              onClick={() => {
                setAccountMenuOpen(false);
                setBrandMenuOpen((value) => !value);
              }}
              type="button"
            >
              <Show when={props.controller.product() === "codex"}>
                <CodexGlyph size={18} />
              </Show>
              <strong>{props.controller.product() === "codex" ? "Codex" : "ChatGPT"}</strong>
              <Icon name="chevronDown" size={12} />
            </button>
            <Show when={brandMenuOpen()}>
              <div aria-label="Alternar produto" class="brand-menu" role="menu">
                <button
                  aria-checked={props.controller.product() === "chatgpt"}
                  class="brand-menu-item"
                  classList={{ selected: props.controller.product() === "chatgpt" }}
                  onClick={() => {
                    setBrandMenuOpen(false);
                    props.onShowChat();
                    void props.controller.selectProduct("chatgpt");
                  }}
                  role="menuitemradio"
                  type="button"
                >
                  <div class="brand-menu-item-text">
                    <strong>ChatGPT</strong>
                    <small>Criar, aprender e explorar</small>
                  </div>
                  <Show when={props.controller.product() === "chatgpt"}>
                    <Icon name="check" size={14} />
                  </Show>
                </button>
                <button
                  aria-checked={props.controller.product() === "codex"}
                  class="brand-menu-item"
                  classList={{ selected: props.controller.product() === "codex" }}
                  onClick={() => {
                    setBrandMenuOpen(false);
                    props.onShowChat();
                    void props.controller.selectProduct("codex");
                  }}
                  role="menuitemradio"
                  type="button"
                >
                  <div class="brand-menu-item-text">
                    <strong>Codex</strong>
                    <small>Criar, depurar e publicar</small>
                  </div>
                  <Show when={props.controller.product() === "codex"}>
                    <Icon name="check" size={14} />
                  </Show>
                </button>
              </div>
            </Show>
          </div>
        </Show>
      </header>

      <nav aria-label="Ações principais" class="sidebar-primary-nav">
        <button
          class="new-thread-button"
          onClick={() => startNewThread()}
          title="Novo chat"
          type="button"
        >
          <span class="sidebar-item-icon">
            <Icon name="newChat" size={16} />
          </span>
          <Show when={!props.collapsed}>
            <span class="sidebar-row-label">Novo chat</span>
          </Show>
        </button>
        <button
          aria-current={props.automationsActive ? "page" : undefined}
          class="automation-nav-button"
          classList={{ active: props.automationsActive }}
          onClick={props.onOpenAutomations}
          title="Automações"
          type="button"
        >
          <span class="sidebar-item-icon">
            <Icon name="calendar" size={16} />
          </span>
          <Show when={!props.collapsed}>
            <span class="sidebar-row-label">Automações</span>
          </Show>
          <Show when={props.controller.unreadAutomationRuns().length > 0}>
            <span class="sidebar-automation-badge">
              {Math.min(99, props.controller.unreadAutomationRuns().length)}
            </span>
          </Show>
        </button>
      </nav>

      <Show when={!props.collapsed && searchOpen()}>
        <label class="sidebar-search">
          <Icon name="search" size={15} />
          <input
            aria-label="Pesquisar projetos e tarefas"
            onInput={(event) => setSearchQuery(event.currentTarget.value)}
            placeholder="Pesquisar"
            ref={searchInput}
            type="search"
            value={searchQuery()}
          />
          <button
            aria-label="Fechar pesquisa"
            onClick={() => {
              setSearchOpen(false);
              setSearchQuery("");
            }}
            type="button"
          >
            <Icon name="close" size={13} />
          </button>
        </label>
      </Show>

      <div class="sidebar-scroll">
        <Show
          when={!props.collapsed && (pinnedThreads().length > 0 || pinnedProjects().length > 0)}
        >
          <SidebarSectionHeading
            expanded={pinnedExpanded() || normalizedSearchQuery().length > 0}
            label="Fixados"
            onToggle={() => setPinnedExpanded((value) => !value)}
          />
          <Show when={pinnedExpanded() || normalizedSearchQuery().length > 0}>
            <div class="pinned-threads">
              <For each={pinnedProjects()}>
                {(project) => {
                  const threads = () =>
                    props.controller
                      .threads()
                      .filter((thread) => pathsEqual(thread.projectPath, project.path));
                  return (
                    <ProjectGroup
                      collapsed={props.collapsed}
                      controller={props.controller}
                      expanded={isProjectExpanded(project)}
                      onBeginRename={beginRename}
                      onShowChat={props.onShowChat}
                      onSubmitRename={submitRename}
                      onToggleExpanded={() => props.controller.toggleProjectExpanded(project.path)}
                      onToggleThreadList={() =>
                        props.controller.toggleProjectThreadListExpanded(project.path)
                      }
                      project={project}
                      renameValue={renameValue()}
                      renamingId={renamingId()}
                      setRenameValue={setRenameValue}
                      threadListExpanded={props.controller.projectThreadListExpanded(project.path)}
                      threads={threads()}
                    />
                  );
                }}
              </For>
              <For each={pinnedThreads()}>
                {(thread) => (
                  <ThreadButton
                    controller={props.controller}
                    onBeginRename={beginRename}
                    onShowChat={props.onShowChat}
                    onSubmitRename={submitRename}
                    onTogglePinned={() => props.controller.togglePinnedThread(thread.id)}
                    pinned
                    renameValue={renameValue()}
                    renaming={renamingId() === thread.id}
                    setRenameValue={setRenameValue}
                    thread={thread}
                  />
                )}
              </For>
            </div>
          </Show>
        </Show>
        <Show when={!props.collapsed}>
          <SidebarSectionHeading
            expanded={
              props.controller.projectSectionExpanded() || normalizedSearchQuery().length > 0
            }
            label="Projetos"
            onToggle={props.controller.toggleProjectSection}
          >
            <button
              aria-label="Adicionar projeto"
              onClick={() => void props.controller.chooseWorkspace()}
              title="Adicionar projeto"
              type="button"
            >
              <Icon name="plus" size={14} />
            </button>
          </SidebarSectionHeading>
        </Show>

        <Show
          when={
            props.collapsed ||
            props.controller.projectSectionExpanded() ||
            normalizedSearchQuery().length > 0
          }
        >
          <Show
            when={grouped().length > 0}
            fallback={
              <Show when={normalizedSearchQuery().length === 0}>
                <p class="sidebar-empty">Nenhum projeto</p>
              </Show>
            }
          >
            <For each={visibleGrouped()}>
              {(group) => (
                <ProjectGroup
                  collapsed={props.collapsed}
                  controller={props.controller}
                  expanded={isProjectExpanded(group.project)}
                  onBeginRename={beginRename}
                  onShowChat={props.onShowChat}
                  onSubmitRename={submitRename}
                  onToggleExpanded={() =>
                    props.controller.toggleProjectExpanded(group.project.path)
                  }
                  onToggleThreadList={() =>
                    props.controller.toggleProjectThreadListExpanded(group.project.path)
                  }
                  project={group.project}
                  renameValue={renameValue()}
                  renamingId={renamingId()}
                  setRenameValue={setRenameValue}
                  threadListExpanded={props.controller.projectThreadListExpanded(
                    group.project.path,
                  )}
                  threads={group.threads}
                />
              )}
            </For>
            <Show when={normalizedSearchQuery().length === 0 && grouped().length > 5}>
              <button
                aria-expanded={showAllProjects()}
                class="sidebar-pagination-button"
                onClick={() => setShowAllProjects((value) => !value)}
                type="button"
              >
                <span>{showAllProjects() ? "Mostrar menos" : "Mostrar mais"}</span>
                <Icon name={showAllProjects() ? "chevronDown" : "chevronRight"} size={12} />
              </button>
            </Show>
          </Show>
        </Show>

        <Show when={!props.collapsed}>
          <SidebarSectionHeading
            expanded={recentsExpanded() || normalizedSearchQuery().length > 0}
            label="Recentes"
            onToggle={() => setRecentsExpanded((value) => !value)}
          >
            <button
              aria-label="Novo chat sem projeto"
              onClick={() => startNewThread()}
              title="Novo chat"
              type="button"
            >
              <Icon name="newChat" size={16} />
            </button>
          </SidebarSectionHeading>
          <Show when={recentsExpanded() || normalizedSearchQuery().length > 0}>
            <Show
              when={ungrouped().length > 0}
              fallback={
                <Show when={normalizedSearchQuery().length === 0}>
                  <p class="sidebar-empty">Nenhum chat</p>
                </Show>
              }
            >
              <For each={ungrouped()}>
                {(thread) => (
                  <ThreadButton
                    controller={props.controller}
                    onBeginRename={beginRename}
                    onShowChat={props.onShowChat}
                    onSubmitRename={submitRename}
                    onTogglePinned={() => props.controller.togglePinnedThread(thread.id)}
                    pinned={props.controller.pinnedThreadIds().includes(thread.id)}
                    renameValue={renameValue()}
                    renaming={renamingId() === thread.id}
                    setRenameValue={setRenameValue}
                    thread={thread}
                  />
                )}
              </For>
            </Show>
            <Show
              when={
                normalizedSearchQuery().length === 0 &&
                props.controller.threadsNextCursor() !== null
              }
            >
              <button
                class="load-more-button"
                disabled={props.controller.pendingOperations() > 0}
                onClick={() => void props.controller.loadMoreThreads()}
                type="button"
              >
                Carregar mais
              </button>
            </Show>
          </Show>
        </Show>
        <Show
          when={
            normalizedSearchQuery().length > 0 && grouped().length === 0 && ungrouped().length === 0
          }
        >
          <p class="sidebar-search-empty">Nenhum projeto ou tarefa encontrado.</p>
        </Show>
      </div>

      <footer class="sidebar-footer">
        <Show when={!props.collapsed && accountMenuOpen()}>
          <div aria-label="Conta" class="account-menu" id="account-menu" role="menu">
            <div class="account-menu-identity" role="presentation">
              <AccountAvatar account={props.controller.account()?.account} />
              <strong>{accountLabel(props.controller)}</strong>
            </div>
            <hr class="account-menu-separator" />
            <button
              onClick={() => {
                setAccountMenuOpen(false);
                props.onOpenSettings("usage");
              }}
              role="menuitem"
              type="button"
            >
              <Icon name="creditCard" size={15} />
              <span>Uso restante</span>
              <small class="usage-badge">{remainingUsageLabel(props.controller)}</small>
              <Icon name="chevronRight" size={13} />
            </button>
            <button
              onClick={() => {
                setAccountMenuOpen(false);
                props.onOpenSettings("profile");
              }}
              role="menuitem"
              type="button"
            >
              <Icon name="user" size={15} />
              <span>Perfil</span>
            </button>
            <button
              onClick={() => {
                setAccountMenuOpen(false);
                props.onOpenSettings();
              }}
              role="menuitem"
              type="button"
            >
              <Icon name="settings" size={15} />
              <span>Configurações</span>
              <kbd>Ctrl+,</kbd>
            </button>
            <button
              onClick={() => {
                setAccountMenuOpen(false);
                void props.controller.logout();
              }}
              role="menuitem"
              type="button"
            >
              <Icon name="logout" size={15} />
              <span>Sair</span>
            </button>
          </div>
        </Show>
        <div class="sidebar-footer-row">
          <button
            aria-controls="account-menu"
            aria-expanded={accountMenuOpen()}
            aria-haspopup="menu"
            class="sidebar-account-trigger"
            onClick={() => {
              setBrandMenuOpen(false);
              if (props.collapsed) {
                props.onOpenSettings();
                return;
              }
              const opening = !accountMenuOpen();
              setAccountMenuOpen(opening);
              if (opening) {
                void props.controller.refreshAccountProfile();
                void props.controller.refreshRateLimitsIfStale();
              }
            }}
            title="Conta"
            type="button"
          >
            <AccountAvatar account={props.controller.account()?.account} />
            <Show when={!props.collapsed}>
              <span class="account-label">
                <strong>{accountLabel(props.controller)}</strong>
              </span>
            </Show>
          </button>
        </div>
      </footer>
    </aside>
  );
}

function SidebarSectionHeading(props: {
  readonly children?: JSX.Element;
  readonly expanded: boolean;
  readonly label: string;
  readonly onToggle: () => void;
}) {
  return (
    <div class="sidebar-section-heading" classList={{ "has-action": props.children !== undefined }}>
      <button
        aria-expanded={props.expanded}
        class="sidebar-section-toggle"
        onClick={props.onToggle}
        type="button"
      >
        <span>{props.label}</span>
        <span class="sidebar-section-chevron">
          <Icon name={props.expanded ? "chevronDown" : "chevronRight"} size={12} />
        </span>
      </button>
      {props.children}
    </div>
  );
}

interface ProjectGroupProps {
  readonly collapsed: boolean;
  readonly controller: SidebarController;
  readonly expanded: boolean;
  readonly onBeginRename: (thread: ThreadSummary) => void;
  readonly onShowChat: () => void;
  readonly onSubmitRename: (event: SubmitEvent) => Promise<void>;
  readonly onToggleExpanded: () => void;
  readonly onToggleThreadList: () => void;
  readonly project: ProjectRecord;
  readonly renameValue: string;
  readonly renamingId: string | null;
  readonly setRenameValue: (value: string) => void;
  readonly threadListExpanded: boolean;
  readonly threads: readonly ThreadSummary[];
}

function ProjectGroup(props: ProjectGroupProps) {
  let menu: HTMLDetailsElement | undefined;
  const [editingProject, setEditingProject] = createSignal(false);
  const isPinned = () =>
    props.controller.pinnedProjectPaths().some((path) => pathsEqual(path, props.project.path));
  const isProjectPageActive = () =>
    props.controller.currentThread() === null &&
    pathsEqual(props.controller.workspace(), props.project.path);
  const visibleThreads = () =>
    props.threadListExpanded || props.threads.length <= MAX_INLINE_PROJECT_THREADS
      ? props.threads
      : props.threads.slice(0, MAX_INLINE_PROJECT_THREADS);

  return (
    <section class="project-group" classList={{ expanded: props.expanded }}>
      <div class="project-row" classList={{ selected: isProjectPageActive() }}>
        <button
          aria-expanded={props.expanded}
          class="project-main"
          onClick={() => {
            props.onToggleExpanded();
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            if (menu !== undefined) {
              menu.open = !menu.open;
            }
          }}
          title={props.project.path}
          type="button"
        >
          <span
            class="project-icon-slot"
            style={props.project.color ? { color: props.project.color } : undefined}
          >
            <Icon
              name={(props.project.icon as IconName) ?? (props.expanded ? "folderOpen" : "folder")}
              size={16}
            />
          </span>
          <Show when={!props.collapsed}>
            <span class="sidebar-row-label">{props.project.name}</span>
          </Show>
        </button>
        <Show when={!props.collapsed}>
          <div class="row-actions">
            <button
              aria-label={`Novo chat em ${props.project.name}`}
              class="project-new-chat-button"
              onClick={() => {
                props.onShowChat();
                props.controller.newThread(props.project.path);
              }}
              title="Novo chat"
              type="button"
            >
              <Icon name="newChat" size={16} />
            </button>
            <details class="thread-menu-control" ref={menu}>
              <summary aria-label={`Ações de ${props.project.name}`} title="Mais ações">
                <Icon name="more" size={14} />
              </summary>
              <div class="thread-context-menu project-context-menu" role="menu">
                <button
                  onClick={() => {
                    if (menu !== undefined) {
                      menu.open = false;
                    }
                    props.controller.togglePinnedProject(props.project.path);
                  }}
                  role="menuitem"
                  type="button"
                >
                  <Icon name="pin" size={14} />
                  <span>{isPinned() ? "Desfixar projeto" : "Fixar projeto"}</span>
                </button>
                <button
                  onClick={() => {
                    if (menu !== undefined) {
                      menu.open = false;
                    }
                    void props.controller.chooseWorkspace();
                  }}
                  role="menuitem"
                  type="button"
                >
                  <Icon name="folder" size={14} />
                  <span>Abrir no Explorador de Arquivos</span>
                </button>
                <button
                  onClick={() => {
                    if (menu !== undefined) {
                      menu.open = false;
                    }
                    setEditingProject(true);
                  }}
                  role="menuitem"
                  type="button"
                >
                  <Icon name="settings" size={14} />
                  <span>Editar projeto</span>
                </button>
                <button
                  onClick={() => {
                    if (menu !== undefined) {
                      menu.open = false;
                    }
                    for (const thread of props.threads) {
                      void props.controller.archiveThread(thread.id);
                    }
                  }}
                  role="menuitem"
                  type="button"
                >
                  <Icon name="archive" size={14} />
                  <span>Arquivar chats</span>
                </button>
                <button
                  onClick={() => {
                    if (menu !== undefined) {
                      menu.open = false;
                    }
                    props.controller.removeProject(props.project.path);
                  }}
                  role="menuitem"
                  type="button"
                >
                  <Icon name="close" size={14} />
                  <span>Remover</span>
                </button>
              </div>
            </details>
          </div>
        </Show>
      </div>
      <Show when={editingProject()}>
        <ProjectEditModal
          onClose={() => setEditingProject(false)}
          onSave={(name, icon, color) => {
            props.controller.updateProject(props.project.path, { color, icon, name });
          }}
          project={props.project}
        />
      </Show>
      <Show when={!props.collapsed && props.expanded}>
        <div class="project-threads">
          <For each={visibleThreads()}>
            {(thread) => (
              <ThreadButton
                controller={props.controller}
                onBeginRename={props.onBeginRename}
                onShowChat={props.onShowChat}
                onSubmitRename={props.onSubmitRename}
                onTogglePinned={() => props.controller.togglePinnedThread(thread.id)}
                pinned={props.controller.pinnedThreadIds().includes(thread.id)}
                renameValue={props.renameValue}
                renaming={props.renamingId === thread.id}
                setRenameValue={props.setRenameValue}
                thread={thread}
              />
            )}
          </For>
          <Show when={props.threads.length === 0}>
            <p class="no-threads">Nenhuma tarefa</p>
          </Show>
          <Show when={props.threads.length > 5}>
            <button
              aria-expanded={props.threadListExpanded}
              class="project-thread-pagination"
              onClick={props.onToggleThreadList}
              type="button"
            >
              {props.threadListExpanded
                ? "Mostrar menos"
                : `Mostrar mais (${props.threads.length - 5})`}
            </button>
          </Show>
        </div>
      </Show>
    </section>
  );
}

interface ThreadButtonProps {
  readonly controller: SidebarController;
  readonly onBeginRename: (thread: ThreadSummary) => void;
  readonly onShowChat: () => void;
  readonly onSubmitRename: (event: SubmitEvent) => Promise<void>;
  readonly onTogglePinned: () => void;
  readonly pinned: boolean;
  readonly renameValue: string;
  readonly renaming: boolean;
  readonly setRenameValue: (value: string) => void;
  readonly thread: ThreadSummary;
}

function ThreadButton(props: ThreadButtonProps) {
  let menu: HTMLDetailsElement | undefined;

  function closeMenu(): void {
    if (menu !== undefined) {
      menu.open = false;
    }
  }

  async function deleteThread(): Promise<void> {
    closeMenu();
    await props.controller.deleteThread(props.thread.id);
  }

  return (
    <div
      class="thread-row"
      classList={{ active: props.controller.currentThread()?.id === props.thread.id }}
    >
      <Show
        when={!props.renaming}
        fallback={
          <form onSubmit={(event) => void props.onSubmitRename(event)}>
            <input
              autofocus
              maxlength={256}
              onInput={(event) => props.setRenameValue(event.currentTarget.value)}
              value={props.renameValue}
            />
          </form>
        }
      >
        <button
          aria-current={
            props.controller.currentThread()?.id === props.thread.id ? "page" : undefined
          }
          class="thread-main"
          onClick={() => {
            props.onShowChat();
            void props.controller.openThread(props.thread.id);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            if (menu !== undefined) {
              menu.open = !menu.open;
            }
          }}
          title={threadTitle(props.thread)}
          type="button"
        >
          <span>{threadTitle(props.thread)}</span>
          <Show when={props.controller.isThreadActive(props.thread.id)}>
            <i class="active-dot" />
          </Show>
        </button>
        <div class="thread-actions">
          <details class="thread-menu-control" ref={menu}>
            <summary aria-label="Ações da tarefa" title="Mais ações">
              <Icon name="more" size={14} />
            </summary>
            <div aria-label="Ações da tarefa" class="thread-context-menu" role="menu">
              <button
                onClick={() => {
                  closeMenu();
                  props.onTogglePinned();
                }}
                role="menuitem"
                type="button"
              >
                <Icon name="pin" size={14} /> {props.pinned ? "Desafixar" : "Fixar"}
              </button>
              <button
                onClick={() => {
                  closeMenu();
                  props.onBeginRename(props.thread);
                }}
                role="menuitem"
                type="button"
              >
                <Icon name="edit" size={14} /> Renomear
              </button>
              <button
                disabled={props.controller.isThreadActive(props.thread.id)}
                onClick={() => {
                  closeMenu();
                  void props.controller.forkThread(props.thread.id);
                }}
                role="menuitem"
                type="button"
              >
                <Icon name="layers" size={14} /> Criar fork
              </button>
              <button
                disabled={
                  props.controller.isThreadActive(props.thread.id) ||
                  props.thread.preview.length === 0
                }
                onClick={() => {
                  closeMenu();
                  void props.controller.compactThread(props.thread.id);
                }}
                role="menuitem"
                type="button"
              >
                <Icon name="reset" size={14} /> Compactar contexto
              </button>
              <button
                disabled={props.controller.isThreadActive(props.thread.id)}
                onClick={() => {
                  closeMenu();
                  void props.controller.archiveThread(props.thread.id);
                }}
                role="menuitem"
                type="button"
              >
                <Icon name="archive" size={14} /> Arquivar
              </button>
              <button
                class="danger"
                onClick={() => void deleteThread()}
                role="menuitem"
                type="button"
              >
                <Icon name="close" size={14} /> Excluir
              </button>
            </div>
          </details>
        </div>
      </Show>
    </div>
  );
}

export function threadTitle(thread: ThreadSummary): string {
  return (thread.name ?? thread.preview) || "Nova tarefa";
}

function matchesProject(project: ProjectRecord, query: string): boolean {
  return `${project.name}\n${project.path}`.toLocaleLowerCase("pt-BR").includes(query);
}

function matchesThread(thread: ThreadSummary, query: string): boolean {
  return `${threadTitle(thread)}\n${thread.projectPath ?? ""}`
    .toLocaleLowerCase("pt-BR")
    .includes(query);
}

function accountLabel(controller: SidebarController): string {
  return accountDisplayName(controller.account()?.account);
}

function remainingUsageLabel(controller: SidebarController): string {
  const usedPercent = controller.rateLimits()?.rateLimits.primary?.usedPercent;
  if (usedPercent === undefined) {
    return "—";
  }
  return `${Math.max(0, Math.round(100 - usedPercent))}%`;
}

function ProjectEditModal(props: {
  readonly onClose: () => void;
  readonly onSave: (name: string, icon?: IconName, color?: string) => void;
  readonly project: ProjectRecord;
}) {
  const [name, setName] = createSignal(props.project.name);
  const [icon, setIcon] = createSignal<IconName | undefined>(
    (props.project.icon as IconName | undefined) ?? "folder",
  );
  const [color, setColor] = createSignal<string>(props.project.color ?? "#4ade80");

  const selectedIcon = () => icon() ?? "folder";

  return (
    <Portal>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop */}
      <div class="modal-backdrop" onClick={props.onClose}>
        <div
          class="project-edit-container"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          role="dialog"
        >
          {/* Modal Principal de Edição */}
          <div class="project-edit-modal">
            <header class="project-edit-header">
              <h3>Editar projeto</h3>
              <button class="icon-button" onClick={props.onClose} title="Fechar" type="button">
                <Icon name="close" size={14} />
              </button>
            </header>

            <div class="project-edit-body">
              <div class="project-edit-input-row">
                <div class="project-icon-preview" style={{ color: color() }}>
                  <Icon name={selectedIcon()} size={20} />
                </div>
                <input
                  class="project-name-input"
                  onInput={(event) => setName(event.currentTarget.value)}
                  placeholder="Nome do projeto"
                  type="text"
                  value={name()}
                />
              </div>

              <div class="icon-picker-section">
                <span class="picker-label">Ícone</span>
                <div class="icons-grid">
                  <For each={SELECTABLE_ICONS_LIST}>
                    {(item) => (
                      <button
                        class="icon-grid-button"
                        classList={{ active: selectedIcon() === item }}
                        onClick={() => setIcon(item)}
                        style={selectedIcon() === item ? { color: color() } : undefined}
                        title={item}
                        type="button"
                      >
                        <Icon name={item} size={24} strokeWidth={1.5} />
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </div>

            <footer class="project-edit-footer">
              <button class="project-edit-cancel" onClick={props.onClose} type="button">
                Cancelar
              </button>
              <button
                class="project-edit-save"
                onClick={() => {
                  props.onSave(name().trim() || props.project.name, icon(), color());
                  props.onClose();
                }}
                type="button"
              >
                Salvar
              </button>
            </footer>
          </div>

          <div class="project-color-side-panel">
            <header class="side-panel-header">
              <span class="picker-label">Cor do projeto</span>
              <div class="color-hex-badge" style={{ background: color() }}>
                <span>{color().toUpperCase()}</span>
              </div>
            </header>

            <InlineColorPicker color={color()} onChange={setColor} />
          </div>
        </div>
      </div>
    </Portal>
  );
}

function InlineColorPicker(props: {
  readonly color: string;
  readonly onChange: (color: string) => void;
}) {
  let boxRef: HTMLDivElement | undefined;
  let hueRef: HTMLDivElement | undefined;

  const hsv = createMemo(() => hexToHsv(props.color));
  const hue = () => hsv().h;
  const sat = () => hsv().s;
  const val = () => hsv().v;

  const cursorX = () => `calc(7px + (${sat()} / 100) * (100% - 14px))`;
  const cursorY = () => `calc(7px + (${100 - val()} / 100) * (100% - 14px))`;
  const hueX = () => `calc(7px + (${hue()} / 360) * (100% - 14px))`;

  function updateFromBox(event: PointerEvent) {
    if (boxRef === undefined) {
      return;
    }
    const rect = boxRef.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    const newSat = Math.round((x / rect.width) * 100);
    const newVal = Math.round((1 - y / rect.height) * 100);
    props.onChange(hsvToHex(hue(), newSat, newVal));
  }

  function handleBoxPointerDown(event: PointerEvent) {
    event.preventDefault();
    boxRef?.setPointerCapture(event.pointerId);
    updateFromBox(event);
  }

  function handleBoxPointerMove(event: PointerEvent) {
    if (boxRef?.hasPointerCapture(event.pointerId) === true) {
      updateFromBox(event);
    }
  }

  function updateFromHue(event: PointerEvent) {
    if (hueRef === undefined) {
      return;
    }
    const rect = hueRef.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const newHue = Math.round((x / rect.width) * 360);
    props.onChange(hsvToHex(newHue, sat(), val()));
  }

  function handleHuePointerDown(event: PointerEvent) {
    event.preventDefault();
    hueRef?.setPointerCapture(event.pointerId);
    updateFromHue(event);
  }

  function handleHuePointerMove(event: PointerEvent) {
    if (hueRef?.hasPointerCapture(event.pointerId) === true) {
      updateFromHue(event);
    }
  }

  return (
    <div class="inline-color-picker">
      <div
        class="hsv-box"
        onPointerDown={handleBoxPointerDown}
        onPointerMove={handleBoxPointerMove}
        ref={boxRef}
        style={{ "background-color": `hsl(${hue()}, 100%, 50%)` }}
      >
        <div class="hsv-sat-overlay" />
        <div class="hsv-val-overlay" />
        <div
          class="hsv-cursor"
          style={{
            left: cursorX(),
            top: cursorY(),
          }}
        />
      </div>

      <div
        class="hue-bar"
        onPointerDown={handleHuePointerDown}
        onPointerMove={handleHuePointerMove}
        ref={hueRef}
      >
        <div class="hue-cursor" style={{ left: hueX() }} />
      </div>

      <div class="hex-input-wrapper">
        <span class="hex-hash">#</span>
        <input
          class="hex-text-input"
          maxLength={6}
          onInput={(event) => {
            const raw = event.currentTarget.value.trim().replace(/^#/, "");
            if (/^[0-9A-Fa-f]{6}$/.test(raw)) {
              props.onChange(`#${raw}`);
            }
          }}
          type="text"
          value={props.color.replace(/^#/, "").toUpperCase()}
        />
      </div>
    </div>
  );
}

function hsvToHex(h: number, s: number, v: number): string {
  const satRatio = s / 100;
  const valRatio = v / 100;
  const i = Math.floor((h / 60) % 6);
  const f = h / 60 - i;
  const p = valRatio * (1 - satRatio);
  const q = valRatio * (1 - f * satRatio);
  const t = valRatio * (1 - (1 - f) * satRatio);
  let r = 0;
  let g = 0;
  let b = 0;
  switch (i) {
    case 0:
      r = valRatio;
      g = t;
      b = p;
      break;
    case 1:
      r = q;
      g = valRatio;
      b = p;
      break;
    case 2:
      r = p;
      g = valRatio;
      b = t;
      break;
    case 3:
      r = p;
      g = q;
      b = valRatio;
      break;
    case 4:
      r = t;
      g = p;
      b = valRatio;
      break;
    case 5:
      r = valRatio;
      g = p;
      b = q;
      break;
  }
  const toHex = (value: number) =>
    Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToHsv(hex: string): { h: number; s: number; v: number } {
  let color = hex.replace(/^#/, "");
  if (color.length === 3) {
    color = color
      .split("")
      .map((character) => character + character)
      .join("");
  }
  if (color.length !== 6) {
    return { h: 140, s: 66, v: 87 };
  }
  const red = Number.parseInt(color.substring(0, 2), 16) / 255;
  const green = Number.parseInt(color.substring(2, 4), 16) / 255;
  const blue = Number.parseInt(color.substring(4, 6), 16) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  const saturation = maximum === 0 ? 0 : delta / maximum;
  if (maximum !== minimum) {
    switch (maximum) {
      case red:
        hue = (green - blue) / delta + (green < blue ? 6 : 0);
        break;
      case green:
        hue = (blue - red) / delta + 2;
        break;
      case blue:
        hue = (red - green) / delta + 4;
        break;
    }
    hue /= 6;
  }
  return {
    h: Math.round(hue * 360),
    s: Math.round(saturation * 100),
    v: Math.round(maximum * 100),
  };
}

const SELECTABLE_ICONS_LIST: readonly IconName[] = [
  // Linha 1
  "folder",
  "dollar",
  "book",
  "graduationCap",
  "edit",
  "fountainPen",

  // Linha 2
  "codeBraces",
  "terminal",
  "music",
  "cupcake",
  "wand",
  "palette",

  // Linha 3
  "stethoscope",
  "flower",
  "lotus",
  "briefcase",
  "barChart",
  "kettlebell",

  // Linha 4
  "dumbbell",
  "notebook",
  "scale",
  "globeStand",
  "plane",
  "globe",

  // Linha 5
  "wrench",
  "paw",
  "flask",
  "brain",
  "heart",
  "plant",
];
