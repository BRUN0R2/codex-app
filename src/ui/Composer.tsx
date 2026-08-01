import { open } from "@tauri-apps/plugin-dialog";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import type { Attachment, CodexModel, ReasoningEffort } from "../contracts/types";
import type { AppController } from "../state/createAppController";
import { Icon } from "./Icon";

export interface ComposerProps {
  readonly controller: AppController;
  readonly onOpenSettings: () => void;
}

export function Composer(props: ComposerProps) {
  const [text, setText] = createSignal("");
  const [attachments, setAttachments] = createSignal<readonly Attachment[]>([]);
  const [model, setModel] = createSignal<string | null>(null);
  const [effort, setEffort] = createSignal<ReasoningEffort | null>(null);
  const [sending, setSending] = createSignal(false);
  const [attachmentError, setAttachmentError] = createSignal<string | null>(null);
  let textArea: HTMLTextAreaElement | undefined;

  const selectedModel = createMemo(() =>
    selectModel(
      props.controller.models(),
      model(),
      props.controller.config()?.config.model ?? null,
    ),
  );
  const reasoningOptions = createMemo(() => selectedModel()?.supportedReasoningEfforts ?? []);
  const canSend = createMemo(
    () =>
      !props.controller.turnBusy() &&
      !sending() &&
      (text().trim().length > 0 || attachments().length > 0),
  );

  createEffect(() => {
    const configured = props.controller.config()?.config;
    const catalog = props.controller.models();
    if (configured === undefined || catalog.length === 0) {
      return;
    }
    const nextModel = selectModel(catalog, configured.model, null);
    setModel(nextModel?.id ?? null);
    setEffort(configured.modelReasoningEffort ?? nextModel?.defaultReasoningEffort ?? null);
  });

  function selectNextModel(value: string): void {
    setModel(value);
    const next = props.controller.models().find((entry) => entry.id === value);
    if (next === undefined) {
      setEffort(null);
      return;
    }
    if (!next.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort())) {
      setEffort(next.defaultReasoningEffort);
    }
  }

  async function attachFiles(): Promise<void> {
    try {
      const selected = await open({ directory: false, multiple: true });
      if (selected === null) {
        return;
      }
      const paths = Array.isArray(selected) ? selected : [selected];
      const inspected = await props.controller.inspectFiles(paths);
      setAttachments(mergeAttachments(attachments(), inspected));
      setAttachmentError(null);
    } catch (reason) {
      setAttachmentError(errorMessage(reason));
    }
  }

  async function send(): Promise<void> {
    if (!canSend()) {
      return;
    }
    setSending(true);
    try {
      const succeeded = await props.controller.sendMessage({
        text: text(),
        attachments: attachments(),
        model: model(),
        effort: effort(),
      });
      if (succeeded) {
        setText("");
        setAttachments([]);
        setAttachmentError(null);
        resizeTextArea(textArea);
      }
    } finally {
      setSending(false);
    }
  }

  async function handlePaste(event: ClipboardEvent): Promise<void> {
    const image = [...(event.clipboardData?.files ?? [])].find((file) =>
      file.type.startsWith("image/"),
    );
    if (image === undefined) {
      return;
    }
    event.preventDefault();
    try {
      const encoded = arrayBufferToBase64(await image.arrayBuffer());
      const attachment = await props.controller.saveClipboardImage(encoded);
      if (attachment !== null) {
        setAttachments(mergeAttachments(attachments(), [attachment]));
        setAttachmentError(null);
      }
    } catch (reason) {
      setAttachmentError(errorMessage(reason));
    }
  }

  return (
    <section class="composer-wrap">
      <Show when={attachments().length > 0}>
        <div class="attachment-strip">
          <For each={attachments()}>
            {(attachment) => (
              <span class="attachment-chip">
                <Icon name="file" size={14} />
                <span>{attachment.name}</span>
                <small>{formatBytes(attachment.size)}</small>
                <button
                  aria-label={`Remover ${attachment.name}`}
                  onClick={() =>
                    setAttachments((current) =>
                      current.filter((entry) => entry.id !== attachment.id),
                    )
                  }
                  type="button"
                >
                  <Icon name="close" size={12} />
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <div class="composer" classList={{ busy: props.controller.turnBusy() }}>
        <textarea
          aria-label="Mensagem para o Codex"
          disabled={props.controller.turnBusy()}
          maxlength={1_048_576}
          onInput={(event) => {
            setText(event.currentTarget.value);
            resizeTextArea(event.currentTarget);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          onPaste={(event) => void handlePaste(event)}
          placeholder={
            props.controller.workspace() === null
              ? "Descreva a tarefa — você escolherá um projeto ao enviar"
              : "Peça uma mudança, análise ou implementação"
          }
          ref={textArea}
          rows={1}
          value={text()}
        />
        <div class="composer-toolbar">
          <div class="composer-leading">
            <button
              aria-label="Anexar arquivos"
              disabled={props.controller.turnBusy() || attachments().length >= 12}
              onClick={() => void attachFiles()}
              title="Anexar arquivos"
              type="button"
            >
              <Icon name="paperclip" size={17} />
            </button>
            <select
              aria-label="Modelo"
              disabled={props.controller.turnBusy() || props.controller.models().length === 0}
              onChange={(event) => selectNextModel(event.currentTarget.value)}
              value={selectedModel()?.id ?? ""}
            >
              <For each={props.controller.models()}>
                {(entry) => <option value={entry.id}>{entry.displayName}</option>}
              </For>
            </select>
            <select
              aria-label="Esforço de raciocínio"
              disabled={props.controller.turnBusy() || reasoningOptions().length === 0}
              onChange={(event) => {
                const value = reasoningOptions().find(
                  (option) => option.reasoningEffort === event.currentTarget.value,
                )?.reasoningEffort;
                if (value !== undefined) {
                  setEffort(value);
                }
              }}
              value={effort() ?? ""}
            >
              <For each={reasoningOptions()}>
                {(option) => (
                  <option value={option.reasoningEffort}>
                    {effortLabel(option.reasoningEffort)}
                  </option>
                )}
              </For>
            </select>
            <button
              class="permission-button"
              onClick={props.onOpenSettings}
              title="Permissões"
              type="button"
            >
              <Icon name="shield" size={15} />
              <span>
                {permissionLabel(props.controller.config()?.config.permissionProfile.sandbox)}
              </span>
            </button>
          </div>
          <Show
            when={!props.controller.turnBusy()}
            fallback={
              <button
                aria-label="Interromper turno"
                class="send-button stop-button"
                onClick={() => void props.controller.interrupt()}
                title="Interromper"
                type="button"
              >
                <Icon name="stop" size={16} />
              </button>
            }
          >
            <button
              aria-label="Enviar mensagem"
              class="send-button"
              disabled={!canSend()}
              onClick={() => void send()}
              title="Enviar"
              type="button"
            >
              <Icon name="send" size={16} />
            </button>
          </Show>
        </div>
      </div>
      <Show when={attachmentError()}>
        {(message) => (
          <p class="composer-input-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <p class="composer-hint">
        Enter envia · Shift+Enter quebra linha · operações têm limites explícitos
      </p>
    </section>
  );
}

function selectModel(
  models: readonly CodexModel[],
  requested: string | null,
  fallback: string | null,
): CodexModel | undefined {
  const id = requested ?? fallback;
  return models.find((model) => model.id === id) ?? models.find((model) => model.isDefault);
}

function mergeAttachments(
  current: readonly Attachment[],
  incoming: readonly Attachment[],
): readonly Attachment[] {
  const paths = new Set(current.map((attachment) => attachment.path.toLocaleLowerCase("en-US")));
  const result = [...current];
  for (const attachment of incoming) {
    const key = attachment.path.toLocaleLowerCase("en-US");
    if (!paths.has(key)) {
      result.push(attachment);
      paths.add(key);
    }
  }
  if (result.length > 12) {
    throw new Error("Uma mensagem aceita no máximo 12 anexos.");
  }
  return result;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Não foi possível processar os anexos.";
}

function resizeTextArea(element: HTMLTextAreaElement | undefined): void {
  if (element === undefined) {
    return;
  }
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(""));
}

function effortLabel(effort: ReasoningEffort): string {
  switch (effort) {
    case "none":
      return "Sem raciocínio";
    case "minimal":
      return "Mínimo";
    case "low":
      return "Baixo";
    case "medium":
      return "Médio";
    case "high":
      return "Alto";
    case "xhigh":
      return "Extra alto";
    case "max":
      return "Máximo";
    case "ultra":
      return "Ultra";
  }
}

function permissionLabel(mode: string | undefined): string {
  switch (mode) {
    case "read-only":
      return "Somente leitura";
    case "workspace-write":
      return "Projeto";
    case "danger-full-access":
      return "Acesso total";
    default:
      return "Permissões";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
