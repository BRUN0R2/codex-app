import { For, Show, createEffect } from "solid-js";

import type { TimelineEntry } from "../session/createCodexSession";
import { FileIcon, ImageIcon } from "../../shared/components/Icons";

interface TimelineProps {
  busy: boolean;
  entries: TimelineEntry[];
}

export function Timeline(props: TimelineProps) {
  let endMarker: HTMLDivElement | undefined;

  createEffect(() => {
    props.entries.length;
    props.busy;
    queueMicrotask(() => endMarker?.scrollIntoView({ block: "end" }));
  });

  return (
    <div class="timeline">
      <Show
        when={props.entries.length > 0}
        fallback={
          <div class="empty-state">
            <div class="empty-orbit" aria-hidden="true">
              <span>C</span>
            </div>
            <h2>O que vamos construir?</h2>
            <p>
              Descreva uma tarefa, anexe arquivos ou cole uma imagem diretamente
              no campo abaixo.
            </p>
          </div>
        }
      >
        <div class="timeline-content">
          <For each={props.entries}>
            {(entry) =>
              entry.type === "message" ? (
                <article
                  class={`message message-${entry.role}`}
                  classList={{ "message-failed": entry.status === "failed" }}
                >
                  <Show when={entry.phase === "commentary"}>
                    <div class="message-meta">Atualização</div>
                  </Show>
                  <Show when={entry.attachments.length > 0}>
                    <div class="message-attachments">
                      <For each={entry.attachments}>
                        {(attachment) => (
                          <span title={attachment.path}>
                            {attachment.kind === "image" ? (
                              <ImageIcon size={15} />
                            ) : (
                              <FileIcon size={15} />
                            )}
                            {attachment.name}
                          </span>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={entry.text.length > 0}>
                    <div class="message-text">{entry.text}</div>
                  </Show>
                  <Show when={entry.status === "streaming" && entry.role === "assistant"}>
                    <span class="streaming-caret" aria-label="Gerando resposta" />
                  </Show>
                </article>
              ) : (
                <article class="activity-row">
                  <span class={`activity-dot status-${entry.status.toLowerCase()}`} />
                  <div>
                    <strong>{entry.label}</strong>
                    <p>{entry.detail}</p>
                  </div>
                  <span class={`activity-status status-${entry.status.toLowerCase()}`}>
                    {statusLabel(entry.status)}
                  </span>
                </article>
              )
            }
          </For>
          <Show when={props.busy && !hasStreamingAssistant(props.entries)}>
            <div class="thinking-row">
              <span />
              <span />
              <span />
            </div>
          </Show>
          <div ref={endMarker} />
        </div>
      </Show>
    </div>
  );
}

function hasStreamingAssistant(entries: TimelineEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.type === "message" &&
      entry.role === "assistant" &&
      entry.status === "streaming",
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "completed":
      return "concluído";
    case "inProgress":
      return "em andamento";
    case "declined":
      return "recusado";
    case "failed":
      return "falhou";
    default:
      return status;
  }
}
