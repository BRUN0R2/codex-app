import { For, Match, Show, Switch } from "solid-js";

import {
  AudioIcon,
  FileIcon,
  ImageIcon,
  ReviewIcon,
  SparkIcon,
} from "../../shared/components/Icons";
import { ImagePreview } from "./ImagePreview";
import type {
  MessageEntry,
  PlanEntry,
  ReviewEntry,
  MessageAttachment,
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
            {(attachment) => <MessageAttachmentView attachment={attachment} />}
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

export function ReviewView(props: { entry: ReviewEntry }) {
  return props.entry.event === "entered" ? (
    <div class="review-status-row">
      <ReviewIcon size={14} />
      <span>Iniciou revisão de {props.entry.review}</span>
    </div>
  ) : (
    <article class="review-entry">
      <div class="message-meta">
        <ReviewIcon size={13} />
        Revisão concluída
      </div>
      <div class="message-text">{props.entry.review}</div>
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

function MessageAttachmentView(props: { attachment: MessageAttachment }) {
  return (
    <Switch>
      <Match when={props.attachment.kind === "localImage" ? props.attachment : undefined}>
        {(attachment) => (
          <ImagePreview
            mediaType={attachment().mediaType}
            name={attachment().name}
            path={attachment().path}
          />
        )}
      </Match>
      <Match when={props.attachment.kind === "mention" ? props.attachment : undefined}>
        {(attachment) => (
          <span class="message-file-attachment" title={attachment().path}>
            <FileIcon size={15} />
            {attachment().name}
          </span>
        )}
      </Match>
      <Match when={props.attachment.kind === "skill" ? props.attachment : undefined}>
        {(attachment) => (
          <span class="message-file-attachment" title={attachment().path}>
            <SparkIcon size={15} />
            {attachment().name}
          </span>
        )}
      </Match>
      <Match when={props.attachment.kind === "localAudio" ? props.attachment : undefined}>
        {(attachment) => (
          <span class="message-file-attachment" title={attachment().path}>
            <AudioIcon size={15} />
            {attachment().name}
          </span>
        )}
      </Match>
      <Match when={props.attachment.kind === "remoteImage" ? props.attachment : undefined}>
        {(attachment) => (
          <span
            class="message-file-attachment"
            title={`Origem: ${attachment().source}`}
          >
            <ImageIcon size={15} />
            {attachment().embedded ? "Imagem incorporada" : "Imagem remota"}
          </span>
        )}
      </Match>
      <Match when={props.attachment.kind === "remoteAudio" ? props.attachment : undefined}>
        {(attachment) => (
          <span
            class="message-file-attachment"
            title={`Origem: ${attachment().source}`}
          >
            <AudioIcon size={15} />
            {attachment().embedded ? "Áudio incorporado" : "Áudio remoto"}
          </span>
        )}
      </Match>
    </Switch>
  );
}
