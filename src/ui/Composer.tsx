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
  ModelContextWindowPreference,
  ModelDefaults,
  PermissionProfile,
  ReasoningEffort,
} from "../contracts/types";
import { useI18n } from "../i18n/context";
import { formatMessage, type TranslationMessages } from "../i18n/messages";
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
  | "ensureModelsForMode"
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
import { canSubmitComposerMessage, shouldWarmComposerModelCatalog } from "./composerSubmission";
import { Icon } from "./Icon";
import { ImagePreview } from "./ImagePreview";
import {
  formatModelContextTokens,
  modelContextWindowOptions,
  modelContextWindowPreference,
  resolveModelContextWindow,
} from "./modelContextWindow";
import {
  persistModelDefaults,
  resolveRuntimeCompatibleModelSelection,
  selectRuntimeCompatibleModel,
  selectRuntimeCompatibleReasoningEffort,
  selectRuntimeCompatibleServiceTier,
} from "./modelSelection";
import { presentServiceTier, selectedServiceTierLabel } from "./serviceTierPresentation";

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

type ModelMenuSection = "contextWindow" | "effort" | "model" | "serviceTier";
type ComposerMessages = TranslationMessages["composer"];

export function Composer(props: ComposerProps) {
  const i18n = useI18n();
  const messages = () => i18n.messages().composer;
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
  let modelSelectionWriteRevision = 0;
  let pendingModelSelection: ModelDefaults | null = null;

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
  const selectedContextWindowOptions = createMemo(() => modelContextWindowOptions(selectedModel()));
  const selectedContextWindowLabel = createMemo(() => {
    const window = selectedModelWindow();
    return window === null
      ? messages().default
      : formatModelContextTokens(window.tokens, i18n.locale());
  });
  const selectedChatOption = createMemo(() => chatIntelligence().option);
  const selectedChatLabel = createMemo(() => {
    const option = selectedChatOption();
    return option === undefined ? messages().loading : chatOptionLabel(option);
  });
  const reasoningOptions = createMemo(() => configuredModel()?.supportedReasoningEfforts ?? []);
  const modelSelectionReady = createMemo(() =>
    mode() === "chat" ? selectedChatOption() !== undefined : selectedModel() !== undefined,
  );
  const modelSelectionRequired = createMemo(
    () => !props.controller.turnBusy() || queueingEnabled(),
  );
  const hasDraft = createMemo(() => text().trim().length > 0 || attachments().length > 0);
  const canSend = createMemo(() =>
    canSubmitComposerMessage({
      hasDraft: hasDraft(),
      modelSelectionRequired: modelSelectionRequired(),
      modelSelectionReady: modelSelectionReady(),
      sending: sending(),
    }),
  );

  createEffect(() => {
    if (
      !shouldWarmComposerModelCatalog({
        engineReady: props.controller.engine() !== null,
        hasDraft: hasDraft(),
      })
    ) {
      return;
    }
    void props.controller.ensureModelsForMode(mode());
  });

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
    if (
      pendingModelSelection !== null &&
      (configured.model !== pendingModelSelection.model ||
        configured.modelReasoningEffort !== pendingModelSelection.reasoningEffort ||
        configured.serviceTier !== pendingModelSelection.serviceTier)
    ) {
      return;
    }
    pendingModelSelection = null;
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
    persistModelSelection(applyCodexSelection(value, effort(), null));
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
    const defaults = {
      model: null,
      reasoningEffort: null,
      serviceTier: null,
    } satisfies ModelDefaults;
    applyCodexSelection(defaults.model, defaults.reasoningEffort, defaults.serviceTier);
    persistModelSelection(defaults);
  }

  function restoreConfiguredModelSelection(): void {
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
  ): ModelDefaults {
    const selection = resolveRuntimeCompatibleModelSelection(
      props.controller.models(),
      requestedModel,
      requestedEffort,
      requestedServiceTier,
    );
    setModel(selection.model);
    setEffort(selection.reasoningEffort);
    setServiceTier(selection.serviceTier);
    return selection;
  }

  function persistModelSelection(selection: ModelDefaults): void {
    const revision = ++modelSelectionWriteRevision;
    pendingModelSelection = selection;
    void persistModelDefaults(props.controller.updateSetting, selection).then((succeeded) => {
      if (revision !== modelSelectionWriteRevision) {
        return;
      }
      pendingModelSelection = null;
      if (!succeeded) {
        restoreConfiguredModelSelection();
      }
    });
  }

  function selectNextEffort(value: ReasoningEffort): void {
    setEffort(value);
    persistModelSelection({
      model: selectedModel()?.id ?? null,
      reasoningEffort: value,
      serviceTier: serviceTier(),
    });
  }

  function selectNextServiceTier(value: string | null): void {
    setServiceTier(value);
    persistModelSelection({
      model: selectedModel()?.id ?? null,
      reasoningEffort: effort(),
      serviceTier: value,
    });
  }

  function selectNextContextWindow(value: ModelContextWindowPreference): void {
    const selected = selectedModel();
    if (selected === undefined || selectedContextWindowOptions().length === 0) {
      return;
    }
    void props.controller.updateSetting({
      type: "modelContextWindow",
      model: selected.id,
      value,
    });
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
    if (modelSelectionRequired() && !modelSelectionReady()) {
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
        <ul aria-label={messages().queuedMessages} class="composer-queue">
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
        aria-label={messages().label}
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
                        aria-label={formatMessage(messages().removeNamed, {
                          name: attachment.name,
                        })}
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
                      aria-label={formatMessage(messages().removeNamed, {
                        name: attachment.name,
                      })}
                      class="composer-image-remove"
                      onClick={() => removeAttachment(attachment.id)}
                      title={formatMessage(messages().removeNamed, { name: attachment.name })}
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
          aria-label={composerPlaceholder(mode(), messages())}
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
          placeholder={composerPlaceholder(mode(), messages())}
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
                aria-label={messages().addFilesOrProject}
                class="add-button"
                classList={{ active: addMenuOpen() }}
                disabled={props.controller.turnBusy()}
                onClick={() => {
                  setAddMenuOpen((value) => !value);
                  setPermissionMenuOpen(false);
                  setModelMenuOpen(false);
                  setModelMenuSection(null);
                }}
                title={messages().add}
                type="button"
              >
                <Icon name="plus" size={17} />
              </button>
              <Show when={addMenuOpen()}>
                <div
                  aria-label={messages().add}
                  class="composer-popover add-menu"
                  id="composer-add-menu"
                  role="menu"
                >
                  <header>{messages().add}</header>
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
                      <strong>{messages().files}</strong>
                      <small>{messages().attachmentLimit}</small>
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
                            ? messages().chooseProject
                            : messages().switchProject}
                        </strong>
                        <small>{messages().workspaceDescription}</small>
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
                  title={messages().permissions}
                  type="button"
                >
                  <Icon name="shield" size={15} />
                  <span>
                    {permissionLabel(
                      props.controller.config()?.config.permissionProfile.sandbox,
                      messages(),
                    )}
                  </span>
                </button>
                <Show when={permissionMenuOpen()}>
                  <div
                    aria-label={messages().permissions}
                    class="composer-popover permission-menu"
                    role="menu"
                  >
                    <header>
                      <strong>{messages().permissionQuestion}</strong>
                      <button
                        onClick={() => {
                          setPermissionMenuOpen(false);
                          props.onOpenSettings();
                        }}
                        type="button"
                      >
                        {messages().settings}
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
                            <strong>{permissionLabel(profile.sandbox, messages())}</strong>
                            <small>{permissionDescription(profile, messages())}</small>
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
                  title={messages().modelAndReasoning}
                  type="button"
                >
                  <span class="model-button-effort">{selectedChatLabel()}</span>
                  <Icon name="chevronDown" size={13} />
                </button>
                <Show when={modelMenuOpen()}>
                  <div
                    aria-label={messages().modelAndReasoning}
                    class="composer-popover model-menu chat-intelligence-menu"
                    role="menu"
                  >
                    <div class="chat-intelligence-heading">
                      <span>{messages().chatModel}</span>
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
                        <span>{messages().resetDefault}</span>
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
                  title={messages().codexModelControls}
                  type="button"
                >
                  <Show when={serviceTier() !== null}>
                    <span class="model-speed-indicator">
                      <Icon name="bolt" size={13} />
                      <span class="visually-hidden">{messages().fastModeActive}</span>
                    </span>
                  </Show>
                  <span class="model-button-name">
                    {selectedModel() === undefined
                      ? messages().loading
                      : compactModelName(selectedModel()?.displayName ?? "")}
                  </span>
                  <Show when={effort()}>
                    {(selectedEffort) => (
                      <span
                        class="model-button-effort"
                        classList={{ ultra: selectedEffort() === "ultra" }}
                      >
                        {effortLabel(selectedEffort(), messages())}
                      </span>
                    )}
                  </Show>
                  <Icon name="chevronDown" size={13} />
                </button>
                <Show when={modelMenuOpen()}>
                  <div
                    aria-label={messages().codexModelControlsMenu}
                    class="composer-popover model-menu"
                    role="menu"
                  >
                    <ModelMenuRow
                      active={modelMenuSection() === "model"}
                      label={messages().model}
                      onActivate={() => setModelMenuSection("model")}
                      value={
                        selectedModel() === undefined
                          ? messages().loading
                          : compactModelName(selectedModel()?.displayName ?? "")
                      }
                    />
                    <ModelMenuRow
                      active={modelMenuSection() === "effort"}
                      disabled={reasoningOptions().length === 0}
                      label={messages().effort}
                      onActivate={() => setModelMenuSection("effort")}
                      value={selectedEffortLabel(effort(), messages())}
                      valueTone={effort() === "ultra" ? "ultra" : undefined}
                    />
                    <Show when={selectedContextWindowOptions().length > 0}>
                      <ModelMenuRow
                        active={modelMenuSection() === "contextWindow"}
                        label={messages().contextWindow}
                        onActivate={() => setModelMenuSection("contextWindow")}
                        value={selectedContextWindowLabel()}
                      />
                    </Show>
                    <ModelMenuRow
                      active={modelMenuSection() === "serviceTier"}
                      label={messages().speed}
                      onActivate={() => setModelMenuSection("serviceTier")}
                      value={selectedServiceTierLabel(
                        selectedModel()?.serviceTiers ?? [],
                        serviceTier(),
                        messages(),
                      )}
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
                      <span>{messages().resetDefault}</span>
                      <Icon name="reset" size={14} />
                    </button>
                    <Show when={modelMenuSection()}>
                      {(section) => (
                        <ModelMenuOptions
                          contextWindowPreference={selectedContextWindowPreference()}
                          effort={effort()}
                          locale={i18n.locale()}
                          model={selectedModel()}
                          models={props.controller.models()}
                          onSelectContextWindow={(value) => {
                            selectNextContextWindow(value);
                            closeComposerMenus();
                          }}
                          onSelectEffort={(value) => {
                            selectNextEffort(value);
                            closeComposerMenus();
                          }}
                          onSelectModel={(value) => {
                            selectNextModel(value);
                            closeComposerMenus();
                          }}
                          onSelectServiceTier={(value) => {
                            selectNextServiceTier(value);
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
                  aria-label={messages().interruptTurn}
                  class="send-button stop-button"
                  onClick={() => void props.controller.interrupt()}
                  title={messages().interrupt}
                  type="button"
                >
                  <Icon name="stop" size={14} />
                </button>
              }
            >
              <button
                aria-label={
                  props.controller.turnBusy() && queueingEnabled()
                    ? messages().queueMessage
                    : messages().sendMessage
                }
                class="send-button"
                disabled={!canSend()}
                onClick={() => void send()}
                title={
                  props.controller.turnBusy() && queueingEnabled()
                    ? messages().addToQueue
                    : props.controller.turnBusy()
                      ? messages().steerNow
                      : modelSelectionReady()
                        ? messages().send
                        : messages().waitForModels
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
  const i18n = useI18n();
  const messages = () => i18n.messages().composer;
  const summary = () => {
    const message = props.message.text.trim();
    if (message.length > 0) {
      return message;
    }
    const count = props.message.attachments.length;
    return count === 1
      ? messages().oneAttachment
      : formatMessage(messages().manyAttachments, { count });
  };

  return (
    <li class="queued-message">
      <Icon name="cornerDownLeft" size={13} strokeWidth={1.7} />
      <span class="queued-message-copy">{summary()}</span>
      <div class="queued-message-actions">
        <button class="queued-message-steer" onClick={props.onSendNow} type="button">
          <Icon name="cornerDownLeft" size={13} strokeWidth={1.7} />
          {messages().steer}
        </button>
        <button aria-label={messages().deleteQueuedMessage} onClick={props.onDelete} type="button">
          <Icon name="trash" size={14} strokeWidth={1.7} />
        </button>
        <details class="queued-message-more">
          <summary aria-label={messages().moreMessageActions}>
            <Icon name="more" size={14} />
          </summary>
          <div class="queued-message-menu" role="menu">
            <button onClick={props.onEdit} role="menuitem" type="button">
              <Icon name="edit" size={14} strokeWidth={1.7} />
              {messages().editMessage}
            </button>
            <button onClick={props.onToggleQueueing} role="menuitem" type="button">
              <Icon name="stop" size={13} strokeWidth={1.7} />
              {props.queueingEnabled ? messages().disableQueue : messages().enableQueue}
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
  readonly contextWindowPreference: ModelContextWindowPreference;
  readonly effort: ReasoningEffort | null;
  readonly locale: string;
  readonly model: CodexModel | undefined;
  readonly models: readonly CodexModel[];
  readonly onSelectContextWindow: (value: ModelContextWindowPreference) => void;
  readonly onSelectEffort: (value: ReasoningEffort) => void;
  readonly onSelectModel: (value: string) => void;
  readonly onSelectServiceTier: (value: string | null) => void;
  readonly section: ModelMenuSection;
  readonly serviceTier: string | null;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().composer;
  return (
    <div
      aria-label={modelMenuSectionLabel(props.section, messages())}
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
                  title={unsupported ? messages().multiAgentRequiredTitle : undefined}
                  type="button"
                >
                  <span class="model-menu-option-copy">
                    <strong classList={{ "tone-ultra": option.reasoningEffort === "ultra" }}>
                      {effortLabel(option.reasoningEffort, messages())}
                    </strong>
                    <Show when={unsupported}>
                      <small>{messages().multiAgentRequired}</small>
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
        <Show when={props.section === "contextWindow"}>
          <For each={modelContextWindowOptions(props.model)}>
            {(option) => (
              <button
                aria-checked={option.preference === props.contextWindowPreference}
                class="model-menu-option described"
                classList={{ selected: option.preference === props.contextWindowPreference }}
                onClick={() => props.onSelectContextWindow(option.preference)}
                role="menuitemradio"
                type="button"
              >
                <span class="model-menu-option-copy">
                  <strong>
                    {option.preference === "default"
                      ? messages().contextDefault
                      : messages().contextMaximum}
                  </strong>
                  <small>
                    {formatMessage(
                      option.preference === "default"
                        ? messages().contextDefaultDescription
                        : messages().contextMaximumDescription,
                      { tokens: formatModelContextTokens(option.tokens, props.locale) },
                    )}
                  </small>
                </span>
                <Show when={option.preference === props.contextWindowPreference}>
                  <Icon name="check" size={15} />
                </Show>
              </button>
            )}
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
              <strong>{messages().default}</strong>
              <small>{messages().speedDefaultDescription}</small>
            </span>
            <Show when={props.serviceTier === null}>
              <Icon name="check" size={15} />
            </Show>
          </button>
          <For each={props.model?.serviceTiers ?? []}>
            {(tier) => {
              const presentation = () => presentServiceTier(tier, messages());
              return (
                <button
                  aria-checked={tier.id === props.serviceTier}
                  class="model-menu-option described"
                  classList={{ selected: tier.id === props.serviceTier }}
                  onClick={() => props.onSelectServiceTier(tier.id)}
                  role="menuitemradio"
                  type="button"
                >
                  <span class="model-menu-option-copy">
                    <strong>{presentation().name}</strong>
                    <small>{presentation().description}</small>
                  </span>
                  <Show when={tier.id === props.serviceTier}>
                    <Icon name="check" size={15} />
                  </Show>
                </button>
              );
            }}
          </For>
        </Show>
      </div>
    </div>
  );
}

function modelMenuSectionLabel(section: ModelMenuSection, messages: ComposerMessages): string {
  switch (section) {
    case "model":
      return messages.model;
    case "effort":
      return messages.effort;
    case "contextWindow":
      return messages.contextWindow;
    case "serviceTier":
      return messages.speed;
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
    throw new Error("A message accepts at most 12 attachments.");
  }
  return result;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The attachments could not be processed.";
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

function effortLabel(effort: ReasoningEffort, messages: ComposerMessages): string {
  switch (effort) {
    case "none":
      return messages.reasoningNone;
    case "minimal":
      return messages.reasoningMinimal;
    case "low":
      return messages.reasoningLow;
    case "medium":
      return messages.reasoningMedium;
    case "high":
      return messages.reasoningHigh;
    case "xhigh":
      return messages.reasoningExtraHigh;
    case "max":
      return messages.reasoningMaximum;
    case "ultra":
      return messages.reasoningUltra;
  }
}

function selectedEffortLabel(effort: ReasoningEffort | null, messages: ComposerMessages): string {
  return effort === null ? messages.default : effortLabel(effort, messages);
}

function permissionLabel(mode: string | undefined, messages: ComposerMessages): string {
  switch (mode) {
    case "read-only":
      return messages.readOnly;
    case "workspace-write":
      return messages.approveForMe;
    case "danger-full-access":
      return messages.fullAccess;
    default:
      return messages.permissions;
  }
}

function permissionDescription(profile: PermissionProfile, messages: ComposerMessages): string {
  switch (profile.sandbox) {
    case "read-only":
      return messages.readOnlyDescription;
    case "workspace-write":
      return messages.approveForMeDescription;
    case "danger-full-access":
      return messages.fullAccessDescription;
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

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function composerPlaceholder(mode: "chat" | "work" | "codex", messages: ComposerMessages): string {
  switch (mode) {
    case "chat":
      return messages.chatPlaceholder;
    case "work":
      return messages.workPlaceholder;
    case "codex":
      return messages.codexPlaceholder;
  }
}
