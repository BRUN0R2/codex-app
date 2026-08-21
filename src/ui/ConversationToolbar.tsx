import { onCleanup, onMount } from "solid-js";
import type { CodexThread } from "../contracts/types";
import { Icon } from "./Icon";

export function ConversationToolbar(props: {
  readonly onOpenWorkspace: (path: string) => void;
  readonly thread: CodexThread;
}) {
  let menu: HTMLDetailsElement | undefined;
  let trigger: HTMLElement | undefined;
  const title = () => props.thread.name?.trim() || props.thread.preview.trim() || "Nova tarefa";
  const workspace = () => props.thread.projectPath ?? props.thread.cwd;

  function openWorkspace(): void {
    if (menu !== undefined) {
      menu.open = false;
    }
    props.onOpenWorkspace(workspace());
  }

  function handleDocumentPointerDown(event: PointerEvent): void {
    if (menu?.open === true && (!(event.target instanceof Node) || !menu.contains(event.target))) {
      menu.open = false;
    }
  }

  function handleDocumentKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || menu?.open !== true) {
      return;
    }
    event.preventDefault();
    menu.open = false;
    trigger?.focus();
  }

  onMount(() => {
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    document.addEventListener("keydown", handleDocumentKeyDown);
  });
  onCleanup(() => {
    document.removeEventListener("pointerdown", handleDocumentPointerDown);
    document.removeEventListener("keydown", handleDocumentKeyDown);
  });

  return (
    <header class="conversation-toolbar">
      <div class="conversation-toolbar-title" title={title()}>
        <span class="conversation-toolbar-project-icon">
          <Icon name="folder" size={14} />
        </span>
        <strong>{title()}</strong>
      </div>
      <details class="conversation-open-menu" ref={menu}>
        <summary aria-label="Escolher onde abrir o workspace" ref={trigger}>
          <span>Abrir em</span>
          <Icon name="chevronDown" size={12} />
        </summary>
        <div class="conversation-open-menu-popover" role="menu">
          <button onClick={openWorkspace} role="menuitem" type="button">
            <Icon name="folderOpen" size={15} />
            <span>Explorador de Arquivos</span>
          </button>
        </div>
      </details>
    </header>
  );
}
