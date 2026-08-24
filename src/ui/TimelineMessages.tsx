import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import type { ThreadItem, UserContent } from "../contracts/types";
import { fileName } from "./activityLabels";
import { presentAssistantText } from "./contentReferenceMarkers";
import { observeElementResize } from "./elementResize";
import { frontendFailureMessage, useFrontendFailureReporter } from "./frontendFailure";
import { Icon } from "./Icon";
import { ImagePreview } from "./ImagePreview";
import { Markdown } from "./Markdown";
import { createCommentaryPresentation } from "./messagePresentation";
import { useTimelineDisclosure } from "./timelineDisclosureContext";

const USER_MESSAGE_COLLAPSED_LINES = 20;
const COPY_FEEDBACK_RESET_MILLISECONDS: number = 2_000;
const MESSAGE_OVERFLOW_EPSILON_PX: number = 1;
const FALLBACK_TITLE_LIMIT_CHARACTERS: number = 160;

export function UserMessage(props: {
  readonly item: Extract<ThreadItem, { type: "userMessage" }>;
}) {
  let bubble: HTMLDivElement | undefined;
  let releaseResizeObservation: (() => void) | undefined;
  let measurementFrame: number | undefined;
  const disclosure = useTimelineDisclosure(() => `user-message:${props.item.id}`);
  const [collapsible, setCollapsible] = createSignal(false);
  const imageContent = createMemo(() =>
    props.item.content.filter(
      (content): content is Extract<UserContent, { type: "localImage" }> =>
        content.type === "localImage",
    ),
  );
  const bubbleContent = createMemo(() =>
    props.item.content.filter((content) => content.type !== "localImage"),
  );

  function measure(): void {
    if (bubble === undefined || disclosure.isOpen()) {
      return;
    }
    setCollapsible(bubble.scrollHeight > bubble.clientHeight + MESSAGE_OVERFLOW_EPSILON_PX);
  }

  function scheduleMeasurement(): void {
    if (measurementFrame !== undefined) {
      return;
    }
    measurementFrame = requestAnimationFrame(() => {
      measurementFrame = undefined;
      measure();
    });
  }

  onMount(() => {
    if (bubble !== undefined) {
      releaseResizeObservation = observeElementResize(bubble, scheduleMeasurement);
    }
    scheduleMeasurement();
  });
  onCleanup(() => {
    releaseResizeObservation?.();
    if (measurementFrame !== undefined) {
      cancelAnimationFrame(measurementFrame);
    }
  });

  return (
    <article class="message-row user-message-row" id={userMessageAnchor(props.item.id)}>
      <div class="message-content">
        <span class="visually-hidden">Você disse:</span>
        <Show when={imageContent().length > 0}>
          <div class="message-image-grid user-message-images">
            <For each={imageContent()}>
              {(content) => (
                <ImagePreview
                  alt={imageContentName(content.path)}
                  class="message-image-preview"
                  name={imageContentName(content.path)}
                  source={content.path}
                />
              )}
            </For>
          </div>
        </Show>
        <Show when={bubbleContent().length > 0}>
          <div
            class="user-message-bubble"
            classList={{
              clamped: !disclosure.isOpen(),
              collapsed: collapsible() && !disclosure.isOpen(),
            }}
            ref={bubble}
            style={{ "--collapsed-lines": USER_MESSAGE_COLLAPSED_LINES }}
          >
            <For each={bubbleContent()}>{(content) => <UserContentPart content={content} />}</For>
          </div>
        </Show>
        <Show when={collapsible()}>
          <button
            aria-expanded={disclosure.isOpen()}
            class="user-message-expand"
            data-timeline-disclosure=""
            onClick={disclosure.toggle}
            type="button"
          >
            {disclosure.isOpen() ? "Mostrar menos" : "Mostrar mais"}
          </button>
        </Show>
        <div class="message-actions user-message-actions">
          <CopyMessageButton text={userMessageCopyText(props.item.content)} />
        </div>
      </div>
    </article>
  );
}

export function CommentaryMessage(props: {
  readonly item: Extract<ThreadItem, { type: "agentMessage" }>;
  readonly streaming: boolean;
}) {
  const presentation = createMemo(() => createCommentaryPresentation(props.item.text));

  return (
    <Show when={presentation().visible}>
      <article class="message-row agent-message-row commentary">
        <div class="message-content">
          <span class="visually-hidden">Codex disse:</span>
          <div class="commentary-content">
            <Markdown streaming={props.streaming} text={presentation().text} />
          </div>
        </div>
      </article>
    </Show>
  );
}

export function AgentMessage(props: {
  readonly item: Extract<ThreadItem, { type: "agentMessage" }>;
  readonly streaming: boolean;
}) {
  const content = () => presentAssistantText(props.item.text);
  const visibleContent = () => content().trim().length > 0;
  return (
    <Show when={visibleContent()}>
      <article class="message-row agent-message-row">
        <div class="message-content">
          <span class="visually-hidden">Codex disse:</span>
          <Markdown
            class="agent-message-markdown"
            streaming={props.streaming}
            text={props.item.text}
          />
          <div class="message-actions">
            <CopyMessageButton text={content()} />
          </div>
        </div>
      </article>
    </Show>
  );
}

export function userMessageCopyText(content: readonly UserContent[]): string {
  return content.map(userContentPartCopyText).join("\n");
}

export function inlinePreview(text: string, maximumLength: number): string {
  const normalized = text.replace(/\s+/gu, " ").trim() || "Mensagem sem texto";
  return normalized.length <= maximumLength
    ? normalized
    : `${normalized.slice(0, maximumLength - 1)}…`;
}

export function blockPreview(text: string, maximumLength: number): string {
  const normalized = text
    .replace(/\r\n?/gu, "\n")
    .replace(/[^\S\r\n]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return normalized.length <= maximumLength
    ? normalized
    : `${normalized.slice(0, maximumLength - 1)}…`;
}

export function userMessageAnchor(id: string): string {
  return `user-message-${id}`;
}

function UserContentPart(props: { readonly content: UserContent }) {
  switch (props.content.type) {
    case "text":
      return <p class="message-text">{props.content.text}</p>;
    case "localImage":
      return null;
    case "mention":
      return (
        <div class="attachment-line">
          <Icon name="file" size={15} /> {props.content.name}
        </div>
      );
  }
}

function CopyMessageButton(props: { readonly text: string }) {
  const reportFailure = useFrontendFailureReporter();
  const [state, setState] = createSignal<"copied" | "failed" | "idle">("idle");
  let resetTimer: number | undefined;

  onCleanup(() => window.clearTimeout(resetTimer));

  async function copy(): Promise<void> {
    window.clearTimeout(resetTimer);
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(props.text);
      setState("copied");
    } catch (reason) {
      reportFailure(frontendFailureMessage("Falha ao copiar uma mensagem", reason));
      setState("failed");
    }
    resetTimer = window.setTimeout(() => setState("idle"), COPY_FEEDBACK_RESET_MILLISECONDS);
  }

  const label = () => {
    switch (state()) {
      case "copied":
        return "Copiado";
      case "failed":
        return "Falha ao copiar";
      case "idle":
        return "Copiar";
    }
  };

  return (
    <button
      aria-label={label()}
      aria-live="polite"
      class="message-copy-button"
      disabled={props.text.length === 0}
      onClick={() => void copy()}
      title={label()}
      type="button"
    >
      <Icon name={state() === "copied" ? "check" : "copy"} size={14} />
      <span class="visually-hidden">{label()}</span>
    </button>
  );
}

function userContentPartCopyText(part: UserContent): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "localImage":
      return `Imagem: ${imageContentName(part.path)}`;
    case "mention":
      return part.name;
  }
}

function imageContentName(path: string): string {
  const name = fileName(path);
  return name.length <= FALLBACK_TITLE_LIMIT_CHARACTERS ? name : "Imagem anexada";
}
