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

import type { CodexThread, ProjectRecord } from "../contracts/types";
import type { AppController } from "../state/createAppController";
import { pathsEqual } from "../state/projects";
import { CodexGlyph } from "./CodexGlyph";
import { Icon } from "./Icon";

export interface SidebarProps {
  readonly collapsed: boolean;
  readonly controller: AppController;
  readonly inert: boolean;
  readonly onOpenSettings: () => void;
}

export function Sidebar(props: SidebarProps) {
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal("");
  const [projectsExpanded, setProjectsExpanded] = createSignal(true);
  const [pinnedExpanded, setPinnedExpanded] = createSignal(true);
  const [showAllProjects, setShowAllProjects] = createSignal(false);
  const [projectExpansionOverrides, setProjectExpansionOverrides] = createSignal<
    Readonly<Record<string, boolean>>
  >({});
  const [expandedProjectThreadLists, setExpandedProjectThreadLists] = createSignal<
    ReadonlySet<string>
  >(new Set());
  const [recentsExpanded, setRecentsExpanded] = createSignal(true);
  const [archivedExpanded, setArchivedExpanded] = createSignal(false);
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
        .filter((thread) => pathsEqual(thread.cwd, project.path))
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
    return grouped().slice(0, 5);
  });
  const ungrouped = createMemo(() =>
    props.controller
      .threads()
      .filter(
        (thread) =>
          normalizedSearchQuery().length === 0 || matchesThread(thread, normalizedSearchQuery()),
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 8),
  );
  const archivedMatches = createMemo(() =>
    props.controller
      .archivedThreads()
      .filter(
        (thread) =>
          normalizedSearchQuery().length === 0 || matchesThread(thread, normalizedSearchQuery()),
      )
      .sort((left, right) => right.updatedAt - left.updatedAt),
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

  function beginRename(thread: CodexThread): void {
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
    if (normalizedSearchQuery().length > 0) {
      return true;
    }
    const override = projectExpansionOverrides()[project.path];
    if (override !== undefined) {
      return override;
    }
    return (
      pathsEqual(props.controller.workspace(), project.path) ||
      pathsEqual(props.controller.currentThread()?.cwd ?? null, project.path)
    );
  }

  function toggleProject(project: ProjectRecord): void {
    const nextExpanded = !isProjectExpanded(project);
    setProjectExpansionOverrides((current) => ({
      ...current,
      [project.path]: nextExpanded,
    }));
  }

  function toggleProjectThreadList(project: ProjectRecord): void {
    setExpandedProjectThreadLists((current) => {
      const next = new Set(current);
      if (next.has(project.path)) {
        next.delete(project.path);
      } else {
        next.add(project.path);
      }
      return next;
    });
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
            <CodexGlyph size={18} />
            <strong>Codex</strong>
            <Icon name="chevronDown" size={12} />
          </button>
          <Show when={brandMenuOpen()}>
            <div aria-label="Codex" class="account-menu brand-menu" role="menu">
              <button
                onClick={() => {
                  setBrandMenuOpen(false);
                  void props.controller.refreshRateLimits();
                }}
                role="menuitem"
                type="button"
              >
                <Icon name="reset" size={15} />
                <span>Atualizar uso</span>
              </button>
              <button
                onClick={() => {
                  setBrandMenuOpen(false);
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
                  setBrandMenuOpen(false);
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
        </Show>
      </header>

      <nav aria-label="Ações principais" class="sidebar-primary-nav">
        <button
          aria-current={props.controller.currentThread() === null ? "page" : undefined}
          class="new-thread-button"
          classList={{ active: props.controller.currentThread() === null }}
          onClick={() => {
            props.controller.newThread();
          }}
          title="Novo chat"
          type="button"
        >
          <span class="sidebar-item-icon">
            <Icon name="edit" size={16} />
          </span>
          <Show when={!props.collapsed}>
            <span class="sidebar-row-label">Novo chat</span>
          </Show>
        </button>
        <button
          aria-expanded={searchOpen()}
          aria-label="Pesquisar projetos e tarefas"
          class="search-nav-button"
          classList={{ active: searchOpen() }}
          onClick={() => {
            setAccountMenuOpen(false);
            setSearchOpen((value) => !value);
            queueMicrotask(() => searchInput?.focus());
          }}
          title="Pesquisar (Ctrl+K)"
          type="button"
        >
          <span class="sidebar-item-icon">
            <Icon name="search" size={16} />
          </span>
          <Show when={!props.collapsed}>
            <span class="sidebar-row-label">Pesquisar</span>
            <kbd class="sidebar-shortcut">Ctrl K</kbd>
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
        <Show when={!props.collapsed && pinnedThreads().length > 0}>
          <SidebarSectionHeading
            expanded={pinnedExpanded() || normalizedSearchQuery().length > 0}
            label="Fixados"
            onToggle={() => setPinnedExpanded((value) => !value)}
          />
          <Show when={pinnedExpanded() || normalizedSearchQuery().length > 0}>
            <div class="pinned-threads">
              <For each={pinnedThreads()}>
                {(thread) => (
                  <ThreadButton
                    controller={props.controller}
                    onBeginRename={beginRename}
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
            expanded={projectsExpanded() || normalizedSearchQuery().length > 0}
            label="Projetos"
            onToggle={() => setProjectsExpanded((value) => !value)}
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

        <Show when={props.collapsed || projectsExpanded() || normalizedSearchQuery().length > 0}>
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
                  onSubmitRename={submitRename}
                  onToggleExpanded={() => toggleProject(group.project)}
                  onToggleThreadList={() => toggleProjectThreadList(group.project)}
                  project={group.project}
                  renameValue={renameValue()}
                  renamingId={renamingId()}
                  setRenameValue={setRenameValue}
                  threadListExpanded={expandedProjectThreadLists().has(group.project.path)}
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
          />
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
            !props.collapsed &&
            (archivedMatches().length > 0 || props.controller.archivedThreadsNextCursor() !== null)
          }
        >
          <SidebarSectionHeading
            expanded={archivedExpanded() || normalizedSearchQuery().length > 0}
            label="Arquivadas"
            onToggle={() => setArchivedExpanded((value) => !value)}
          />
          <Show when={archivedExpanded() || normalizedSearchQuery().length > 0}>
            <For each={archivedMatches()}>
              {(thread) => <ArchivedThreadButton controller={props.controller} thread={thread} />}
            </For>
            <Show
              when={
                normalizedSearchQuery().length === 0 &&
                props.controller.archivedThreadsNextCursor() !== null
              }
            >
              <button
                class="load-more-button"
                disabled={props.controller.pendingOperations() > 0}
                onClick={() => void props.controller.loadMoreArchivedThreads()}
                type="button"
              >
                Carregar mais
              </button>
            </Show>
          </Show>
        </Show>
        <Show
          when={
            normalizedSearchQuery().length > 0 &&
            grouped().length === 0 &&
            ungrouped().length === 0 &&
            archivedMatches().length === 0
          }
        >
          <p class="sidebar-search-empty">Nenhum projeto ou tarefa encontrado.</p>
        </Show>
      </div>

      <footer class="sidebar-footer">
        <Show when={!props.collapsed && accountMenuOpen()}>
          <div aria-label="Conta" class="account-menu" id="account-menu" role="menu">
            <div class="account-menu-identity" role="presentation">
              <span class="account-avatar">{accountInitial(props.controller)}</span>
              <strong>{accountLabel(props.controller)}</strong>
            </div>
            <hr class="account-menu-separator" />
            <button
              onClick={() => void props.controller.refreshRateLimits()}
              role="menuitem"
              type="button"
            >
              <Icon name="reset" size={15} />
              <span>Uso restante</span>
              <small>{remainingUsageLabel(props.controller)}</small>
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
            setBrandMenuOpen(false);
            setAccountMenuOpen((value) => !value);
          }}
          title="Conta"
          type="button"
        >
          <span class="account-avatar">{accountInitial(props.controller)}</span>
          <Show when={!props.collapsed}>
            <span class="account-label">
              <strong>{accountLabel(props.controller)}</strong>
            </span>
            <Icon name="more" size={16} />
          </Show>
        </button>
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
    <div class="sidebar-section-heading">
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
  readonly controller: AppController;
  readonly expanded: boolean;
  readonly onBeginRename: (thread: CodexThread) => void;
  readonly onSubmitRename: (event: SubmitEvent) => Promise<void>;
  readonly onToggleExpanded: () => void;
  readonly onToggleThreadList: () => void;
  readonly project: ProjectRecord;
  readonly renameValue: string;
  readonly renamingId: string | null;
  readonly setRenameValue: (value: string) => void;
  readonly threadListExpanded: boolean;
  readonly threads: readonly CodexThread[];
}

function ProjectGroup(props: ProjectGroupProps) {
  let menu: HTMLDetailsElement | undefined;
  const isProjectPageActive = () =>
    props.controller.currentThread() === null &&
    pathsEqual(props.controller.workspace(), props.project.path);
  const visibleThreads = () =>
    props.threadListExpanded || props.threads.length <= 5
      ? props.threads
      : props.threads.slice(0, 5);

  return (
    <section class="project-group" classList={{ expanded: props.expanded }}>
      <div class="project-row" classList={{ selected: isProjectPageActive() }}>
        <button
          aria-current={isProjectPageActive() ? "page" : undefined}
          aria-expanded={props.expanded}
          class="project-main"
          onClick={() => {
            props.onToggleExpanded();
            props.controller.selectProject(props.project.path);
          }}
          title={props.project.path}
          type="button"
        >
          <span class="project-icon-slot">
            <Icon name={props.expanded ? "folderOpen" : "folder"} size={16} />
          </span>
          <Show when={!props.collapsed}>
            <span class="sidebar-row-label">{props.project.name}</span>
          </Show>
        </button>
        <Show when={!props.collapsed}>
          <div class="row-actions">
            <button
              aria-label={`Nova tarefa em ${props.project.name}`}
              onClick={() => {
                props.controller.newThread(props.project.path);
              }}
              title="Nova tarefa"
              type="button"
            >
              <Icon name="edit" size={14} />
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
                    props.controller.removeProject(props.project.path);
                  }}
                  role="menuitem"
                  type="button"
                >
                  <Icon name="close" size={14} /> Remover da barra lateral
                </button>
              </div>
            </details>
          </div>
        </Show>
      </div>
      <Show when={!props.collapsed && props.expanded}>
        <div class="project-threads">
          <For each={visibleThreads()}>
            {(thread) => (
              <ThreadButton
                controller={props.controller}
                onBeginRename={props.onBeginRename}
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
  readonly controller: AppController;
  readonly onBeginRename: (thread: CodexThread) => void;
  readonly onSubmitRename: (event: SubmitEvent) => Promise<void>;
  readonly onTogglePinned: () => void;
  readonly pinned: boolean;
  readonly renameValue: string;
  readonly renaming: boolean;
  readonly setRenameValue: (value: string) => void;
  readonly thread: CodexThread;
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
          disabled={props.controller.openingThreadId() === props.thread.id}
          onClick={() => void props.controller.openThread(props.thread.id)}
          title={threadTitle(props.thread)}
          type="button"
        >
          <span>{threadTitle(props.thread)}</span>
          <Show when={props.thread.status.type === "active"}>
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
                disabled={props.thread.status.type === "active"}
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
                disabled={props.thread.status.type === "active" || props.thread.turns.length === 0}
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
                disabled={props.thread.status.type === "active"}
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
                disabled={props.thread.status.type === "active"}
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

function ArchivedThreadButton(props: {
  readonly controller: AppController;
  readonly thread: CodexThread;
}) {
  async function deleteThread(): Promise<void> {
    await props.controller.deleteThread(props.thread.id);
  }

  return (
    <div class="thread-row archived-thread-row">
      <span class="thread-main" title={threadTitle(props.thread)}>
        <span>{threadTitle(props.thread)}</span>
      </span>
      <div class="thread-actions">
        <button
          aria-label="Restaurar tarefa"
          onClick={() => void props.controller.unarchiveThread(props.thread.id)}
          title="Restaurar"
          type="button"
        >
          <Icon name="reset" size={13} />
        </button>
        <button
          aria-label="Excluir tarefa permanentemente"
          onClick={() => void deleteThread()}
          title="Excluir permanentemente"
          type="button"
        >
          <Icon name="close" size={13} />
        </button>
      </div>
    </div>
  );
}

export function threadTitle(thread: CodexThread): string {
  return (thread.name ?? thread.preview) || "Nova tarefa";
}

function matchesProject(project: ProjectRecord, query: string): boolean {
  return `${project.name}\n${project.path}`.toLocaleLowerCase("pt-BR").includes(query);
}

function matchesThread(thread: CodexThread, query: string): boolean {
  return `${threadTitle(thread)}\n${thread.cwd}`.toLocaleLowerCase("pt-BR").includes(query);
}

function accountLabel(controller: AppController): string {
  return controller.account()?.account?.email ?? "Conta ChatGPT";
}

function accountInitial(controller: AppController): string {
  return accountLabel(controller).slice(0, 1).toLocaleUpperCase("pt-BR");
}

function remainingUsageLabel(controller: AppController): string {
  const usedPercent = controller.rateLimits()?.rateLimits.primary?.usedPercent;
  if (usedPercent === undefined) {
    return "—";
  }
  return `${Math.max(0, Math.round(100 - usedPercent))}%`;
}
