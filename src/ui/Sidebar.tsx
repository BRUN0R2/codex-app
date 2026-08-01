import { createMemo, createSignal, For, Show } from "solid-js";

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
    <aside class="sidebar" classList={{ collapsed: props.collapsed }}>
      <header class="sidebar-header">
        <button class="brand-button" onClick={props.onOpenSettings} type="button">
          <span class="brand-mark">C</span>
          <Show when={!props.collapsed}>
            <span>Codex</span>
            <Icon name="chevronDown" size={14} />
          </Show>
        </button>
      </header>

      <button
        class="new-thread-button"
        disabled={props.controller.busy()}
        onClick={() => void props.controller.newThread()}
        title="Nova tarefa"
        type="button"
      >
        <Icon name="plus" />
        <Show when={!props.collapsed}>
          <span>Nova tarefa</span>
        </Show>
      </button>

      <div class="sidebar-scroll">
        <Show when={!props.collapsed}>
          <div class="sidebar-section-heading">
            <span>Projetos</span>
            <button
              aria-label="Adicionar projeto"
              onClick={() => void props.controller.chooseWorkspace()}
              type="button"
            >
              <Icon name="plus" size={14} />
            </button>
          </div>
        </Show>

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

        <Show when={!props.collapsed && ungrouped().length > 0}>
          <div class="sidebar-section-heading recent-heading">
            <span>Outras tarefas</span>
          </div>
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

        <Show when={!props.collapsed && props.controller.threadsNextCursor() !== null}>
          <button
            class="load-more-button"
            disabled={props.controller.pendingOperations() > 0}
            onClick={() => void props.controller.loadMoreThreads()}
            type="button"
          >
            Carregar mais
          </button>
        </Show>
      </div>

      <footer class="sidebar-footer">
        <button onClick={props.onOpenSettings} title="Configurações" type="button">
          <span class="account-avatar">{accountInitial(props.controller)}</span>
          <Show when={!props.collapsed}>
            <span class="account-label">
              <strong>{accountLabel(props.controller)}</strong>
              <small>Configurações</small>
            </span>
            <Icon name="settings" size={16} />
          </Show>
        </button>
      </footer>
    </aside>
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
