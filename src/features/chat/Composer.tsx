import { open } from "@tauri-apps/plugin-dialog";
import { For, Show, createSignal } from "solid-js";

import type {
  Attachment,
  CodexModel,
  ConfigEditRequest,
  ConfigReadResponse,
  JsonValue,
} from "../../shared/codex/types";
import {
  CloseIcon,
  FileIcon,
  ImageIcon,
  PlusIcon,
  SendIcon,
  StopIcon,
} from "../../shared/components/Icons";
import { ModelPicker } from "./ModelPicker";
import { PermissionPicker } from "./PermissionPicker";

interface ComposerProps {
  busy: boolean;
  config: ConfigReadResponse | null;
  disabled: boolean;
  models: CodexModel[];
  workspace: string | null;
  inspectFiles: (paths: string[]) => Promise<Attachment[]>;
  loadCompatibilityContext: () => Promise<void>;
  onChooseWorkspace: () => Promise<void>;
  onInterrupt: () => Promise<void>;
  onOpenSettings: () => void;
  onSend: (text: string, attachments: Attachment[]) => Promise<boolean>;
  saveClipboardImage: (dataBase64: string) => Promise<Attachment>;
  writeSetting: (
    keyPath: string,
    value: JsonValue,
    mergeStrategy: "replace" | "upsert",
  ) => Promise<void>;
  writeSettings: (edits: ConfigEditRequest[]) => Promise<void>;
}

const MAX_ATTACHMENTS = 12;

export function Composer(props: ComposerProps) {
  const [text, setText] = createSignal("");
  const [attachments, setAttachments] = createSignal<Attachment[]>([]);
  const [attachmentError, setAttachmentError] = createSignal<string | null>(null);
  const [processing, setProcessing] = createSignal(false);
  let textarea: HTMLTextAreaElement | undefined;

  async function selectFiles() {
    setAttachmentError(null);
    const selected = await open({
      directory: false,
      multiple: true,
      title: "Anexar arquivos",
    });
    const paths = typeof selected === "string" ? [selected] : selected;
    if (paths === null || paths.length === 0) {
      return;
    }

    setProcessing(true);
    try {
      const inspected = await props.inspectFiles(paths);
      appendAttachments(inspected);
    } catch (reason) {
      setAttachmentError(describeError(reason));
    } finally {
      setProcessing(false);
    }
  }

  async function handlePaste(event: ClipboardEvent) {
    const images = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (images.length === 0) {
      return;
    }
    event.preventDefault();
    setProcessing(true);
    setAttachmentError(null);
    try {
      const pasted = await Promise.all(
        images.map(async (image) => {
          const dataBase64 = await readFileAsBase64(image);
          return props.saveClipboardImage(dataBase64);
        }),
      );
      appendAttachments(pasted);
    } catch (reason) {
      setAttachmentError(describeError(reason));
    } finally {
      setProcessing(false);
    }
  }

  function appendAttachments(incoming: Attachment[]) {
    setAttachments((current) => {
      const knownPaths = new Set(current.map(({ path }) => path));
      const unique = incoming.filter(({ path }) => !knownPaths.has(path));
      const next = [...current, ...unique];
      if (next.length > MAX_ATTACHMENTS) {
        setAttachmentError(`O limite é de ${MAX_ATTACHMENTS} anexos por mensagem.`);
      }
      return next.slice(0, MAX_ATTACHMENTS);
    });
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  async function submit() {
    if (props.busy || props.disabled || processing()) {
      return;
    }
    const sent = await props.onSend(text(), attachments());
    if (sent) {
      setText("");
      setAttachments([]);
      setAttachmentError(null);
      if (textarea !== undefined) {
        textarea.style.height = "";
        textarea.style.overflowY = "hidden";
      }
    }
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div class="composer-wrap">
      <Show
        when={props.workspace !== null}
        fallback={
          <button
            class="workspace-required"
            onClick={() => void props.onChooseWorkspace()}
            type="button"
          >
            Selecione uma pasta para começar
          </button>
        }
      >
        <div
          class="composer"
          classList={{
            "composer-busy": props.busy,
            "composer-disabled": props.disabled,
          }}
        >
          <Show when={attachments().length > 0}>
            <div class="attachment-list">
              <For each={attachments()}>
                {(attachment) => (
                  <div class="attachment-chip" title={attachment.path}>
                    {attachment.kind === "image" ? (
                      <ImageIcon size={16} />
                    ) : (
                      <FileIcon size={16} />
                    )}
                    <span>{attachment.name}</span>
                    <button
                      aria-label={`Remover ${attachment.name}`}
                      onClick={() => removeAttachment(attachment.id)}
                      type="button"
                    >
                      <CloseIcon size={14} />
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <textarea
            aria-label="Mensagem"
            disabled={props.busy || props.disabled}
            onInput={(event) => {
              setText(event.currentTarget.value);
              resizeTextarea(event.currentTarget);
            }}
            onKeyDown={handleKeyDown}
            onPaste={(event) => void handlePaste(event)}
            placeholder="Peça ao Codex para trabalhar neste projeto"
            ref={textarea}
            rows={2}
            value={text()}
          />
          <div class="composer-actions">
            <div class="composer-actions-left">
              <button
                aria-label="Anexar arquivos"
                class="icon-button"
                disabled={props.busy || props.disabled || processing()}
                onClick={() => void selectFiles()}
                title="Anexar arquivos"
                type="button"
              >
                <PlusIcon size={17} />
              </button>
              <PermissionPicker
                config={props.config}
                disabled={
                  props.busy
                  || props.disabled
                  || processing()
                  || props.config === null
                }
                onOpenSettings={props.onOpenSettings}
                writeSettings={props.writeSettings}
              />
            </div>
            <div class="composer-actions-right">
              <ModelPicker
                config={props.config}
                disabled={props.disabled}
                loadContext={props.loadCompatibilityContext}
                models={props.models}
                writeSetting={props.writeSetting}
                writeSettings={props.writeSettings}
              />
              <Show
                when={props.busy}
                fallback={
                  <button
                    aria-label="Enviar mensagem"
                    class="send-button"
                    disabled={
                      props.disabled
                      || processing()
                      || (text().trim().length === 0 && attachments().length === 0)
                    }
                    onClick={() => void submit()}
                    title="Enviar"
                    type="button"
                  >
                    <SendIcon />
                  </button>
                }
              >
                <button
                  aria-label="Interromper tarefa"
                  class="send-button stop-button"
                  onClick={() => void props.onInterrupt()}
                  title="Interromper"
                  type="button"
                >
                  <StopIcon />
                </button>
              </Show>
            </div>
          </div>
        </div>
        <Show when={attachmentError()}>
          {(message) => <p class="composer-error">{message()}</p>}
        </Show>
      </Show>
    </div>
  );
}

function resizeTextarea(textarea: HTMLTextAreaElement) {
  const maximumHeight = 190;
  textarea.style.height = "auto";
  const nextHeight = Math.min(textarea.scrollHeight, maximumHeight);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maximumHeight ? "auto" : "hidden";
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Não foi possível ler a imagem colada."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("A área de transferência retornou uma imagem inválida."));
        return;
      }
      const separator = reader.result.indexOf(",");
      resolve(separator >= 0 ? reader.result.slice(separator + 1) : reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function describeError(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  if (reason !== null && typeof reason === "object" && "message" in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return "Não foi possível anexar o arquivo.";
}
