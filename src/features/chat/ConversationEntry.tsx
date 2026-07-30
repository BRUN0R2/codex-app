import { For, Show } from "solid-js";

import { FileIcon } from "../../shared/components/Icons";
import { ImagePreview } from "./ImagePreview";
import type {
  MessageEntry,
  PlanEntry,
} from "./timelineTypes";

export function MessageView(props: { entry: MessageEntry }) {
  return (
    <article
      class={`message message-${props.entry.role}`}
      classList={{ "message-failed": props.entry.status === "failed" }}
    >
      <Show when={props.entry.phase === "commentary"}>
        <div class="message-meta">Atualização</div>
      </Show>
      <Show when={props.entry.attachments.length > 0}>
        <div class="message-attachments">
          <For each={props.entry.attachments}>
            {(attachment) => (
              attachment.kind === "image" ? (
                <ImagePreview
                  mediaType={attachment.mediaType}
                  name={attachment.name}
                  path={attachment.path}
                />
              ) : (
                <span class="message-file-attachment" title={attachment.path}>
                  <FileIcon size={15} />
                  {attachment.name}
                </span>
              )
            )}
          </For>
        </div>
      </Show>
      <Show when={props.entry.text.length > 0}>
        <div class="message-text">{props.entry.text}</div>
      </Show>
      <Show
        when={
          props.entry.status === "streaming" && props.entry.role === "assistant"
        }
      >
        <span class="streaming-caret" aria-label="Gerando resposta" />
      </Show>
    </article>
  );
}

export function PlanView(props: { entry: PlanEntry }) {
  return (
    <details class="plan-details" open={props.entry.status === "inProgress"}>
      <summary>Plano</summary>
      <div>{props.entry.text}</div>
    </details>
  );
}
