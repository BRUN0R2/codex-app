import { Show } from "solid-js";

import type { CodexThread } from "../../shared/codex/types";
import { MoreIcon } from "../../shared/components/Icons";
import { threadTitle } from "./threadLibrary";

interface ThreadRowProps {
  active: boolean;
  compact?: boolean;
  menuOpen: boolean;
  onArchive: () => void;
  onCancelRename: () => void;
  onOpen: () => void;
  onRename: () => void;
  onSubmitRename: (event: SubmitEvent) => Promise<void>;
  onToggleMenu: () => void;
  pending: boolean;
  renameValue: string;
  renaming: boolean;
  setRenameValue: (value: string) => void;
  thread: CodexThread;
}

export function ThreadRow(props: ThreadRowProps) {
  return (
    <div
      class="project-task-row"
      classList={{ "project-task-active": props.active, compact: props.compact }}
    >
      <Show
        when={!props.renaming}
        fallback={
          <form class="project-task-rename" onSubmit={props.onSubmitRename}>
            <input
              aria-label="Nome da tarefa"
              autofocus
              onInput={(event) => props.setRenameValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  props.onCancelRename();
                }
              }}
              value={props.renameValue}
            />
          </form>
        }
      >
        <button
          aria-current={props.active ? "page" : undefined}
          class="project-task"
          onClick={props.onOpen}
          type="button"
        >
          <span>{threadTitle(props.thread)}</span>
          <Show when={props.pending}>
            <span aria-label="Tarefa em andamento" class="task-spinner" />
          </Show>
        </button>
        <button
          aria-label={`Opções para ${threadTitle(props.thread)}`}
          aria-expanded={props.menuOpen}
          aria-haspopup="menu"
          class="project-task-menu sidebar-label"
          classList={{ active: props.menuOpen }}
          onClick={props.onToggleMenu}
          title="Mais opções"
          type="button"
        >
          <MoreIcon size={14} />
        </button>
        <Show when={props.menuOpen}>
          <div class="sidebar-context-menu thread-context-menu" role="menu">
            <button onClick={props.onRename} role="menuitem" type="button">
              Renomear
            </button>
            <button
              class="danger"
              onClick={props.onArchive}
              role="menuitem"
              type="button"
            >
              Arquivar
            </button>
          </div>
        </Show>
      </Show>
    </div>
  );
}
