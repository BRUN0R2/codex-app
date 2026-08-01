import { createEffect, For, Show } from "solid-js";

import type { ActivityStatus, FileChange, ThreadItem, UserContent } from "../contracts/types";
import type { AppController } from "../state/createAppController";
import { Icon } from "./Icon";

export function Timeline(props: { readonly controller: AppController }) {
  let scrollElement: HTMLDivElement | undefined;

  createEffect(() => {
    props.controller.items();
    props.controller.turnBusy();
    queueMicrotask(() => {
      if (scrollElement !== undefined) {
        scrollElement.scrollTo({ top: scrollElement.scrollHeight, behavior: "smooth" });
      }
    });
  });

  return (
    <div class="timeline" ref={scrollElement}>
      <div class="timeline-inner">
        <Show
          when={props.controller.items().length > 0}
          fallback={<EmptyConversation controller={props.controller} />}
        >
          <For each={props.controller.items()}>{(item) => <TimelineItem item={item} />}</For>
          <Show when={props.controller.turnBusy()}>
            <div class="thinking-row" role="status">
              <span />
              <span />
              <span />
              <p>Codex está trabalhando</p>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}

function EmptyConversation(props: { readonly controller: AppController }) {
  return (
    <section class="empty-conversation">
      <div class="empty-orb">
        <Icon name="bot" size={28} />
      </div>
      <h2>O que vamos construir?</h2>
      <p>
        Escolha um projeto e descreva o resultado. O engine lê, edita e executa comandos com limites
        explícitos e aprovação quando necessária.
      </p>
      <Show when={props.controller.workspace() === null}>
        <button
          class="secondary-button"
          onClick={() => void props.controller.chooseWorkspace()}
          type="button"
        >
          <Icon name="folder" /> Abrir projeto
        </button>
      </Show>
    </section>
  );
}

function TimelineItem(props: { readonly item: ThreadItem }) {
  switch (props.item.type) {
    case "userMessage":
      return <UserMessage item={props.item} />;
    case "agentMessage":
      return <AgentMessage item={props.item} />;
    case "reasoning":
      return <Reasoning item={props.item} />;
    case "commandExecution":
      return <CommandItem item={props.item} />;
    case "fileChange":
      return <FileChangeItem item={props.item} />;
    case "toolExecution":
      return <ToolItem item={props.item} />;
  }
}

function UserMessage(props: { readonly item: Extract<ThreadItem, { type: "userMessage" }> }) {
  return (
    <article class="message-row user-message-row">
      <div class="message-avatar user-avatar">
        <Icon name="user" size={15} />
      </div>
      <div class="message-content">
        <div class="message-heading">
          <strong>Você</strong>
        </div>
        <For each={props.item.content}>{(content) => <UserContentPart content={content} />}</For>
      </div>
    </article>
  );
}

function UserContentPart(props: { readonly content: UserContent }) {
  switch (props.content.type) {
    case "text":
      return <p class="message-text">{props.content.text}</p>;
    case "localImage":
      return (
        <div class="attachment-line">
          <Icon name="file" size={15} /> Imagem: {fileName(props.content.path)}
        </div>
      );
    case "mention":
      return (
        <div class="attachment-line">
          <Icon name="file" size={15} /> {props.content.name}
        </div>
      );
  }
}

function AgentMessage(props: { readonly item: Extract<ThreadItem, { type: "agentMessage" }> }) {
  return (
    <article
      class="message-row agent-message-row"
      classList={{ commentary: props.item.phase === "commentary" }}
    >
      <div class="message-avatar agent-avatar">
        <Icon name="bot" size={16} />
      </div>
      <div class="message-content">
        <div class="message-heading">
          <strong>Codex</strong>
          <Show when={props.item.phase === "commentary"}>
            <span>atualização</span>
          </Show>
        </div>
        <p class="message-text">{props.item.text}</p>
      </div>
    </article>
  );
}

function Reasoning(props: { readonly item: Extract<ThreadItem, { type: "reasoning" }> }) {
  const summary = () => props.item.summary.filter(Boolean).join("\n");
  const content = () => props.item.content.filter(Boolean).join("\n");
  return (
    <details class="activity-card reasoning-card">
      <summary>
        <span class="activity-icon">
          <Icon name="bot" size={15} />
        </span>
        <span>Raciocínio</span>
        <small>{summary().split("\n")[0] || "Analisando contexto"}</small>
      </summary>
      <Show when={summary().length > 0}>
        <pre>{summary()}</pre>
      </Show>
      <Show when={content().length > 0}>
        <pre>{content()}</pre>
      </Show>
    </details>
  );
}

function CommandItem(props: { readonly item: Extract<ThreadItem, { type: "commandExecution" }> }) {
  return (
    <details
      class={`activity-card status-${props.item.status}`}
      open={props.item.status === "failed"}
    >
      <summary>
        <span class="activity-icon">
          <Icon name="terminal" size={15} />
        </span>
        <span>Comando</span>
        <code>{props.item.command}</code>
        <StatusPill status={props.item.status} />
      </summary>
      <div class="activity-meta">
        <span>{props.item.cwd}</span>
        <Show when={props.item.durationMs !== null}>
          <span>{formatDuration(props.item.durationMs ?? 0)}</span>
        </Show>
        <Show when={props.item.exitCode !== null}>
          <span>exit {props.item.exitCode}</span>
        </Show>
      </div>
      <Show when={props.item.aggregatedOutput !== null}>
        <pre class="terminal-output">{props.item.aggregatedOutput}</pre>
      </Show>
    </details>
  );
}

function FileChangeItem(props: { readonly item: Extract<ThreadItem, { type: "fileChange" }> }) {
  return (
    <section class={`activity-card file-change-card status-${props.item.status}`}>
      <header>
        <span class="activity-icon">
          <Icon name="file" size={15} />
        </span>
        <strong>Alterações em arquivos</strong>
        <StatusPill status={props.item.status} />
      </header>
      <For each={props.item.changes}>{(change) => <Change change={change} />}</For>
    </section>
  );
}

function Change(props: { readonly change: FileChange }) {
  return (
    <details class="diff-block">
      <summary>
        <span class={`change-kind kind-${props.change.kind.type}`}>
          {changeLabel(props.change)}
        </span>
        <code>{props.change.path}</code>
      </summary>
      <pre>
        <For each={props.change.diff.split("\n")}>
          {(line) => (
            <span classList={{ added: line.startsWith("+"), removed: line.startsWith("-") }}>
              {line}
              {"\n"}
            </span>
          )}
        </For>
      </pre>
    </details>
  );
}

function ToolItem(props: { readonly item: Extract<ThreadItem, { type: "toolExecution" }> }) {
  return (
    <details class={`activity-card status-${props.item.status}`}>
      <summary>
        <span class="activity-icon">
          <Icon name="shield" size={15} />
        </span>
        <span>{toolLabel(props.item.name)}</span>
        <small>{props.item.description}</small>
        <StatusPill status={props.item.status} />
      </summary>
      <Show when={props.item.output !== null}>
        <pre>{props.item.output}</pre>
      </Show>
    </details>
  );
}

function StatusPill(props: { readonly status: ActivityStatus }) {
  return <span class={`status-pill status-${props.status}`}>{statusLabel(props.status)}</span>;
}

function statusLabel(status: ActivityStatus): string {
  switch (status) {
    case "completed":
      return "Concluído";
    case "declined":
      return "Recusado";
    case "failed":
      return "Falhou";
    case "inProgress":
      return "Em andamento";
  }
}

function toolLabel(name: string): string {
  switch (name) {
    case "read_file":
      return "Leitura de arquivo";
    case "list_files":
      return "Listagem de arquivos";
    case "search_text":
      return "Busca no projeto";
    case "web_search":
      return "Pesquisa na web";
    default:
      return name;
  }
}

function changeLabel(change: FileChange): string {
  switch (change.kind.type) {
    case "add":
      return "NOVO";
    case "delete":
      return "EXCLUÍDO";
    case "update":
      return "ALTERADO";
  }
}

function fileName(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? path;
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(1)} s`;
}
