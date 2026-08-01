import { open } from "@tauri-apps/plugin-dialog";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import type {
  Attachment,
  CodexModel,
  PermissionProfile,
  ReasoningEffort,
} from "../contracts/types";
import type { AppController } from "../state/createAppController";
import { Icon } from "./Icon";

export interface ComposerProps {
  readonly controller: AppController;
  readonly onOpenSettings: () => void;
}

type ModelMenuSection = "effort" | "model" | "serviceTier";

export function Composer(props: ComposerProps) {
  const [text, setText] = createSignal("");
  const [attachments, setAttachments] = createSignal<readonly Attachment[]>([]);
  const [model, setModel] = createSignal<string | null>(null);
  const [effort, setEffort] = createSignal<ReasoningEffort | null>(null);
  const [serviceTier, setServiceTier] = createSignal<string | null>(null);
  const [sending, setSending] = createSignal(false);
  const [attachmentError, setAttachmentError] = createSignal<string | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = createSignal(false);
  const [modelMenuSection, setModelMenuSection] = createSignal<ModelMenuSection | null>(null);
  const [permissionMenuOpen, setPermissionMenuOpen] = createSignal(false);
  let composerElement: HTMLFormElement | undefined;
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
    setServiceTier(configured.serviceTier ?? nextModel?.defaultServiceTier ?? null);
  });

  function closeComposerMenus(): void {
    setModelMenuOpen(false);
    setModelMenuSection(null);
    setPermissionMenuOpen(false);
  }

  function handleDocumentPointerDown(event: PointerEvent): void {
    if (event.target instanceof Node && !composerElement?.contains(event.target)) {
      closeComposerMenus();
    }
  }

  onMount(() => document.addEventListener("pointerdown", handleDocumentPointerDown));
  onCleanup(() => document.removeEventListener("pointerdown", handleDocumentPointerDown));

  function selectNextModel(value: string): void {
    setModel(value);
    const next = props.controller.models().find((entry) => entry.id === value);
    if (next === undefined) {
      setEffort(null);
      setServiceTier(null);
      return;
    }
    if (!next.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort())) {
      setEffort(next.defaultReasoningEffort);
    }
    setServiceTier(next.defaultServiceTier);
  }

  function resetModelSelection(): void {
    const configured = props.controller.config()?.config;
    const nextModel = selectModel(props.controller.models(), configured?.model ?? null, null);
    setModel(nextModel?.id ?? null);
    setEffort(configured?.modelReasoningEffort ?? nextModel?.defaultReasoningEffort ?? null);
    setServiceTier(configured?.serviceTier ?? nextModel?.defaultServiceTier ?? null);
  }

  async function selectPermission(profile: PermissionProfile): Promise<void> {
    const succeeded = await props.controller.updateSetting({
      type: "permissionProfile",
      value: profile,
    });
    if (succeeded) {
      setPermissionMenuOpen(false);
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
        serviceTier: serviceTier(),
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
      <form
        aria-label="Compositor"
        class="composer"
        classList={{ busy: props.controller.turnBusy() }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            closeComposerMenus();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        ref={composerElement}
      >
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
              <Icon name="plus" size={17} />
            </button>
            <div class="composer-menu-anchor">
              <button
                aria-expanded={permissionMenuOpen()}
                aria-haspopup="menu"
                class="permission-button"
                classList={{
                  active: permissionMenuOpen(),
                  elevated:
                    props.controller.config()?.config.permissionProfile.sandbox ===
                    "danger-full-access",
                }}
                disabled={props.controller.turnBusy() || props.controller.config() === null}
                onClick={() => {
                  setPermissionMenuOpen((value) => !value);
                  setModelMenuOpen(false);
                  setModelMenuSection(null);
                }}
                title="Permissões"
                type="button"
              >
                <Icon name="shield" size={15} />
                <span>
                  {permissionLabel(props.controller.config()?.config.permissionProfile.sandbox)}
                </span>
              </button>
              <Show when={permissionMenuOpen()}>
                <div aria-label="Permissões" class="composer-popover permission-menu" role="menu">
                  <header>
                    <strong>Como as ações do Codex devem ser aprovadas?</strong>
                    <button
                      onClick={() => {
                        setPermissionMenuOpen(false);
                        props.onOpenSettings();
                      }}
                      type="button"
                    >
                      Configurações
                    </button>
                  </header>
                  <For each={props.controller.engine()?.permissionProfiles ?? []}>
                    {(profile) => (
                      <button
                        aria-checked={samePermission(
                          profile,
                          props.controller.config()?.config.permissionProfile,
                        )}
                        class="permission-menu-option"
                        classList={{
                          selected: samePermission(
                            profile,
                            props.controller.config()?.config.permissionProfile,
                          ),
                        }}
                        disabled={props.controller.pendingOperations() > 0}
                        onClick={() => void selectPermission(profile)}
                        role="menuitemradio"
                        type="button"
                      >
                        <Icon name="shield" size={16} />
                        <span>
                          <strong>{permissionLabel(profile.sandbox)}</strong>
                          <small>{permissionDescription(profile)}</small>
                        </span>
                        <Show
                          when={samePermission(
                            profile,
                            props.controller.config()?.config.permissionProfile,
                          )}
                        >
                          <Icon name="check" size={16} />
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
          <div class="composer-trailing">
            <div class="composer-menu-anchor model-menu-anchor">
              <button
                aria-expanded={modelMenuOpen()}
                aria-haspopup="dialog"
                class="model-button"
                classList={{ active: modelMenuOpen() }}
                disabled={props.controller.turnBusy() || selectedModel() === undefined}
                onClick={() => {
                  setModelMenuOpen((value) => !value);
                  setModelMenuSection(null);
                  setPermissionMenuOpen(false);
                }}
                title="Modelo e raciocínio"
                type="button"
              >
                <span class="model-button-name">
                  {selectedModel() === undefined
                    ? "Carregando"
                    : compactModelName(selectedModel()?.displayName ?? "")}
                </span>
                <Show when={effort()}>
                  {(selectedEffort) => (
                    <span class="model-button-effort">{effortLabel(selectedEffort())}</span>
                  )}
                </Show>
                <Icon name="chevronDown" size={13} />
              </button>
              <Show when={modelMenuOpen()}>
                <div
                  aria-label="Modelo e raciocínio"
                  class="composer-popover model-menu"
                  role="menu"
                >
                  <ModelMenuRow
                    active={modelMenuSection() === "model"}
                    label="Modelo"
                    onActivate={() => setModelMenuSection("model")}
                    value={
                      selectedModel() === undefined
                        ? "Carregando"
                        : compactModelName(selectedModel()?.displayName ?? "")
                    }
                  />
                  <ModelMenuRow
                    active={modelMenuSection() === "effort"}
                    disabled={reasoningOptions().length === 0}
                    label="Esforço"
                    onActivate={() => setModelMenuSection("effort")}
                    value={selectedEffortLabel(effort())}
                  />
                  <ModelMenuRow
                    active={modelMenuSection() === "serviceTier"}
                    label="Velocidade"
                    onActivate={() => setModelMenuSection("serviceTier")}
                    value={serviceTierLabel(selectedModel(), serviceTier())}
                  />
                  <button
                    class="model-reset-button"
                    onClick={() => {
                      resetModelSelection();
                      closeComposerMenus();
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <span>Redefinir para o padrão</span>
                    <Icon name="reset" size={14} />
                  </button>
                  <Show when={modelMenuSection()}>
                    {(section) => (
                      <ModelMenuOptions
                        effort={effort()}
                        model={selectedModel()}
                        models={props.controller.models()}
                        onSelectEffort={(value) => {
                          setEffort(value);
                          closeComposerMenus();
                        }}
                        onSelectModel={(value) => {
                          selectNextModel(value);
                          closeComposerMenus();
                        }}
                        onSelectServiceTier={(value) => {
                          setServiceTier(value);
                          closeComposerMenus();
                        }}
                        section={section()}
                        serviceTier={serviceTier()}
                      />
                    )}
                  </Show>
                </div>
              </Show>
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
                  <Icon name="stop" size={14} />
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
                <Icon name="send" size={15} />
              </button>
            </Show>
          </div>
        </div>
      </form>
      <Show when={attachmentError()}>
        {(message) => (
          <p class="composer-input-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </section>
  );
}

function ModelMenuRow(props: {
  readonly active: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onActivate: () => void;
  readonly value: string;
}) {
  return (
    <button
      aria-expanded={props.active}
      aria-haspopup="menu"
      class="model-menu-row"
      classList={{ active: props.active }}
      disabled={props.disabled}
      onClick={props.onActivate}
      onFocus={props.onActivate}
      onPointerEnter={props.onActivate}
      role="menuitem"
      type="button"
    >
      <span>{props.label}</span>
      <small>{props.value}</small>
      <Icon name="chevronRight" size={14} />
    </button>
  );
}

function ModelMenuOptions(props: {
  readonly effort: ReasoningEffort | null;
  readonly model: CodexModel | undefined;
  readonly models: readonly CodexModel[];
  readonly onSelectEffort: (value: ReasoningEffort) => void;
  readonly onSelectModel: (value: string) => void;
  readonly onSelectServiceTier: (value: string | null) => void;
  readonly section: ModelMenuSection;
  readonly serviceTier: string | null;
}) {
  return (
    <div
      aria-label={modelMenuSectionLabel(props.section)}
      class={`composer-popover model-submenu model-submenu-${props.section}`}
      role="menu"
    >
      <div class="model-menu-options">
        <Show when={props.section === "model"}>
          <For each={props.models}>
            {(entry) => (
              <button
                aria-checked={entry.id === props.model?.id}
                class="model-menu-option"
                classList={{ selected: entry.id === props.model?.id }}
                onClick={() => props.onSelectModel(entry.id)}
                role="menuitemradio"
                type="button"
              >
                <span>{entry.displayName}</span>
                <Show when={entry.id === props.model?.id}>
                  <Icon name="check" size={15} />
                </Show>
              </button>
            )}
          </For>
        </Show>
        <Show when={props.section === "effort"}>
          <For each={props.model?.supportedReasoningEfforts ?? []}>
            {(option) => (
              <button
                aria-checked={option.reasoningEffort === props.effort}
                class="model-menu-option"
                classList={{ selected: option.reasoningEffort === props.effort }}
                onClick={() => props.onSelectEffort(option.reasoningEffort)}
                role="menuitemradio"
                type="button"
              >
                <span>{effortLabel(option.reasoningEffort)}</span>
                <Show when={option.reasoningEffort === props.effort}>
                  <Icon name="check" size={15} />
                </Show>
              </button>
            )}
          </For>
        </Show>
        <Show when={props.section === "serviceTier"}>
          <button
            aria-checked={props.serviceTier === null}
            class="model-menu-option"
            classList={{ selected: props.serviceTier === null }}
            onClick={() => props.onSelectServiceTier(null)}
            role="menuitemradio"
            type="button"
          >
            <span>Padrão</span>
            <Show when={props.serviceTier === null}>
              <Icon name="check" size={15} />
            </Show>
          </button>
          <For each={props.model?.serviceTiers ?? []}>
            {(tier) => (
              <button
                aria-checked={tier.id === props.serviceTier}
                class="model-menu-option"
                classList={{ selected: tier.id === props.serviceTier }}
                onClick={() => props.onSelectServiceTier(tier.id)}
                role="menuitemradio"
                type="button"
              >
                <span>{tier.name}</span>
                <Show when={tier.id === props.serviceTier}>
                  <Icon name="check" size={15} />
                </Show>
              </button>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

function modelMenuSectionLabel(section: ModelMenuSection): string {
  switch (section) {
    case "model":
      return "Modelo";
    case "effort":
      return "Esforço";
    case "serviceTier":
      return "Velocidade";
  }
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

function selectedEffortLabel(effort: ReasoningEffort | null): string {
  return effort === null ? "Padrão" : effortLabel(effort);
}

function permissionLabel(mode: string | undefined): string {
  switch (mode) {
    case "read-only":
      return "Somente leitura";
    case "workspace-write":
      return "Aprovar por mim";
    case "danger-full-access":
      return "Acesso completo";
    default:
      return "Permissões";
  }
}

function permissionDescription(profile: PermissionProfile): string {
  switch (profile.sandbox) {
    case "read-only":
      return "Lê arquivos sem modificar o projeto.";
    case "workspace-write":
      return "Edita o projeto e solicita aprovação quando necessário.";
    case "danger-full-access":
      return "Acessa qualquer arquivo e executa comandos sem aprovação.";
  }
}

function samePermission(left: PermissionProfile, right: PermissionProfile | undefined): boolean {
  return (
    right !== undefined && left.sandbox === right.sandbox && left.approvals === right.approvals
  );
}

function compactModelName(displayName: string): string {
  return displayName.replace(/^gpt[- ]?/iu, "").replaceAll("-", " ");
}

function serviceTierLabel(model: CodexModel | undefined, serviceTier: string | null): string {
  if (serviceTier === null) {
    return "Padrão";
  }
  return model?.serviceTiers.find((tier) => tier.id === serviceTier)?.name ?? serviceTier;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
