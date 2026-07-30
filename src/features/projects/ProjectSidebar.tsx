import { For, Show, createMemo, createSignal } from "solid-js";

import type { CodexSession } from "../session/createCodexSession";
import {
  FolderIcon,
  MoreIcon,
  PlusIcon,
  SquarePenIcon,
} from "../../shared/components/Icons";
import type { CodexThread } from "../../shared/codex/types";
import { pathsEqual } from "./projectStore";
import {
  recentThreads,
  threadTitle,
  threadsForProject,
} from "./threadLibrary";
import { ThreadRow } from "./ThreadRow";

interface ProjectSidebarProps {
  session: CodexSession;
}

export function ProjectSidebar(props: ProjectSidebarProps) {
  const [openMenu, setOpenMenu] = createSignal<string | null>(null);
  const [renamingThreadId, setRenamingThreadId] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal("");
  const projectGroups = createMemo(() =>
    props.session.projects().map((project) => ({
      project,
      threads: threadsForProject(props.session.threads(), project.path),
    })),
  );
  const recents = createMemo(() =>
    recentThreads(props.session.threads(), props.session.projects()),
  );

  const closeMenu = () => setOpenMenu(null);
  const toggleMenu = (key: string) =>
    setOpenMenu((current) => (current === key ? null : key));

  function beginRename(thread: CodexThread) {
    closeMenu();
    setRenameValue(threadTitle(thread));
    setRenamingThreadId(thread.id);
  }

  async function submitRename(event: SubmitEvent) {
    event.preventDefault();
    const id = renamingThreadId();
    if (id === null) {
      return;
    }
    const renamed = await props.session.renameThread(id, renameValue());
    if (renamed) {
      setRenamingThreadId(null);
    }
  }

  return (
    <>
      <Show when={openMenu() !== null}>
        <button
          aria-label="Fechar menu"
          class="sidebar-menu-dismiss"
          onClick={closeMenu}
          type="button"
        />
      </Show>

      <div
        class="sidebar-library"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            closeMenu();
            setRenamingThreadId(null);
          }
        }}
      >
        <section class="project-section">
          <div class="sidebar-section-title">
            <span class="sidebar-label">Projetos</span>
            <button
              aria-label="Adicionar projeto"
              onClick={() => void props.session.chooseWorkspace()}
              title="Adicionar projeto"
              type="button"
            >
              <PlusIcon size={14} />
            </button>
          </div>

          <Show
            when={projectGroups().length > 0}
            fallback={
              <button
                class="project-empty"
                onClick={() => void props.session.chooseWorkspace()}
                type="button"
              >
                <FolderIcon size={16} />
                <span class="sidebar-label">Abrir uma pasta</span>
              </button>
            }
          >
            <For each={projectGroups()}>
              {({ project, threads }) => {
                const projectMenuKey = `project:${project.path}`;
                const selected = () =>
                  pathsEqual(props.session.workspace(), project.path);
                return (
                  <div class="project-group">
                    <div class="project-root" classList={{ selected: selected() }}>
                      <button
                        aria-label={`Abrir projeto ${project.name}`}
                        class="project-root-main"
                        onClick={() => void props.session.selectProject(project.path)}
                        type="button"
                      >
                        <FolderIcon size={16} />
                        <span class="sidebar-label">{project.name}</span>
                      </button>
                      <div class="project-root-actions sidebar-label">
                        <button
                          aria-label={`Mais opções para ${project.name}`}
                          aria-expanded={openMenu() === projectMenuKey}
                          aria-haspopup="menu"
                          classList={{ active: openMenu() === projectMenuKey }}
                          onClick={() => toggleMenu(projectMenuKey)}
                          title="Mais opções"
                          type="button"
                        >
                          <MoreIcon size={15} />
                        </button>
                        <button
                          aria-label={`Nova tarefa em ${project.name}`}
                          onClick={() =>
                            void props.session.newThreadForProject(project.path)
                          }
                          title="Nova tarefa"
                          type="button"
                        >
                          <SquarePenIcon size={15} />
                        </button>
                      </div>
                      <Show when={openMenu() === projectMenuKey}>
                        <div class="sidebar-context-menu" role="menu">
                          <button
                            onClick={() => {
                              closeMenu();
                              void props.session.newThreadForProject(project.path);
                            }}
                            role="menuitem"
                            type="button"
                          >
                            Nova tarefa
                          </button>
                          <button
                            class="danger"
                            onClick={() => {
                              closeMenu();
                              void props.session.removeProject(project.path);
                            }}
                            role="menuitem"
                            type="button"
                          >
                            Remover da barra lateral
                          </button>
                        </div>
                      </Show>
                    </div>

                    <Show
                      when={threads.length > 0}
                      fallback={
                        <ProjectTaskPlaceholder
                          state={props.session.threadLibraryState()}
                        />
                      }
                    >
                      <For each={threads}>
                        {(thread) => (
                          <ThreadRow
                            active={props.session.threadId() === thread.id}
                            menuOpen={openMenu() === `thread:${thread.id}`}
                            onArchive={() =>
                              void props.session.archiveThread(thread.id)
                            }
                            onCancelRename={() => setRenamingThreadId(null)}
                            onOpen={() => void props.session.openThread(thread.id)}
                            onRename={() => beginRename(thread)}
                            onSubmitRename={submitRename}
                            onToggleMenu={() =>
                              toggleMenu(`thread:${thread.id}`)
                            }
                            pending={
                              props.session.openingThreadId() === thread.id ||
                              (props.session.threadId() === thread.id &&
                                props.session.busy())
                            }
                            renameValue={renameValue()}
                            renaming={renamingThreadId() === thread.id}
                            setRenameValue={setRenameValue}
                            thread={thread}
                          />
                        )}
                      </For>
                    </Show>
                  </div>
                );
              }}
            </For>
          </Show>
        </section>

        <section class="recent-section">
          <div class="sidebar-section-title">
            <span class="sidebar-label">Recentes</span>
          </div>
          <Show
            when={recents().length > 0}
            fallback={
              <ProjectTaskPlaceholder
                state={props.session.threadLibraryState()}
              />
            }
          >
            <For each={recents()}>
              {(thread) => (
                <ThreadRow
                  active={props.session.threadId() === thread.id}
                  compact
                  menuOpen={openMenu() === `thread:${thread.id}`}
                  onArchive={() => void props.session.archiveThread(thread.id)}
                  onCancelRename={() => setRenamingThreadId(null)}
                  onOpen={() => void props.session.openThread(thread.id)}
                  onRename={() => beginRename(thread)}
                  onSubmitRename={submitRename}
                  onToggleMenu={() => toggleMenu(`thread:${thread.id}`)}
                  pending={
                    props.session.openingThreadId() === thread.id ||
                    (props.session.threadId() === thread.id &&
                      props.session.busy())
                  }
                  renameValue={renameValue()}
                  renaming={renamingThreadId() === thread.id}
                  setRenameValue={setRenameValue}
                  thread={thread}
                />
              )}
            </For>
          </Show>
          <Show when={props.session.threadsNextCursor() !== null}>
            <button
              class="thread-load-more"
              disabled={props.session.threadLibraryState() === "loading"}
              onClick={() => void props.session.loadMoreThreads()}
              type="button"
            >
              Carregar mais
            </button>
          </Show>
        </section>
      </div>
    </>
  );
}

function ProjectTaskPlaceholder(props: { state: string }) {
  const label = () => {
    switch (props.state) {
      case "loading":
        return "Carregando tarefas…";
      case "failed":
        return "Falha ao carregar tarefas";
      default:
        return "Nenhuma tarefa";
    }
  };
  return <p class="project-task-empty">{label()}</p>;
}
