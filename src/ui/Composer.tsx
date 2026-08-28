import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

import type {
  Attachment,
  ChatModelOption,
  CodexModel,
  PermissionProfile,
  ReasoningEffort,
} from "../contracts/types";
import { openDesktopDialog as open } from "../infrastructure/codexClient";
import type { AppController } from "../state/appController";
import {
  type ComposerDraftState,
  ComposerDraftStore,
  composerDraftKey,
  sameComposerDraft,
} from "../state/composerDrafts";

type ComposerController = Pick<
  AppController,
  | "chatModels"
  | "chooseWorkspace"
  | "config"
  | "contextUsage"
  | "conversationMode"
  | "currentThread"
  | "deleteQueuedMessage"
  | "engine"
  | "enqueueMessage"
  | "inspectFiles"
  | "interrupt"
  | "models"
  | "pendingOperations"
  | "queuedMessages"
  | "saveClipboardImage"
  | "sendMessage"
  | "sendQueuedMessageNow"
  | "takeQueuedMessage"
  | "turnBusy"
  | "updateSetting"
  | "workspace"
>;

import {
  type ChatIntelligenceSelection,
  chatOptionLabel,
  clearChatIntelligenceSelection,
  loadChatIntelligenceSelection,
  resolveChatIntelligence,
  saveChatIntelligenceSelection,
  selectionFromChatOption,
} from "../state/chatIntelligence";
import {
  loadQueueingEnabled,
  type QueuedMessage,
  saveQueueingEnabled,
} from "../state/messageQueue";
import { ContextWindowIndicator } from "./ContextWindowIndicator";
import { Icon } from "./Icon";
import { ImagePreview } from "./ImagePreview";
import { modelContextWindowPreference, resolveModelContextWindow } from "./modelContextWindow";
import {
  selectRuntimeCompatibleModel,
  selectRuntimeCompatibleReasoningEffort,
  selectRuntimeCompatibleServiceTier,
} from "./modelSelection";

const COMPOSER_MESSAGE_MAXIMUM_CHARACTERS: number = 1_048_576;
const COMPOSER_ATTACHMENT_MAXIMUM_COUNT: number = 12;
const COMPOSER_TEXTAREA_MAXIMUM_HEIGHT_PX: number = 220;

export interface ComposerProps {
  readonly controller: ComposerController;
  readonly draftRequest: ComposerDraftRequest | null;
  readonly onDraftConsumed: (requestId: number) => void;
  readonly onOpenSettings: () => void;
}

export interface ComposerDraftRequest {
  readonly id: number;
  readonly text: string;
}

type ModelMenuSection = "effort" | "model" | "serviceTier";

export function Composer(props: ComposerProps) {
  let initialChatSelection: ChatIntelligenceSelection | null = null;
  let initialQueueingEnabled = true;
  let initialPreferenceError: string | null = null;
  try {
    initialChatSelection = loadChatIntelligenceSelection();
  } catch (reason) {
    initialPreferenceError = errorMessage(reason);
  }
  try {
    initialQueueingEnabled = loadQueueingEnabled();
  } catch (reason) {
    initialPreferenceError = errorMessage(reason);
  }
  const mode = () => props.controller.conversationMode();
  const [text, setText] = createSignal("");
  const [attachments, setAttachments] = createSignal<readonly Attachment[]>([]);
  const [model, setModel] = createSignal<string | null>(null);
  const [effort, setEffort] = createSignal<ReasoningEffort | null>(null);
  const [serviceTier, setServiceTier] = createSignal<string | null>(null);
  const [chatSelection, setChatSelection] = createSignal<ChatIntelligenceSelection | null>(
    initialChatSelection,
  );
  const [sending, setSending] = createSignal(false);
  const [queueingEnabled, setQueueingEnabled] = createSignal(initialQueueingEnabled);
  const [attachmentError, setAttachmentError] = createSignal<string | null>(initialPreferenceError);
  const [modelMenuOpen, setModelMenuOpen] = createSignal(false);
  const [modelMenuSection, setModelMenuSection] = createSignal<ModelMenuSection | null>(null);
  const [permissionMenuOpen, setPermissionMenuOpen] = createSignal(false);
  const [addMenuOpen, setAddMenuOpen] = createSignal(false);
  const draftStore = new ComposerDraftStore();
  let activeDraftKey = currentDraftKey();
  let composerElement: HTMLFormElement | undefined;
  let textArea: HTMLTextAreaElement | undefined;

  const configuredModel = createMemo(() =>
    selectRuntimeCompatibleModel(
      props.controller.models(),
      model(),
      props.controller.config()?.config.model ?? null,
    ),
  );
  const chatIntelligence = createMemo(() =>
    resolveChatIntelligence(props.controller.chatModels(), chatSelection()),
  );
  const selectedModel = configuredModel;
  const selectedContextWindowPreference = createMemo(() => {
    const selected = selectedModel();
    if (selected === undefined) {
      return "default";
    }
    return modelContextWindowPreference(
      props.controller.config()?.config.modelContextWindowPreferences ?? {},
      selected.id,
    );
  });
  const selectedModelWindow = createMemo(() =>
    resolveModelContextWindow(selectedModel(), selectedContextWindowPreference()),
  );
  const selectedChatOption = createMemo(() => chatIntelligence().option);
  const selectedChatLabel = createMemo(() => {
    const option = selectedChatOption();
    return option === undefined ? "Carregando" : chatOptionLabel(option);
  });
  const reasoningOptions = createMemo(() => configuredModel()?.supportedReasoningEfforts ?? []);
  const canSend = createMemo(
    () => !sending() && (text().trim().length > 0 || attachments().length > 0),
  );

  createEffect(() => {
    if (chatIntelligence().source !== "selectionUnavailable") {
      return;
    }
    try {
      clearChatIntelligenceSelection();
      setChatSelection(null);
    } catch (reason) {
      setAttachmentError(errorMessage(reason));
    }
  });

  createEffect(() => {
    const configured = props.controller.config()?.config;
    const catalog = props.controller.models();
    if (configured === undefined || catalog.length === 0) {
      return;
    }
    applyCodexSelection(configured.model, configured.modelReasoningEffort, configured.serviceTier);
  });

  createEffect(
    on(
      currentDraftKey,
      (nextDraftKey, previousDraftKey) => {
        if (previousDraftKey !== undefined) {
          draftStore.write(previousDraftKey, currentDraft());
        }
        activeDraftKey = nextDraftKey;
        const nextDraft = draftStore.read(nextDraftKey);
        setText(nextDraft.text);
        setAttachments(nextDraft.attachments);
        setAttachmentError(null);
        queueMicrotask(() => resizeTextArea(textArea));
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    const request = props.draftRequest;
    if (request === null) {
      return;
    }
    setText(request.text);
    queueMicrotask(() => {
      resizeTextArea(textArea);
      textArea?.focus();
      textArea?.setSelectionRange(request.text.length, request.text.length);
      props.onDraftConsumed(request.id);
    });
  });

  function closeComposerMenus(): void {
    setAddMenuOpen(false);
    setModelMenuOpen(false);
    setModelMenuSection(null);
    setPermissionMenuOpen(false);
  }

  function handleDocumentPointerDown(event: PointerEvent): void {
    if (!(event.target instanceof Element) || !composerElement?.contains(event.target)) {
      closeComposerMenus();
      return;
    }
    if (event.target.closest(".add-menu-anchor") === null) {
      setAddMenuOpen(false);
    }
    if (event.target.closest(".permission-menu-anchor") === null) {
      setPermissionMenuOpen(false);
    }
    if (event.target.closest(".model-menu-anchor") === null) {
      setModelMenuOpen(false);
      setModelMenuSection(null);
    }
  }

  onMount(() => document.addEventListener("pointerdown", handleDocumentPointerDown));
  onCleanup(() => {
    draftStore.write(activeDraftKey, currentDraft());
    document.removeEventListener("pointerdown", handleDocumentPointerDown);
  });

  function selectNextModel(value: string): void {
    applyCodexSelection(value, effort(), null);
  }

  function selectNextChatOption(option: ChatModelOption): void {
    const selection = selectionFromChatOption(option);
    try {
      saveChatIntelligenceSelection(selection);
      setChatSelection(selection);
      setAttachmentError(null);
    } catch (reason) {
      setAttachmentError(errorMessage(reason));
    }
  }

  function resetChatSelection(): void {
    try {
      clearChatIntelligenceSelection();
      setChatSelection(null);
      setAttachmentError(null);
    } catch (reason) {
      setAttachmentError(errorMessage(reason));
    }
  }

  function resetModelSelection(): void {
    const configured = props.controller.config()?.config;
    applyCodexSelection(
      configured?.model ?? null,
      configured?.modelReasoningEffort ?? null,
      configured?.serviceTier ?? null,
    );
  }

  function applyCodexSelection(
    requestedModel: string | null,
    requestedEffort: ReasoningEffort | null,
    requestedServiceTier: string | null,
  ): void {
    const nextModel = selectRuntimeCompatibleModel(props.controller.models(), requestedModel, null);
    setModel(nextModel?.id ?? null);
    setEffort(selectRuntimeCompatibleReasoningEffort(nextModel, requestedEffort));
    setServiceTier(selectRuntimeCompatibleServiceTier(nextModel, requestedServiceTier));
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
    const hasDraft = text().trim().length > 0 || attachments().length > 0;
    if (!hasDraft) {
      if (props.controller.queuedMessages().length > 0) {
        void props.controller.sendQueuedMessageNow();
      }
      return;
    }
    if (sending()) {
      return;
    }
    const selectedChatIntelligence = mode() === "chat" ? chatIntelligence() : null;
    const selectedCodexModel = mode() === "chat" ? undefined : selectedModel();
    const submittedDraftKey = activeDraftKey;
    const submittedDraft = currentDraft();
    const input = {
      text: submittedDraft.text,
      attachments: submittedDraft.attachments,
      model:
        mode() === "chat"
          ? (selectedChatIntelligence?.option?.id ?? null)
          : (selectedCodexModel?.id ?? null),
      effort:
        mode() === "chat"
          ? null
          : selectRuntimeCompatibleReasoningEffort(selectedCodexModel, effort()),
      serviceTier:
        mode() === "chat"
          ? null
          : selectRuntimeCompatibleServiceTier(selectedCodexModel, serviceTier()),
    };
    if (props.controller.turnBusy() && queueingEnabled()) {
      if (props.controller.enqueueMessage(input)) {
        clearDraft(submittedDraftKey, submittedDraft);
      }
      return;
    }
    setSending(true);
    try {
      const succeeded = await props.controller.sendMessage(input);
      if (succeeded) {
        clearDraft(submittedDraftKey, submittedDraft);
      }
    } finally {
      setSending(false);
    }
  }

  function clearDraft(
    draftKey = activeDraftKey,
    expectedDraft: ComposerDraftState | null = null,
  ): void {
    const existingDraft = draftKey === activeDraftKey ? currentDraft() : draftStore.read(draftKey);
    if (expectedDraft !== null && !sameComposerDraft(existingDraft, expectedDraft)) {
      return;
    }
    draftStore.clear(draftKey);
    if (draftKey !== activeDraftKey) {
      return;
    }
    setText("");
    setAttachments([]);
    setAttachmentError(null);
    resizeTextArea(textArea);
  }

  function currentDraft(): ComposerDraftState {
    return {
      attachments: attachments(),
      text: text(),
    };
  }

  function currentDraftKey(): string {
    return composerDraftKey(
      props.controller.currentThread()?.id ?? null,
      props.controller.conversationMode(),
      props.controller.workspace(),
    );
  }

  function editQueuedMessage(messageId: string): void {
    const message = props.controller.takeQueuedMessage(messageId);
    if (message === null) {
      return;
    }
    setText(message.text);
    setAttachments(message.attachments);
    if (mode() === "chat") {
      if (message.model !== null) {
        setChatSelection({
          version: 2,
          optionId: message.model,
        });
      }
      setServiceTier(message.serviceTier);
    } else {
      applyCodexSelection(message.model, message.effort, message.serviceTier);
    }
    setAttachmentError(null);
    queueMicrotask(() => {
      resizeTextArea(textArea);
      textArea?.focus();
      textArea?.setSelectionRange(message.text.length, message.text.length);
    });
  }

  function toggleQueueing(): void {
    const next = !queueingEnabled();
    try {
      saveQueueingEnabled(next);
      setQueueingEnabled(next);
    } catch (reason) {
      setAttachmentError(errorMessage(reason));
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

  function removeAttachment(id: string): void {
    setAttachments((current) => current.filter((entry) => entry.id !== id));
  }

  return (
    <section class="composer-wrap">
      <Show when={props.controller.queuedMessages().length > 0}>
        <ul aria-label="Mensagens na fila" class="composer-queue">
          <For each={props.controller.queuedMessages()}>
            {(message) => (
              <QueuedMessageRow
                message={message}
                onDelete={() => props.controller.deleteQueuedMessage(message.id)}
                onEdit={() => editQueuedMessage(message.id)}
                onSendNow={() => void props.controller.sendQueuedMessageNow(message.id)}
                onToggleQueueing={toggleQueueing}
                queueingEnabled={queueingEnabled()}
              />
            )}
          </For>
        </ul>
      </Show>
      <form
        aria-label="Compositor"
        class="composer"
        classList={{ busy: props.controller.turnBusy() }}
        data-mode={mode()}
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
        <Show when={attachments().length > 0}>
          <div class="attachment-strip">
            <For each={attachments()}>
              {(attachment) => (
                <Show
                  when={attachment.kind === "image"}
                  fallback={
                    <span class="attachment-chip">
                      <Icon name="file" size={14} />
                      <span>{attachment.name}</span>
                      <small>{formatBytes(attachment.size)}</small>
                      <button
                        aria-label={`Remover ${attachment.name}`}
                        onClick={() => removeAttachment(attachment.id)}
                        type="button"
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </span>
                  }
                >
                  <span class="composer-image-attachment">
                    <ImagePreview
                      alt={attachment.name}
                      class="composer-image-preview"
                      name={attachment.name}
                      source={attachment.path}
                    />
                    <button
                      aria-label={`Remover ${attachment.name}`}
                      class="composer-image-remove"
                      onClick={() => removeAttachment(attachment.id)}
                      title={`Remover ${attachment.name}`}
                      type="button"
                    >
                      <Icon name="close" size={12} strokeWidth={2.2} />
                    </button>
                  </span>
                </Show>
              )}
            </For>
          </div>
        </Show>
        <textarea
          aria-label={composerPlaceholder(mode())}
          maxlength={COMPOSER_MESSAGE_MAXIMUM_CHARACTERS}
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
          placeholder={composerPlaceholder(mode())}
          ref={textArea}
          rows={1}
          value={text()}
        />
        <div class="composer-toolbar">
          <div class="composer-leading">
            <div class="composer-menu-anchor add-menu-anchor">
              <button
                aria-controls="composer-add-menu"
                aria-expanded={addMenuOpen()}
                aria-haspopup="menu"
                aria-label="Adicionar arquivos ou projeto"
                class="add-button"
                classList={{ active: addMenuOpen() }}
                disabled={props.controller.turnBusy()}
                onClick={() => {
                  setAddMenuOpen((value) => !value);
                  setPermissionMenuOpen(false);
                  setModelMenuOpen(false);
                  setModelMenuSection(null);
                }}
                title="Adicionar"
                type="button"
              >
                <Icon name="plus" size={17} />
              </button>
              <Show when={addMenuOpen()}>
                <div
                  aria-label="Adicionar"
                  class="composer-popover add-menu"
                  id="composer-add-menu"
                  role="menu"
                >
                  <header>Adicionar</header>
                  <button
                    disabled={attachments().length >= COMPOSER_ATTACHMENT_MAXIMUM_COUNT}
                    onClick={() => {
                      setAddMenuOpen(false);
                      void attachFiles();
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <Icon name="paperclip" size={16} />
                    <span>
                      <strong>Arquivos</strong>
                      <small>Até 12 anexos por mensagem</small>
                    </span>
                  </button>
                  <Show when={mode() !== "chat"}>
                    <button
                      onClick={() => {
                        setAddMenuOpen(false);
                        void props.controller.chooseWorkspace();
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <Icon name="folder" size={16} />
                      <span>
                        <strong>
                          {props.controller.workspace() === null
                            ? "Escolher projeto"
                            : "Trocar projeto"}
                        </strong>
                        <small>Defina a pasta de trabalho desta tarefa</small>
                      </span>
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
            <Show when={mode() !== "chat"}>
              <div class="composer-menu-anchor permission-menu-anchor">
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
                    setAddMenuOpen(false);
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
                            "full-access": profile.sandbox === "danger-full-access",
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
            </Show>
          </div>
          <div class="composer-trailing">
            <Show when={mode() === "chat"}>
              <div class="composer-menu-anchor model-menu-anchor">
                <button
                  aria-expanded={modelMenuOpen()}
                  aria-haspopup="menu"
                  class="model-button chat-intelligence-button"
                  classList={{ active: modelMenuOpen() }}
                  disabled={props.controller.turnBusy() || selectedChatOption() === undefined}
                  onClick={() => {
                    setModelMenuOpen((value) => !value);
                    setAddMenuOpen(false);
                    setModelMenuSection(null);
                    setPermissionMenuOpen(false);
                  }}
                  title="Modelo e nível de raciocínio"
                  type="button"
                >
                  <span class="model-button-effort">{selectedChatLabel()}</span>
                  <Icon name="chevronDown" size={13} />
                </button>
                <Show when={modelMenuOpen()}>
                  <div
                    aria-label="Modelo e nível de raciocínio"
                    class="composer-popover model-menu chat-intelligence-menu"
                    role="menu"
                  >
                    <div class="chat-intelligence-heading">
                      <span>Modelo do ChatGPT</span>
                    </div>
                    <ChatModelMenuOptions
                      model={selectedChatOption()}
                      models={props.controller.chatModels()}
                      onSelect={(option) => {
                        selectNextChatOption(option);
                        closeComposerMenus();
                      }}
                    />
                    <Show when={chatSelection() !== null}>
                      <button
                        class="model-reset-button"
                        onClick={() => {
                          resetChatSelection();
                          closeComposerMenus();
                        }}
                        role="menuitem"
                        type="button"
                      >
                        <span>Redefinir para o padrão</span>
                        <Icon name="reset" size={14} />
                      </button>
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>
            <Show when={mode() !== "chat"}>
              <ContextWindowIndicator
                modelWindow={selectedModelWindow()}
                usage={props.controller.contextUsage()}
              />
              <div class="composer-menu-anchor model-menu-anchor">
                <button
                  aria-expanded={modelMenuOpen()}
                  aria-haspopup="menu"
                  class="model-button"
                  classList={{ active: modelMenuOpen() }}
                  disabled={props.controller.turnBusy() || selectedModel() === undefined}
                  onClick={() => {
                    setModelMenuOpen((value) => !value);
                    setAddMenuOpen(false);
                    setModelMenuSection(null);
                    setPermissionMenuOpen(false);
                  }}
                  title="Modelo, raciocínio e velocidade"
                  type="button"
                >
                  <Show when={serviceTier() !== null}>
                    <span class="model-speed-indicator">
                      <Icon name="bolt" size={13} />
                      <span class="visually-hidden">Modo rápido ativo</span>
                    </span>
                  </Show>
                  <span class="model-button-name">
                    {selectedModel() === undefined
                      ? "Carregando"
                      : compactModelName(selectedModel()?.displayName ?? "")}
                  </span>
                  <Show when={effort()}>
                    {(selectedEffort) => (
                      <span
                        class="model-button-effort"
                        classList={{ ultra: selectedEffort() === "ultra" }}
                      >
                        {effortLabel(selectedEffort())}
                      </span>
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
                      valueTone={effort() === "ultra" ? "ultra" : undefined}
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
            </Show>
            <Show
              when={!props.controller.turnBusy() || canSend()}
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
                aria-label={
                  props.controller.turnBusy() && queueingEnabled()
                    ? "Adicionar mensagem à fila"
                    : "Enviar mensagem"
                }
                class="send-button"
                disabled={!canSend()}
                onClick={() => void send()}
                title={
                  props.controller.turnBusy() && queueingEnabled()
                    ? "Adicionar à fila"
                    : props.controller.turnBusy()
                      ? "Orientar agora"
                      : "Enviar"
                }
                type="button"
              >
                <Icon name="arrowUp" size={15} />
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

interface QueuedMessageRowProps {
  readonly message: QueuedMessage;
  readonly onDelete: () => void;
  readonly onEdit: () => void;
  readonly onSendNow: () => void;
  readonly onToggleQueueing: () => void;
  readonly queueingEnabled: boolean;
}

function QueuedMessageRow(props: QueuedMessageRowProps) {
  const summary = () => {
    const message = props.message.text.trim();
    if (message.length > 0) {
      return message;
    }
    const count = props.message.attachments.length;
    return count === 1 ? "1 anexo" : `${count} anexos`;
  };

  return (
    <li class="queued-message">
      <Icon name="cornerDownLeft" size={13} strokeWidth={1.7} />
      <span class="queued-message-copy">{summary()}</span>
      <div class="queued-message-actions">
        <button class="queued-message-steer" onClick={props.onSendNow} type="button">
          <Icon name="cornerDownLeft" size={13} strokeWidth={1.7} />
          Orientar
        </button>
        <button aria-label="Excluir mensagem da fila" onClick={props.onDelete} type="button">
          <Icon name="trash" size={14} strokeWidth={1.7} />
        </button>
        <details class="queued-message-more">
          <summary aria-label="Mais ações para a mensagem">
            <Icon name="more" size={14} />
          </summary>
          <div class="queued-message-menu" role="menu">
            <button onClick={props.onEdit} role="menuitem" type="button">
              <Icon name="edit" size={14} strokeWidth={1.7} />
              Editar mensagem
            </button>
            <button onClick={props.onToggleQueueing} role="menuitem" type="button">
              <Icon name="stop" size={13} strokeWidth={1.7} />
              {props.queueingEnabled ? "Desativar fila" : "Ativar fila"}
            </button>
          </div>
        </details>
      </div>
    </li>
  );
}

function ModelMenuRow(props: {
  readonly active: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onActivate: () => void;
  readonly value: string;
  readonly valueTone?: "ultra" | undefined;
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
      <small classList={{ "tone-ultra": props.valueTone === "ultra" }}>{props.value}</small>
      <Icon name="chevronRight" size={16} />
    </button>
  );
}

function ChatModelMenuOptions(props: {
  readonly model: ChatModelOption | undefined;
  readonly models: readonly ChatModelOption[];
  readonly onSelect: (option: ChatModelOption) => void;
}) {
  return (
    <div class="model-menu-options chat-model-options">
      <For each={props.models}>
        {(entry) => (
          <button
            aria-checked={entry.id === props.model?.id}
            class="model-menu-option"
            classList={{ selected: entry.id === props.model?.id }}
            onClick={() => props.onSelect(entry)}
            role="menuitemradio"
            type="button"
          >
            <span>{chatOptionLabel(entry)}</span>
            <Show when={entry.id === props.model?.id}>
              <Icon name="check" size={15} />
            </Show>
          </button>
        )}
      </For>
    </div>
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
            {(entry) => {
              return (
                <button
                  aria-checked={entry.id === props.model?.id}
                  class="model-menu-option"
                  classList={{
                    selected: entry.id === props.model?.id,
                  }}
                  onClick={() => props.onSelectModel(entry.id)}
                  role="menuitemradio"
                  type="button"
                >
                  <span class="model-menu-option-copy">
                    <strong>{entry.displayName}</strong>
                  </span>
                  <Show when={entry.id === props.model?.id}>
                    <Icon name="check" size={15} />
                  </Show>
                </button>
              );
            }}
          </For>
        </Show>
        <Show when={props.section === "effort"}>
          <For each={props.model?.supportedReasoningEfforts ?? []}>
            {(option) => {
              const unsupported =
                props.model?.unsupportedReasoningEfforts.includes(option.reasoningEffort) === true;
              return (
                <button
                  aria-checked={option.reasoningEffort === props.effort}
                  class="model-menu-option"
                  classList={{
                    described: unsupported,
                    selected: option.reasoningEffort === props.effort,
                  }}
                  disabled={unsupported}
                  onClick={() => props.onSelectEffort(option.reasoningEffort)}
                  role="menuitemradio"
                  title={unsupported ? "Requer execução multiagente neste runtime." : undefined}
                  type="button"
                >
                  <span class="model-menu-option-copy">
                    <strong classList={{ "tone-ultra": option.reasoningEffort === "ultra" }}>
                      {effortLabel(option.reasoningEffort)}
                    </strong>
                    <Show when={unsupported}>
                      <small>Requer execução multiagente</small>
                    </Show>
                  </span>
                  <Show when={option.reasoningEffort === props.effort}>
                    <Icon name="check" size={15} />
                  </Show>
                </button>
              );
            }}
          </For>
        </Show>
        <Show when={props.section === "serviceTier"}>
          <button
            aria-checked={props.serviceTier === null}
            class="model-menu-option described"
            classList={{ selected: props.serviceTier === null }}
            onClick={() => props.onSelectServiceTier(null)}
            role="menuitemradio"
            type="button"
          >
            <span class="model-menu-option-copy">
              <strong>Padrão</strong>
              <small>Velocidade padrão</small>
            </span>
            <Show when={props.serviceTier === null}>
              <Icon name="check" size={15} />
            </Show>
          </button>
          <For each={props.model?.serviceTiers ?? []}>
            {(tier) => (
              <button
                aria-checked={tier.id === props.serviceTier}
                class="model-menu-option described"
                classList={{ selected: tier.id === props.serviceTier }}
                onClick={() => props.onSelectServiceTier(tier.id)}
                role="menuitemradio"
                type="button"
              >
                <span class="model-menu-option-copy">
                  <strong>{tier.name}</strong>
                  <small>{tier.description}</small>
                </span>
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
  if (result.length > COMPOSER_ATTACHMENT_MAXIMUM_COUNT) {
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
  element.style.height = `${Math.min(element.scrollHeight, COMPOSER_TEXTAREA_MAXIMUM_HEIGHT_PX)}px`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  const chunkSize: number = 32_768;
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

function composerPlaceholder(mode: "chat" | "work" | "codex"): string {
  switch (mode) {
    case "chat":
      return "Mensagem para o ChatGPT";
    case "work":
      return "Trabalhe com o ChatGPT";
    case "codex":
      return "Peça qualquer coisa";
  }
}
