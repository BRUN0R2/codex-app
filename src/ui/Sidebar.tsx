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
import { Icon } from "./Icon";

export interface SidebarProps {
  readonly collapsed: boolean;
  readonly controller: AppController;
  readonly onOpenSettings: () => void;
}

export function Sidebar(props: SidebarProps) {
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal("");
  const [projectsExpanded, setProjectsExpanded] = createSignal(true);
  const [recentsExpanded, setRecentsExpanded] = createSignal(true);
  const [accountMenuOpen, setAccountMenuOpen] = createSignal(false);
  let sidebarElement: HTMLElement | undefined;
  const grouped = createMemo(() =>
    props.controller.projects().map((project) => ({
      project,
      threads: props.controller
        .threads()
        .filter((thread) => pathsEqual(thread.cwd, project.path))
        .sort((left, right) => right.updatedAt - left.updatedAt),
    })),
  );
  const ungrouped = createMemo(() =>
    props.controller
      .threads()
      .filter(
        (thread) =>
          !props.controller.projects().some((project) => pathsEqual(project.path, thread.cwd)),
      )
      .sort((left, right) => right.updatedAt - left.updatedAt),
  );

  createEffect(() => {
    if (props.collapsed) {
      setAccountMenuOpen(false);
    }
  });

  function closeAccountMenuFromPointer(event: PointerEvent): void {
    if (event.target instanceof Node && !sidebarElement?.contains(event.target)) {
      setAccountMenuOpen(false);
    }
  }

  function closeAccountMenuFromKeyboard(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      setAccountMenuOpen(false);
    }
  }

  onMount(() => {
    document.addEventListener("pointerdown", closeAccountMenuFromPointer);
    document.addEventListener("keydown", closeAccountMenuFromKeyboard);
  });
  onCleanup(() => {
    document.removeEventListener("pointerdown", closeAccountMenuFromPointer);
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

  return (
    <aside class="sidebar" classList={{ collapsed: props.collapsed }} ref={sidebarElement}>
      <header class="sidebar-header">
        <button class="brand-button" onClick={props.onOpenSettings} type="button">
          <span class="brand-compact">
            <Icon name="bot" size={18} />
          </span>
          <Show when={!props.collapsed}>
            <span class="brand-label">Codex</span>
            <Icon name="chevronDown" size={13} />
          </Show>
        </button>
      </header>

      <button
        class="new-thread-button"
        disabled={props.controller.busy()}
        onClick={() => void props.controller.newThread()}
        title="Novo chat"
        type="button"
      >
        <Icon name="edit" size={17} />
        <Show when={!props.collapsed}>
          <span>Novo chat</span>
        </Show>
      </button>

      <div class="sidebar-scroll">
        <Show when={!props.collapsed}>
          <SidebarSectionHeading
            expanded={projectsExpanded()}
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

        <Show when={props.collapsed || projectsExpanded()}>
          <Show
            when={grouped().length > 0}
            fallback={
              <button
                class="empty-project-button"
                onClick={() => void props.controller.chooseWorkspace()}
                title="Abrir uma pasta"
                type="button"
              >
                <Icon name="folder" />
                <Show when={!props.collapsed}>
                  <span>Abrir uma pasta</span>
                </Show>
              </button>
            }
          >
            <For each={grouped()}>
              {(group) => (
                <ProjectGroup
                  collapsed={props.collapsed}
                  controller={props.controller}
                  onBeginRename={beginRename}
                  onSubmitRename={submitRename}
                  project={group.project}
                  renameValue={renameValue()}
                  renamingId={renamingId()}
                  setRenameValue={setRenameValue}
                  threads={group.threads}
                />
              )}
            </For>
          </Show>
        </Show>

        <Show when={!props.collapsed}>
          <SidebarSectionHeading
            expanded={recentsExpanded()}
            label="Recentes"
            onToggle={() => setRecentsExpanded((value) => !value)}
          />
          <Show when={recentsExpanded()}>
            <Show when={ungrouped().length > 0} fallback={<p class="sidebar-empty">Nenhum chat</p>}>
              <For each={ungrouped()}>
                {(thread) => (
                  <ThreadButton
                    controller={props.controller}
                    onBeginRename={beginRename}
                    onSubmitRename={submitRename}
                    renameValue={renameValue()}
                    renaming={renamingId() === thread.id}
                    setRenameValue={setRenameValue}
                    thread={thread}
                  />
                )}
              </For>
            </Show>
            <Show when={props.controller.threadsNextCursor() !== null}>
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
          onClick={() => {
            if (props.collapsed) {
              props.onOpenSettings();
              return;
            }
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
        <Icon name={props.expanded ? "chevronDown" : "chevronRight"} size={13} />
        <span>{props.label}</span>
      </button>
      {props.children}
    </div>
  );
}

interface ProjectGroupProps {
  readonly collapsed: boolean;
  readonly controller: AppController;
  readonly onBeginRename: (thread: CodexThread) => void;
  readonly onSubmitRename: (event: SubmitEvent) => Promise<void>;
  readonly project: ProjectRecord;
  readonly renameValue: string;
  readonly renamingId: string | null;
  readonly setRenameValue: (value: string) => void;
  readonly threads: readonly CodexThread[];
}

function ProjectGroup(props: ProjectGroupProps) {
  return (
    <section class="project-group">
      <div
        class="project-row"
        classList={{ selected: pathsEqual(props.controller.workspace(), props.project.path) }}
      >
        <button
          class="project-main"
          disabled={
            props.controller.turnBusy() &&
            !pathsEqual(props.controller.currentThread()?.cwd ?? null, props.project.path)
          }
          onClick={() => props.controller.selectProject(props.project.path)}
          title={props.project.path}
          type="button"
        >
          <Icon name="folder" />
          <Show when={!props.collapsed}>
            <span>{props.project.name}</span>
          </Show>
        </button>
        <Show when={!props.collapsed}>
          <div class="row-actions">
            <button
              aria-label={`Nova tarefa em ${props.project.name}`}
              disabled={props.controller.turnBusy()}
              onClick={() => void props.controller.newThread(props.project.path)}
              title="Nova tarefa"
              type="button"
            >
              <Icon name="edit" size={14} />
            </button>
            <button
              aria-label={`Remover ${props.project.name} da barra lateral`}
              onClick={() => props.controller.removeProject(props.project.path)}
              title="Remover da barra lateral"
              type="button"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        </Show>
      </div>
      <Show when={!props.collapsed}>
        <div class="project-threads">
          <For each={props.threads}>
            {(thread) => (
              <ThreadButton
                controller={props.controller}
                onBeginRename={props.onBeginRename}
                onSubmitRename={props.onSubmitRename}
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
        </div>
      </Show>
    </section>
  );
}

interface ThreadButtonProps {
  readonly controller: AppController;
  readonly onBeginRename: (thread: CodexThread) => void;
  readonly onSubmitRename: (event: SubmitEvent) => Promise<void>;
  readonly renameValue: string;
  readonly renaming: boolean;
  readonly setRenameValue: (value: string) => void;
  readonly thread: CodexThread;
}

function ThreadButton(props: ThreadButtonProps) {
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
          <button
            aria-label="Renomear tarefa"
            onClick={() => props.onBeginRename(props.thread)}
            title="Renomear"
            type="button"
          >
            <Icon name="edit" size={13} />
          </button>
          <button
            aria-label="Arquivar tarefa"
            onClick={() => void props.controller.archiveThread(props.thread.id)}
            title="Arquivar"
            type="button"
          >
            <Icon name="archive" size={13} />
          </button>
        </div>
      </Show>
    </div>
  );
}

export function threadTitle(thread: CodexThread): string {
  return (thread.name ?? thread.preview) || "Nova tarefa";
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
