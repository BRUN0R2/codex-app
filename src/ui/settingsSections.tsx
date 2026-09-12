import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

import type { ModelVerbosity, Personality, WebSearchMode } from "../contracts/types";
import { useI18n } from "../i18n/context";
import { formatMessage } from "../i18n/messages";
import { isBrowserPreview, isDesktopRuntime } from "../platform/desktopRuntime";

import { Icon, type IconName } from "./Icon";
import { outputDetailLabel, outputDetailOptions } from "./outputDetail";
import { ProfileView } from "./ProfileView";
import {
  PreferenceCheckbox,
  SettingsHeading,
  SettingsRow,
  SettingsSection,
} from "./SettingsPrimitives";
import { threadTitle } from "./Sidebar";
import {
  DEVELOPER_INSTRUCTIONS_MAXIMUM_BYTES,
  OUTPUT_DETAIL_MENU_ESTIMATED_HEIGHT_PX,
  SETTINGS_SAVE_CONFIRMATION_DURATION_MS,
  type SettingsDialogController,
  type SettingsPage,
} from "./settingsShared";

export function SettingsNavButton(props: {
  readonly icon: IconName;
  readonly label: string;
  readonly page: SettingsPage;
  readonly selected: SettingsPage;
  readonly setPage: (page: SettingsPage) => void;
}) {
  return (
    <button
      aria-current={props.selected === props.page ? "page" : undefined}
      classList={{ active: props.selected === props.page }}
      onClick={() => props.setPage(props.page)}
      type="button"
    >
      <Icon name={props.icon} size={16} />
      <span>{props.label}</span>
    </button>
  );
}

export function normalizeSearch(value: string, locale: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase(locale);
}

export function ApplicationPreferencesSettings(props: {
  readonly controller: SettingsDialogController;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().settings;
  const desktopRuntime = isDesktopRuntime() || isBrowserPreview();
  const preferences = props.controller.applicationPreferences;
  const controlsDisabled = () =>
    !desktopRuntime || !props.controller.applicationPreferencesLoaded();
  const status = () => {
    if (!desktopRuntime) return messages().desktopOnly;
    if (!props.controller.applicationPreferencesLoaded()) return messages().loadingAppPreferences;
    return props.controller.applicationPreferencesError() ?? "";
  };

  return (
    <>
      <SettingsSection
        busy={!props.controller.applicationPreferencesLoaded()}
        description={messages().applicationDescription}
        title={messages().application}
      >
        <PreferenceCheckbox
          checked={preferences().startWithWindows}
          description={messages().startWithWindowsDescription}
          disabled={controlsDisabled()}
          label={messages().startWithWindows}
          onChange={(startWithWindows) =>
            void props.controller.updateApplicationPreferences({ startWithWindows })
          }
        />
        <PreferenceCheckbox
          checked={preferences().startMinimized}
          description={messages().startMinimizedDescription}
          disabled={controlsDisabled() || !preferences().startWithWindows}
          label={messages().startMinimized}
          onChange={(startMinimized) =>
            void props.controller.updateApplicationPreferences({ startMinimized })
          }
        />
        <PreferenceCheckbox
          checked={preferences().closeToTray}
          description={messages().closeToTrayDescription}
          disabled={controlsDisabled()}
          label={messages().closeToTray}
          onChange={(closeToTray) =>
            void props.controller.updateApplicationPreferences({ closeToTray })
          }
        />
      </SettingsSection>
      <span aria-live="polite" class="visually-hidden">
        {props.controller.applicationPreferencesSaving() ? messages().savingAppPreferences : ""}
      </span>
      <Show when={status().length > 0}>
        <p
          aria-live="polite"
          class="application-preferences-status"
          classList={{ error: props.controller.applicationPreferencesError() !== null }}
        >
          {status()}
        </p>
      </Show>
    </>
  );
}

export function GeneralSettings(props: { readonly controller: SettingsDialogController }) {
  const i18n = useI18n();
  const messages = () => i18n.messages().settings;
  const configuration = () => props.controller.config()?.config;

  return (
    <div class="settings-page">
      <SettingsHeading title={messages().general} description={messages().generalDescription} />
      <LanguageSettings controller={props.controller} />
      <ApplicationPreferencesSettings controller={props.controller} />
      <SettingsSection allowOverflow title={messages().model}>
        <SettingsRow
          label={messages().outputDetail}
          description={messages().outputDetailDescription}
        >
          <OutputDetailSelect
            disabled={configuration() === undefined}
            onChange={(value) =>
              void props.controller.saveSetting({ type: "modelVerbosity", value })
            }
            value={configuration()?.modelVerbosity ?? null}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={messages().tools}>
        <SettingsRow label={messages().webSearch} description={messages().webSearchDescription}>
          <select
            onChange={(event) => {
              const value = parseWebSearch(event.currentTarget.value);
              if (value !== undefined)
                void props.controller.saveSetting({ type: "webSearch", value });
            }}
            value={configuration()?.webSearch ?? "disabled"}
          >
            <option value="disabled">{messages().webSearchDisabled}</option>
            <option value="live">{messages().webSearchLive}</option>
          </select>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}

export function LanguageSettings(props: { readonly controller: SettingsDialogController }) {
  const i18n = useI18n();
  const messages = () => i18n.messages().language;
  const issueMessage = () => {
    const issue = i18n.storageIssue();
    return issue === null ? null : messages()[issue];
  };

  function selectLanguage(value: string): void {
    if (value === "auto") {
      i18n.setPreference("auto");
      return;
    }
    const catalog = i18n.availableCatalogs.find((candidate) => candidate.locale === value);
    if (catalog === undefined) {
      props.controller.reportError(
        new Error(`Translation locale ${JSON.stringify(value)} is unavailable.`),
      );
      return;
    }
    i18n.setPreference(catalog.locale);
  }

  return (
    <SettingsSection description={messages().sectionDescription} title={messages().sectionTitle}>
      <SettingsRow description={messages().fieldDescription} label={messages().fieldLabel}>
        <select
          aria-label={messages().fieldLabel}
          class="language-preference-select"
          onChange={(event) => selectLanguage(event.currentTarget.value)}
          value={i18n.preference()}
        >
          <option value="auto">{messages().autoDetect}</option>
          <For each={i18n.availableCatalogs}>
            {(catalog) => <option value={catalog.locale}>{catalog.name}</option>}
          </For>
        </select>
      </SettingsRow>
      <Show when={issueMessage()}>
        {(message) => (
          <p aria-live="polite" class="application-preferences-status error">
            {message()}
          </p>
        )}
      </Show>
    </SettingsSection>
  );
}

export function PersonalizationSettings(props: {
  readonly controller: SettingsDialogController;
  readonly developerInstructions: string;
  readonly setDeveloperInstructions: (value: string) => void;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().settings;
  const personality = () => props.controller.config()?.config.personality ?? "pragmatic";
  const [instructionSaveState, setInstructionSaveState] = createSignal<"idle" | "saved" | "saving">(
    "idle",
  );
  let confirmationTimer: ReturnType<typeof setTimeout> | null = null;
  let active = true;

  onCleanup(() => {
    active = false;
    if (confirmationTimer !== null) clearTimeout(confirmationTimer);
  });

  function clearSaveConfirmation(): void {
    if (confirmationTimer !== null) {
      clearTimeout(confirmationTimer);
      confirmationTimer = null;
    }
    if (instructionSaveState() === "saved") setInstructionSaveState("idle");
  }

  async function saveDeveloperInstructions(): Promise<void> {
    if (instructionSaveState() === "saving") return;
    clearSaveConfirmation();
    const instructions = props.developerInstructions.trim() || null;
    setInstructionSaveState("saving");
    const saved = await props.controller.saveSetting({
      type: "developerInstructions",
      value: instructions,
    });
    if (!active) return;
    if (!saved || (props.developerInstructions.trim() || null) !== instructions) {
      setInstructionSaveState("idle");
      return;
    }
    setInstructionSaveState("saved");
    confirmationTimer = setTimeout(() => {
      confirmationTimer = null;
      setInstructionSaveState("idle");
    }, SETTINGS_SAVE_CONFIRMATION_DURATION_MS);
  }

  return (
    <div class="settings-page">
      <SettingsHeading
        title={messages().personalization}
        description={messages().personalizationDescription}
      />
      <SettingsRow label={messages().personality} description={messages().personalityDescription}>
        <select
          onChange={(event) => {
            const value = parsePersonality(event.currentTarget.value);
            if (value !== undefined)
              void props.controller.saveSetting({ type: "personality", value });
          }}
          value={personality()}
        >
          <option value="pragmatic">{messages().pragmatic}</option>
          <option value="friendly">{messages().friendly}</option>
          <option value="none">{messages().noPersonality}</option>
        </select>
      </SettingsRow>
      <label class="settings-textarea-row">
        <span>
          <strong>{messages().developerInstructions}</strong>
          <small>{messages().developerInstructionsDescription}</small>
        </span>
        <textarea
          maxlength={DEVELOPER_INSTRUCTIONS_MAXIMUM_BYTES}
          onInput={(event) => {
            clearSaveConfirmation();
            props.setDeveloperInstructions(event.currentTarget.value);
          }}
          placeholder={messages().developerInstructionsPlaceholder}
          rows={9}
          value={props.developerInstructions}
        />
      </label>
      <div class="settings-actions">
        <button
          aria-busy={instructionSaveState() === "saving"}
          class="primary-button"
          classList={{ "settings-save-confirmed": instructionSaveState() === "saved" }}
          disabled={instructionSaveState() === "saving"}
          onClick={() => void saveDeveloperInstructions()}
          type="button"
        >
          <Show when={instructionSaveState() === "saved"}>
            <Icon name="check" size={15} />
          </Show>
          <span aria-live="polite">
            {instructionSaveState() === "saving"
              ? messages().savingInstructions
              : instructionSaveState() === "saved"
                ? messages().instructionsSaved
                : messages().saveInstructions}
          </span>
        </button>
      </div>
    </div>
  );
}

export function ShortcutsSettings() {
  const i18n = useI18n();
  const messages = () => i18n.messages().settings;
  return (
    <div class="settings-page">
      <SettingsHeading title={messages().shortcuts} description={messages().shortcutsDescription} />
      <SettingsSection title={messages().shortcutGeneral}>
        <ShortcutRow keys={["Ctrl", "N"]} label={messages().newChat} />
        <ShortcutRow keys={["Ctrl", "K"]} label={messages().searchSidebar} />
        <ShortcutRow keys={["Ctrl", ","]} label={messages().openSettings} />
        <ShortcutRow keys={["Ctrl", "B"]} label={messages().toggleSidebar} />
        <ShortcutRow keys={["Ctrl", "R"]} label={messages().reloadWindow} />
      </SettingsSection>
      <SettingsSection title={messages().conversation}>
        <ShortcutRow keys={["Enter"]} label={messages().sendMessage} />
        <ShortcutRow keys={["Shift", "Enter"]} label={messages().newLine} />
        <ShortcutRow keys={["Esc"]} label={messages().closeMenus} />
      </SettingsSection>
    </div>
  );
}

export function ShortcutRow(props: { readonly keys: readonly string[]; readonly label: string }) {
  return (
    <div class="settings-row shortcut-row">
      <span>
        <strong>{props.label}</strong>
      </span>
      <div class="shortcut-keys">
        <For each={props.keys}>{(key) => <kbd>{key}</kbd>}</For>
      </div>
    </div>
  );
}

export function ProfileSettings(props: { readonly controller: SettingsDialogController }) {
  const i18n = useI18n();
  const messages = () => i18n.messages().settings;
  return (
    <div class="settings-page profile-settings-page">
      <SettingsHeading title={messages().profile} description={messages().profileDescription} />
      <ProfileView controller={props.controller} mode="settings" />
    </div>
  );
}

export function DiagnosticsSettings(props: { readonly controller: SettingsDialogController }) {
  const i18n = useI18n();
  const messages = () => i18n.messages().settings;
  return (
    <div class="settings-page diagnostics-page">
      <SettingsHeading
        title={messages().diagnostics}
        description={messages().diagnosticsDescription}
      />
      <Show when={props.controller.engine()?.diagnosticLogPath}>
        {(path) => (
          <section class="diagnostics-log-location">
            <strong>{messages().logFile}</strong>
            <code>{path()}</code>
          </section>
        )}
      </Show>
      <Show
        when={props.controller.diagnostics().length > 0}
        fallback={<p class="diagnostics-empty">{messages().noDiagnostics}</p>}
      >
        <ol class="diagnostics-list">
          <For each={[...props.controller.diagnostics()].reverse()}>
            {(entry) => (
              <li>
                <time>{entry.occurredAt.toLocaleTimeString(i18n.locale())}</time>
                <code>{entry.stream}</code>
                <p>{entry.message}</p>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </div>
  );
}

export function ArchivedChatsSettings(props: { readonly controller: SettingsDialogController }) {
  const i18n = useI18n();
  const messages = () => i18n.messages().settings;
  onMount(() => {
    if (!props.controller.archivedThreadsLoaded()) {
      void props.controller.loadMoreArchivedThreads();
    }
  });

  return (
    <div class="settings-page">
      <SettingsHeading
        title={messages().archivedChats}
        description={messages().archivedDescription}
      />
      <SettingsSection busy={props.controller.archivedThreadsLoading()} title={messages().archived}>
        <Show
          when={props.controller.archivedThreadsLoaded()}
          fallback={
            <div class="archived-chats-status">
              <p class="archived-chats-empty">
                {props.controller.archivedThreadsLoading()
                  ? messages().loadingArchived
                  : messages().archivedLoadFailure}
              </p>
              <Show when={!props.controller.archivedThreadsLoading()}>
                <button
                  class="load-more-button"
                  onClick={() => void props.controller.loadMoreArchivedThreads()}
                  type="button"
                >
                  {i18n.messages().common.tryAgain}
                </button>
              </Show>
            </div>
          }
        >
          <Show
            when={props.controller.archivedThreads().length > 0}
            fallback={<p class="archived-chats-empty">{messages().noArchived}</p>}
          >
            <For each={props.controller.archivedThreads()}>
              {(thread) => (
                <div class="settings-row archived-chat-row">
                  <span>
                    <strong>{threadTitle(thread, i18n.messages().sidebar.newTask)}</strong>
                    <small>{thread.projectPath ?? messages().noProject}</small>
                  </span>
                  <div class="archived-chat-actions">
                    <button
                      aria-label={formatMessage(messages().restoreNamed, {
                        name: threadTitle(thread, i18n.messages().sidebar.newTask),
                      })}
                      onClick={() => void props.controller.unarchiveThread(thread.id)}
                      title={messages().restoreTitle}
                      type="button"
                    >
                      <Icon name="reset" size={14} /> {messages().restore}
                    </button>
                    <button
                      aria-label={formatMessage(messages().deleteNamed, {
                        name: threadTitle(thread, i18n.messages().sidebar.newTask),
                      })}
                      class="archived-chat-delete"
                      onClick={() => void props.controller.deleteThread(thread.id)}
                      title={messages().deleteTitle}
                      type="button"
                    >
                      <Icon name="close" size={14} /> {messages().delete}
                    </button>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </Show>
        <Show
          when={
            props.controller.archivedThreadsLoaded() &&
            props.controller.archivedThreadsNextCursor() !== null
          }
        >
          <button
            class="load-more-button"
            disabled={props.controller.archivedThreadsLoading()}
            onClick={() => void props.controller.loadMoreArchivedThreads()}
            type="button"
          >
            {messages().loadMore}
          </button>
        </Show>
      </SettingsSection>
    </div>
  );
}

export function OutputDetailSelect(props: {
  readonly disabled: boolean;
  readonly onChange: (value: ModelVerbosity | null) => void;
  readonly value: ModelVerbosity | null;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().settings;
  const options = () => outputDetailOptions(messages());
  const [open, setOpen] = createSignal(false);
  const [openAbove, setOpenAbove] = createSignal(false);
  let rootElement: HTMLDivElement | undefined;
  let triggerElement: HTMLButtonElement | undefined;
  const optionElements: Array<HTMLButtonElement | undefined> = [];

  const selectedIndex = () => {
    const index = options().findIndex((option) => option.value === props.value);
    return index < 0 ? 0 : index;
  };

  function focusOption(index: number): void {
    const optionCount = options().length;
    const normalizedIndex = (index + optionCount) % optionCount;
    queueMicrotask(() => optionElements[normalizedIndex]?.focus());
  }

  function shouldOpenAbove(): boolean {
    const bounds = triggerElement?.getBoundingClientRect();
    if (bounds === undefined) {
      return false;
    }
    const availableBelow = window.innerHeight - bounds.bottom;
    return availableBelow < OUTPUT_DETAIL_MENU_ESTIMATED_HEIGHT_PX && bounds.top > availableBelow;
  }

  function openMenu(focusSelectedOption: boolean): void {
    setOpenAbove(shouldOpenAbove());
    setOpen(true);
    if (focusSelectedOption) {
      focusOption(selectedIndex());
    }
  }

  function openAndFocusSelected(): void {
    openMenu(true);
  }

  function toggleMenu(): void {
    if (open()) {
      setOpen(false);
      return;
    }
    openMenu(false);
  }

  function closeAndFocusTrigger(): void {
    setOpen(false);
    queueMicrotask(() => triggerElement?.focus());
  }

  function select(value: ModelVerbosity | null): void {
    closeAndFocusTrigger();
    if (value !== props.value) {
      props.onChange(value);
    }
  }

  function handleTriggerKeyDown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      openAndFocusSelected();
      return;
    }
    if (event.key === "Escape" && open()) {
      event.preventDefault();
      event.stopPropagation();
      closeAndFocusTrigger();
    }
  }

  function handleOptionKeyDown(event: KeyboardEvent, index: number): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusOption(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusOption(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusOption(0);
        break;
      case "End":
        event.preventDefault();
        focusOption(options().length - 1);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        closeAndFocusTrigger();
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  }

  function handleDocumentPointerDown(event: PointerEvent): void {
    if (open() && (!(event.target instanceof Node) || !rootElement?.contains(event.target))) {
      setOpen(false);
    }
  }

  function updatePlacement(): void {
    if (open()) {
      setOpenAbove(shouldOpenAbove());
    }
  }

  onMount(() => {
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    window.addEventListener("resize", updatePlacement);
  });
  onCleanup(() => {
    document.removeEventListener("pointerdown", handleDocumentPointerDown);
    window.removeEventListener("resize", updatePlacement);
  });

  return (
    <div
      class="output-detail-select"
      classList={{ open: open(), "open-above": openAbove() }}
      ref={rootElement}
    >
      <button
        aria-controls="output-detail-menu"
        aria-expanded={open()}
        aria-haspopup="menu"
        aria-label={messages().outputDetail}
        class="output-detail-trigger"
        classList={{ open: open() }}
        disabled={props.disabled}
        onClick={toggleMenu}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerElement}
        type="button"
      >
        <span>{outputDetailLabel(props.value, messages())}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      <Show when={open()}>
        <div
          aria-label={messages().outputDetail}
          class="output-detail-menu"
          id="output-detail-menu"
          role="menu"
        >
          <For each={options()}>
            {(option, index) => (
              <button
                aria-checked={option.value === props.value}
                class="output-detail-option"
                classList={{ selected: option.value === props.value }}
                onClick={() => select(option.value)}
                onKeyDown={(event) => handleOptionKeyDown(event, index())}
                ref={(element) => {
                  optionElements[index()] = element;
                }}
                role="menuitemradio"
                type="button"
              >
                <span>
                  <strong>{option.label}</strong>
                  <Show when={option.description}>
                    {(description) => <small>{description()}</small>}
                  </Show>
                </span>
                <Show when={option.value === props.value}>
                  <Icon name="check" size={16} />
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export function parseWebSearch(value: string): WebSearchMode | undefined {
  return value === "disabled" || value === "live" ? value : undefined;
}

export function parsePersonality(value: string): Personality | undefined {
  return value === "friendly" || value === "none" || value === "pragmatic" ? value : undefined;
}
