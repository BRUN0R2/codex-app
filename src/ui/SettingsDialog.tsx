import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";

import type {
  ApplicationPreferences,
  AutoTopUpSettingsSnapshot,
  CreditsSnapshot,
  ModelVerbosity,
  Personality,
  SpendControlLimitSnapshot,
  UsageResetCredit,
  WebSearchMode,
} from "../contracts/types";
import { useI18n } from "../i18n/context";
import { formatMessage, type TranslationMessages } from "../i18n/messages";
import {
  describeError,
  openExternalUrl,
  readApplicationPreferences,
  updateApplicationPreferences,
} from "../infrastructure/codexClient";
import { isBrowserPreview, isDesktopRuntime } from "../platform/desktopRuntime";
import type { AppController } from "../state/appController";

type SettingsDialogController = Pick<
  AppController,
  | "account"
  | "accountProfile"
  | "accountProfileError"
  | "accountProfileLoading"
  | "archivedThreads"
  | "archivedThreadsLoaded"
  | "archivedThreadsLoading"
  | "archivedThreadsNextCursor"
  | "config"
  | "deleteThread"
  | "diagnostics"
  | "engine"
  | "loadMoreArchivedThreads"
  | "logout"
  | "rateLimits"
  | "rateLimitsError"
  | "rateLimitsLoading"
  | "refreshRateLimits"
  | "refreshRateLimitsIfStale"
  | "usageResets"
  | "usageResetsError"
  | "usageResetsLoading"
  | "usageResetRedeemingId"
  | "refreshUsageResets"
  | "redeemUsageReset"
  | "autoTopUpSettings"
  | "autoTopUpError"
  | "autoTopUpLoading"
  | "refreshAutoTopUpSettings"
  | "refreshAccountProfile"
  | "enableAutoTopUp"
  | "updateAutoTopUp"
  | "disableAutoTopUp"
  | "reportError"
  | "unarchiveThread"
  | "updateSetting"
>;

import { accountPlanLabel } from "./accountPresentation";
import {
  DEFAULT_APPLICATION_PREFERENCES,
  mergeApplicationPreferences,
} from "./applicationPreferences";
import { formatShortDate, formatShortDateWithTimeZone } from "./dateFormat";
import { Icon, type IconName } from "./Icon";
import { outputDetailLabel, outputDetailOptions } from "./outputDetail";
import { ProfileView } from "./ProfileView";
import { threadTitle } from "./Sidebar";
import { SurfaceScrollbar } from "./SurfaceScrollbar";
import { presentUsageLimits, type UsageLimitEntry, usagePercentLabel } from "./usagePresentation";

export type SettingsPage =
  | "archived"
  | "diagnostics"
  | "general"
  | "personalization"
  | "profile"
  | "shortcuts"
  | "usage";

interface SettingsNavigationItem {
  readonly icon: IconName;
  readonly label: string;
  readonly page: SettingsPage;
}

interface SettingsNavigationSection {
  readonly items: readonly SettingsNavigationItem[];
  readonly label: string;
}

type SettingsMessages = TranslationMessages["settings"];

function settingsNavigation(messages: SettingsMessages): readonly SettingsNavigationSection[] {
  return [
    {
      label: messages.personalSection,
      items: [
        { icon: "settings", label: messages.general, page: "general" },
        { icon: "user", label: messages.profile, page: "profile" },
        { icon: "sparkles", label: messages.personalization, page: "personalization" },
        { icon: "keyboard", label: messages.shortcuts, page: "shortcuts" },
        { icon: "creditCard", label: messages.usageBilling, page: "usage" },
      ],
    },
    {
      label: messages.systemSection,
      items: [{ icon: "bug", label: messages.diagnostics, page: "diagnostics" }],
    },
    {
      label: messages.archivedSection,
      items: [{ icon: "archive", label: messages.archivedChats, page: "archived" }],
    },
  ];
}

const AUTO_TOP_UP_DEFAULT_RECHARGE_TARGET: string = "250";
const AUTO_TOP_UP_DEFAULT_RECHARGE_THRESHOLD: string = "125";
const DEVELOPER_INSTRUCTIONS_MAXIMUM_BYTES: number = 262_144;
const OUTPUT_DETAIL_MENU_ESTIMATED_HEIGHT_PX: number = 224;

export function SettingsDialog(props: {
  readonly controller: SettingsDialogController;
  readonly initialPage?: SettingsPage | undefined;
  readonly onClose: () => void;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().settings;
  const navigation = createMemo(() => settingsNavigation(messages()));
  const [page, setPage] = createSignal<SettingsPage>(props.initialPage ?? "general");
  const [query, setQuery] = createSignal("");
  const [developerInstructions, setDeveloperInstructions] = createSignal("");
  let dialogElement: HTMLElement | undefined;
  let settingsMainContentElement: HTMLDivElement | undefined;
  let settingsMainElement: HTMLElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  let previouslyFocusedElement: HTMLElement | null = null;
  const visibleNavigation = createMemo(() => {
    const normalizedQuery = normalizeSearch(query(), i18n.locale());
    if (normalizedQuery.length === 0) {
      return navigation();
    }
    return navigation()
      .map((section) => ({
        ...section,
        items: section.items.filter((item) =>
          normalizeSearch(item.label, i18n.locale()).includes(normalizedQuery),
        ),
      }))
      .filter((section) => section.items.length > 0);
  });

  createEffect(() => {
    setDeveloperInstructions(props.controller.config()?.config.developerInstructions ?? "");
  });

  onMount(() => {
    previouslyFocusedElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => searchInput?.focus());
  });

  onCleanup(() => previouslyFocusedElement?.focus());

  function handleDialogKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key !== "Tab" || dialogElement === undefined) {
      return;
    }
    const focusable = [...dialogElement.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
      (element) => element.getClientRects().length > 0,
    );
    const first = focusable.at(0);
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div class="settings-overlay">
      <section
        aria-label={messages().title}
        aria-modal="true"
        class="settings-dialog"
        onKeyDown={handleDialogKeyDown}
        ref={dialogElement}
        role="dialog"
      >
        <aside class="settings-nav">
          <button class="settings-back" onClick={props.onClose} type="button">
            <Icon name="arrowLeft" size={15} />
            <span>{messages().back}</span>
          </button>
          <label class="settings-search">
            <Icon name="search" size={14} />
            <input
              aria-label={messages().search}
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder={messages().searchPlaceholder}
              ref={searchInput}
              type="search"
              value={query()}
            />
          </label>
          <nav aria-label={messages().sections}>
            <For each={visibleNavigation()}>
              {(section) => (
                <section class="settings-nav-section">
                  <h2>{section.label}</h2>
                  <For each={section.items}>
                    {(item) => (
                      <SettingsNavButton
                        icon={item.icon}
                        label={item.label}
                        page={item.page}
                        selected={page()}
                        setPage={setPage}
                      />
                    )}
                  </For>
                </section>
              )}
            </For>
            <Show when={visibleNavigation().length === 0}>
              <p class="settings-search-empty">{messages().noResults}</p>
            </Show>
          </nav>
        </aside>
        <div class="settings-main-frame">
          <main class="settings-main" id="settings-main-scroll" ref={settingsMainElement}>
            <div class="settings-main-content" ref={settingsMainContentElement}>
              <Switch>
                <Match when={page() === "general"}>
                  <GeneralSettings controller={props.controller} />
                </Match>
                <Match when={page() === "personalization"}>
                  <PersonalizationSettings
                    controller={props.controller}
                    developerInstructions={developerInstructions()}
                    setDeveloperInstructions={setDeveloperInstructions}
                  />
                </Match>
                <Match when={page() === "profile"}>
                  <ProfileSettings controller={props.controller} />
                </Match>
                <Match when={page() === "shortcuts"}>
                  <ShortcutsSettings />
                </Match>
                <Match when={page() === "usage"}>
                  <UsageSettings controller={props.controller} />
                </Match>
                <Match when={page() === "diagnostics"}>
                  <DiagnosticsSettings controller={props.controller} />
                </Match>
                <Match when={page() === "archived"}>
                  <ArchivedChatsSettings controller={props.controller} />
                </Match>
              </Switch>
            </div>
          </main>
          <SurfaceScrollbar
            className="settings-scrollbar"
            contentElement={() => settingsMainContentElement}
            controls="settings-main-scroll"
            label={messages().scrollArea}
            scrollElement={() => settingsMainElement}
          />
        </div>
      </section>
    </div>
  );
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function SettingsNavButton(props: {
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

function normalizeSearch(value: string, locale: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase(locale);
}

function SettingsHeading(props: { readonly title: string; readonly description: string }) {
  return (
    <header class="settings-heading">
      <h2>{props.title}</h2>
      <p>{props.description}</p>
    </header>
  );
}

function SettingsSection(props: {
  readonly allowOverflow?: boolean;
  readonly busy?: boolean;
  readonly children: JSX.Element;
  readonly description?: string;
  readonly title: string;
}) {
  return (
    <section class="settings-section">
      <h3>{props.title}</h3>
      <Show when={props.description}>
        <p class="settings-section-description">{props.description}</p>
      </Show>
      <div
        aria-busy={props.busy || undefined}
        class="settings-card"
        classList={{ "allow-overflow": props.allowOverflow }}
      >
        {props.children}
      </div>
    </section>
  );
}

function ApplicationPreferencesSettings(props: { readonly controller: SettingsDialogController }) {
  const i18n = useI18n();
  const messages = () => i18n.messages().settings;
  const desktopRuntime = isDesktopRuntime() || isBrowserPreview();
  const [preferences, setPreferences] = createSignal<ApplicationPreferences>(
    DEFAULT_APPLICATION_PREFERENCES,
  );
  const [loaded, setLoaded] = createSignal(false);
  const [loading, setLoading] = createSignal(desktopRuntime);
  const [saving, setSaving] = createSignal(false);
  const [operationError, setOperationError] = createSignal<string | null>(null);
  let confirmedPreferences = DEFAULT_APPLICATION_PREFERENCES as ApplicationPreferences;
  let saveQueue: Promise<void> = Promise.resolve();
  let saveRevision = 0;
  let active = true;

  onMount(() => {
    if (!desktopRuntime) {
      return;
    }
    void readApplicationPreferences()
      .then((storedPreferences) => {
        if (!active) return;
        confirmedPreferences = storedPreferences;
        setPreferences(storedPreferences);
        setLoaded(true);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setOperationError(describeError(reason));
        props.controller.reportError(reason);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
  });

  onCleanup(() => {
    active = false;
  });

  function save(patch: Partial<ApplicationPreferences>): void {
    if (!loaded()) {
      return;
    }

    const nextPreferences = mergeApplicationPreferences(preferences(), patch);
    const revision = saveRevision + 1;
    saveRevision = revision;
    setOperationError(null);
    setPreferences(nextPreferences);
    setSaving(true);

    const operation = saveQueue.then(() => updateApplicationPreferences(nextPreferences));
    saveQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    void operation
      .then((storedPreferences) => {
        confirmedPreferences = storedPreferences;
        if (active && revision === saveRevision) {
          setPreferences(storedPreferences);
          setOperationError(null);
        }
      })
      .catch((reason: unknown) => {
        if (!active || revision !== saveRevision) return;
        setPreferences(confirmedPreferences);
        setOperationError(describeError(reason));
        props.controller.reportError(reason);
      })
      .finally(() => {
        if (active && revision === saveRevision) setSaving(false);
      });
  }

  const controlsDisabled = () => !desktopRuntime || !loaded() || loading();
  const status = () => {
    if (!desktopRuntime) {
      return messages().desktopOnly;
    }
    if (loading()) {
      return messages().loadingAppPreferences;
    }
    return operationError() ?? "";
  };

  return (
    <>
      <SettingsSection
        busy={loading()}
        description={messages().applicationDescription}
        title={messages().application}
      >
        <PreferenceCheckbox
          checked={preferences().startWithWindows}
          description={messages().startWithWindowsDescription}
          disabled={controlsDisabled()}
          label={messages().startWithWindows}
          onChange={(startWithWindows) => save({ startWithWindows })}
        />
        <PreferenceCheckbox
          checked={preferences().startMinimized}
          description={messages().startMinimizedDescription}
          disabled={controlsDisabled() || !preferences().startWithWindows}
          label={messages().startMinimized}
          onChange={(startMinimized) => save({ startMinimized })}
        />
        <PreferenceCheckbox
          checked={preferences().closeToTray}
          description={messages().closeToTrayDescription}
          disabled={controlsDisabled()}
          label={messages().closeToTray}
          onChange={(closeToTray) => save({ closeToTray })}
        />
      </SettingsSection>
      <span aria-live="polite" class="visually-hidden">
        {saving() ? messages().savingAppPreferences : ""}
      </span>
      <Show when={status().length > 0}>
        <p
          aria-live="polite"
          class="application-preferences-status"
          classList={{ error: operationError() !== null }}
        >
          {status()}
        </p>
      </Show>
    </>
  );
}

function PreferenceCheckbox(props: {
  readonly checked: boolean;
  readonly description: string;
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label class="application-preference" classList={{ disabled: props.disabled }}>
      <span class="settings-checkbox-control">
        <input
          aria-label={props.label}
          checked={props.checked}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.currentTarget.checked)}
          type="checkbox"
        />
        <span aria-hidden="true" class="settings-checkbox-box">
          <Icon name="check" size={14} />
        </span>
      </span>
      <span class="application-preference-copy">
        <strong>{props.label}</strong>
        <small>{props.description}</small>
      </span>
    </label>
  );
}

function GeneralSettings(props: { readonly controller: SettingsDialogController }) {
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
              void props.controller.updateSetting({ type: "modelVerbosity", value })
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
                void props.controller.updateSetting({ type: "webSearch", value });
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

function LanguageSettings(props: { readonly controller: SettingsDialogController }) {
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

function PersonalizationSettings(props: {
  readonly controller: SettingsDialogController;
  readonly developerInstructions: string;
  readonly setDeveloperInstructions: (value: string) => void;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().settings;
  const personality = () => props.controller.config()?.config.personality ?? "pragmatic";
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
              void props.controller.updateSetting({ type: "personality", value });
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
          onInput={(event) => props.setDeveloperInstructions(event.currentTarget.value)}
          placeholder={messages().developerInstructionsPlaceholder}
          rows={9}
          value={props.developerInstructions}
        />
      </label>
      <div class="settings-actions">
        <button
          class="primary-button"
          onClick={() =>
            void props.controller.updateSetting({
              type: "developerInstructions",
              value: props.developerInstructions.trim() || null,
            })
          }
          type="button"
        >
          {messages().saveInstructions}
        </button>
      </div>
    </div>
  );
}

function ShortcutsSettings() {
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

function ShortcutRow(props: { readonly keys: readonly string[]; readonly label: string }) {
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

function UsageSettings(props: { readonly controller: SettingsDialogController }) {
  const i18n = useI18n();
  const messages = () => i18n.messages().settings;
  const rateLimits = () => props.controller.rateLimits();
  const snapshot = () => rateLimits()?.rateLimits;
  const autoTopUp = () => props.controller.autoTopUpSettings();
  const [autoTopUpEditing, setAutoTopUpEditing] = createSignal(false);
  const [rechargeThreshold, setRechargeThreshold] = createSignal(
    AUTO_TOP_UP_DEFAULT_RECHARGE_THRESHOLD,
  );
  const [rechargeTarget, setRechargeTarget] = createSignal(AUTO_TOP_UP_DEFAULT_RECHARGE_TARGET);
  const [rechargeMonthlyLimit, setRechargeMonthlyLimit] = createSignal("");
  const [confirmReset, setConfirmReset] = createSignal<{
    readonly key: string;
    readonly requestId: string;
  } | null>(null);
  const [resetSuccess, setResetSuccess] = createSignal<string | null>(null);

  onMount(() => {
    void Promise.all([
      props.controller.refreshRateLimitsIfStale(),
      props.controller.refreshUsageResets(),
      props.controller.refreshAutoTopUpSettings(),
    ]);
  });
  createEffect(() => {
    const settings = autoTopUp();
    if (settings === null || autoTopUpEditing()) {
      return;
    }
    setRechargeThreshold(settings.rechargeThreshold ?? AUTO_TOP_UP_DEFAULT_RECHARGE_THRESHOLD);
    setRechargeTarget(settings.rechargeTarget ?? AUTO_TOP_UP_DEFAULT_RECHARGE_TARGET);
    setRechargeMonthlyLimit(settings.rechargeMonthlyLimit ?? "");
  });

  const limitGroups = () => presentUsageLimits(rateLimits(), messages(), i18n.locale());
  const credits = () => snapshot()?.credits ?? null;
  const planPrice = () => rateLimits()?.planPrice ?? null;
  const spendControl = () => snapshot()?.individualLimit ?? null;
  const availableResetCredits = () =>
    props.controller.usageResets()?.credits.filter((credit) => credit.status === "available") ?? [];
  const resetRows = (): readonly (UsageResetCredit | null)[] => {
    const credits = availableResetCredits();
    if (credits.length > 0) {
      return credits;
    }
    return (props.controller.usageResets()?.availableCount ?? 0) > 0 ? [null] : [];
  };

  async function useReset(credit: UsageResetCredit | null): Promise<void> {
    const key = credit?.id ?? "automatic";
    const confirmation = confirmReset();
    if (confirmation?.key !== key) {
      setConfirmReset({ key, requestId: crypto.randomUUID() });
      setResetSuccess(null);
      return;
    }
    const response = await props.controller.redeemUsageReset(
      credit?.id ?? null,
      confirmation.requestId,
    );
    if (response?.code === "reset" || response?.code === "already_redeemed") {
      setConfirmReset(null);
      setResetSuccess(messages().resetSuccess);
    }
  }

  async function toggleAutoTopUp(): Promise<void> {
    const settings = autoTopUp();
    if (settings?.isEnabled) {
      if (await props.controller.disableAutoTopUp()) {
        setAutoTopUpEditing(false);
      }
      return;
    }
    await props.controller.enableAutoTopUp(
      rechargeThreshold(),
      rechargeTarget(),
      normalizedOptionalCreditValue(rechargeMonthlyLimit()),
    );
  }

  async function saveAutoTopUpSettings(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const settings = autoTopUp();
    const operation = settings?.isEnabled
      ? props.controller.updateAutoTopUp
      : props.controller.enableAutoTopUp;
    if (
      await operation(
        rechargeThreshold(),
        rechargeTarget(),
        normalizedOptionalCreditValue(rechargeMonthlyLimit()),
      )
    ) {
      setAutoTopUpEditing(false);
    }
  }

  return (
    <div class="settings-page">
      <SettingsHeading title={messages().usageBilling} description={messages().usageDescription} />
      <Show when={snapshot()}>
        {(current) => (
          <SettingsSection title={messages().yourPlan}>
            <div class="usage-plan">
              <span>
                <strong>{accountPlanLabel(current().planType, i18n.messages().account)}</strong>
                <small>
                  {planPriceLabel(planPrice(), i18n.locale(), messages()) ?? messages().currentPlan}
                </small>
              </span>
              <button
                class="usage-credits-button"
                onClick={() => void openExternalUrl("https://chatgpt.com/membership/plans")}
                type="button"
              >
                {messages().viewPlans}
              </button>
            </div>
          </SettingsSection>
        )}
      </Show>
      <Show when={credits() !== null || autoTopUp() !== null || props.controller.autoTopUpError()}>
        <SettingsSection
          description={messages().creditBalanceDescription}
          title={messages().creditBalance}
        >
          <Show when={credits()}>
            {(snap) => (
              <div class="usage-credits usage-credit-balance">
                <span>
                  <strong>{creditsLabel(snap(), messages())}</strong>
                  <small>{messages().balance}</small>
                </span>
                <button
                  class="usage-credits-button"
                  onClick={() => void openExternalUrl("https://chatgpt.com/settings/billing")}
                  type="button"
                >
                  {messages().buyCredits}
                </button>
              </div>
            )}
          </Show>
          <Show
            when={autoTopUp()}
            fallback={
              <div class="usage-auto-top-up-state">
                <span>
                  {props.controller.autoTopUpLoading()
                    ? messages().loadingAutoTopUp
                    : (props.controller.autoTopUpError() ?? messages().autoTopUpUnavailable)}
                </span>
                <Show when={!props.controller.autoTopUpLoading()}>
                  <button
                    class="usage-inline-action"
                    onClick={() => void props.controller.refreshAutoTopUpSettings()}
                    type="button"
                  >
                    {i18n.messages().common.tryAgain}
                  </button>
                </Show>
              </div>
            }
          >
            {(settings) => (
              <>
                <div class="usage-auto-top-up-row">
                  <span class="usage-auto-top-up-copy">
                    <strong>{messages().autoTopUp}</strong>
                    <small>{autoTopUpDescription(settings(), messages())}</small>
                  </span>
                  <span class="usage-auto-top-up-actions">
                    <Show when={settings().maximumDiscountPercent}>
                      {(discount) => (
                        <span class="usage-discount-badge">
                          {formatMessage(messages().discount, { percent: discount() })}
                        </span>
                      )}
                    </Show>
                    <Show when={settings().isEnabled}>
                      <button
                        class="usage-inline-action"
                        onClick={() => setAutoTopUpEditing((value) => !value)}
                        type="button"
                      >
                        {messages().manage}
                      </button>
                    </Show>
                    <button
                      aria-checked={settings().isEnabled}
                      aria-label={messages().toggleAutoTopUp}
                      class="usage-switch"
                      classList={{ checked: settings().isEnabled }}
                      disabled={props.controller.autoTopUpLoading()}
                      onClick={() => void toggleAutoTopUp()}
                      role="switch"
                      type="button"
                    >
                      <span />
                    </button>
                  </span>
                </div>
                <Show when={autoTopUpEditing()}>
                  <form class="usage-auto-top-up-editor" onSubmit={saveAutoTopUpSettings}>
                    <label>
                      <span>{messages().rechargeThreshold}</span>
                      <input
                        min="125"
                        onInput={(event) => setRechargeThreshold(event.currentTarget.value)}
                        required
                        step="1"
                        type="number"
                        value={rechargeThreshold()}
                      />
                    </label>
                    <label>
                      <span>{messages().rechargeTarget}</span>
                      <input
                        max="250000"
                        min="250"
                        onInput={(event) => setRechargeTarget(event.currentTarget.value)}
                        required
                        step="1"
                        type="number"
                        value={rechargeTarget()}
                      />
                    </label>
                    <label>
                      <span>{messages().optionalMonthlyLimit}</span>
                      <input
                        min="250"
                        onInput={(event) => setRechargeMonthlyLimit(event.currentTarget.value)}
                        placeholder={messages().noLimit}
                        step="1"
                        type="number"
                        value={rechargeMonthlyLimit()}
                      />
                    </label>
                    <div class="usage-auto-top-up-editor-actions">
                      <button
                        class="usage-inline-action"
                        onClick={() => setAutoTopUpEditing(false)}
                        type="button"
                      >
                        {i18n.messages().common.cancel}
                      </button>
                      <button
                        class="usage-credits-button"
                        disabled={props.controller.autoTopUpLoading()}
                        type="submit"
                      >
                        {props.controller.autoTopUpLoading() ? messages().saving : messages().save}
                      </button>
                    </div>
                  </form>
                </Show>
                <Show when={props.controller.autoTopUpError()}>
                  {(message) => <p class="usage-inline-error">{message()}</p>}
                </Show>
              </>
            )}
          </Show>
        </SettingsSection>
      </Show>
      <Show
        when={limitGroups().length > 0}
        fallback={
          <SettingsSection
            busy={props.controller.rateLimitsLoading()}
            title={messages().generalLimits}
          >
            <div
              aria-live="polite"
              class="usage-empty"
              classList={{ "usage-empty-error": props.controller.rateLimitsError() !== null }}
            >
              <span class="usage-empty-icon">
                <Icon
                  name={props.controller.rateLimitsError() === null ? "creditCard" : "helpCircle"}
                  size={18}
                />
              </span>
              <div>
                <strong>
                  {props.controller.rateLimitsLoading()
                    ? messages().usageDetailsLoading
                    : props.controller.rateLimitsError() === null
                      ? messages().usageDetailsUnavailable
                      : messages().usageDetailsFailure}
                </strong>
                <p>
                  {props.controller.rateLimitsLoading()
                    ? messages().usageDetailsWait
                    : (props.controller.rateLimitsError() ?? messages().usageDetailsRefresh)}
                </p>
              </div>
            </div>
          </SettingsSection>
        }
      >
        <For each={limitGroups()}>
          {(group) => (
            <SettingsSection
              busy={props.controller.rateLimitsLoading()}
              title={
                group.label === null
                  ? messages().generalLimits
                  : formatMessage(messages().namedLimits, { name: group.label })
              }
            >
              <section class="usage-limit-group">
                <For each={group.limits}>
                  {(limit) => (
                    <UsageMeter
                      limit={limit}
                      locale={i18n.locale()}
                      messages={messages()}
                      soonLabel={i18n.messages().common.soon}
                    />
                  )}
                </For>
              </section>
            </SettingsSection>
          )}
        </For>
      </Show>
      <Show when={spendControl()}>
        {(limit) => (
          <SettingsSection title={messages().spendLimit}>
            <SpendControlMeter
              limit={limit()}
              locale={i18n.locale()}
              messages={messages()}
              soonLabel={i18n.messages().common.soon}
            />
          </SettingsSection>
        )}
      </Show>
      <SettingsSection busy={props.controller.usageResetsLoading()} title={messages().usageResets}>
        <Show
          when={
            !props.controller.usageResetsLoading() ||
            props.controller.usageResets() !== null ||
            props.controller.usageResetsError() !== null
          }
          fallback={<div class="usage-reset-state">{messages().loadingResets}</div>}
        >
          <Show
            when={props.controller.usageResetsError() === null || resetRows().length > 0}
            fallback={
              <div class="usage-reset-state">
                <span>{props.controller.usageResetsError()}</span>
                <button
                  class="usage-inline-action"
                  onClick={() => void props.controller.refreshUsageResets()}
                  type="button"
                >
                  {i18n.messages().common.tryAgain}
                </button>
              </div>
            }
          >
            <Show
              when={resetRows().length > 0}
              fallback={<div class="usage-reset-state">{messages().noResets}</div>}
            >
              <For each={resetRows()}>
                {(credit) => {
                  const key = () => credit?.id ?? "automatic";
                  const confirming = () => confirmReset()?.key === key();
                  const resetting = () => props.controller.usageResetRedeemingId() === key();
                  return (
                    <div class="usage-reset-row">
                      <span>
                        <strong>{credit?.title?.trim() || messages().fullReset}</strong>
                        <Show when={credit?.expiresAt}>
                          {(expiration) => (
                            <small>
                              {formatMessage(messages().expires, {
                                date: formatShortDateWithTimeZone(
                                  expiration(),
                                  i18n.locale(),
                                  i18n.messages().common.soon,
                                ),
                              })}
                            </small>
                          )}
                        </Show>
                      </span>
                      <button
                        class="usage-reset-button"
                        disabled={props.controller.usageResetRedeemingId() !== null && !resetting()}
                        onClick={() => void useReset(credit)}
                        type="button"
                      >
                        {resetting()
                          ? messages().resetting
                          : confirming()
                            ? messages().confirm
                            : messages().useReset}
                      </button>
                    </div>
                  );
                }}
              </For>
            </Show>
          </Show>
        </Show>
        <Show when={resetSuccess()}>
          {(message) => <p class="usage-inline-success">{message()}</p>}
        </Show>
        <Show when={props.controller.usageResetsError() !== null && resetRows().length > 0}>
          <p class="usage-inline-error">{props.controller.usageResetsError()}</p>
        </Show>
        <Show when={props.controller.usageResets()?.immediateResetPurchaseEligible}>
          <button
            class="usage-inline-action usage-buy-reset"
            onClick={() => void openExternalUrl("https://chatgpt.com/settings/usage")}
            type="button"
          >
            {messages().buyInstantReset}
          </button>
        </Show>
      </SettingsSection>
    </div>
  );
}

function normalizedOptionalCreditValue(value: string): string | null {
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function planPriceLabel(
  price: NonNullable<ReturnType<SettingsDialogController["rateLimits"]>>["planPrice"],
  locale: string,
  messages: SettingsMessages,
): string | null {
  if (price === null) {
    return null;
  }
  const amount = price.amount / 10 ** price.minorUnitExponent;
  const formattedPrice = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: price.currency,
  }).format(amount);
  return formatMessage(messages.perMonth, { price: formattedPrice });
}

function autoTopUpDescription(
  settings: AutoTopUpSettingsSnapshot,
  messages: SettingsMessages,
): string {
  if (!settings.isEnabled) {
    return messages.autoTopUpDisabledDescription;
  }
  const threshold = settings.rechargeThreshold ?? "—";
  const target = settings.rechargeTarget ?? "—";
  const monthly =
    settings.rechargeMonthlyLimit === null
      ? ""
      : formatMessage(messages.autoTopUpMonthlyLimit, {
          limit: settings.rechargeMonthlyLimit,
        });
  return formatMessage(messages.autoTopUpEnabledDescription, { monthly, target, threshold });
}

function UsageMeter(props: {
  readonly limit: UsageLimitEntry;
  readonly locale: string;
  readonly messages: SettingsMessages;
  readonly soonLabel: string;
}) {
  const remaining = () => usagePercentLabel(props.limit.remainingPercent);
  const remainingLabel = () => formatMessage(props.messages.remaining, { value: remaining() });
  const resetLabel = () =>
    usageResetLabel(props.limit, props.locale, props.soonLabel, props.messages);
  return (
    <div class="usage-meter-row">
      <span class="usage-meter-copy">
        <strong>{props.limit.label}</strong>
        <Show when={resetLabel()}>{(label) => <small>{label()}</small>}</Show>
      </span>
      <div class="usage-meter-status">
        <progress
          aria-label={`${props.limit.label}: ${remainingLabel()}`}
          class="usage-meter usage-limit-meter"
          max={100}
          value={props.limit.remainingPercent}
        >
          {remaining()}
        </progress>
        <strong>{remainingLabel()}</strong>
      </div>
    </div>
  );
}

function usageResetLabel(
  limit: UsageLimitEntry,
  locale: string,
  soonLabel: string,
  messages: SettingsMessages,
): string | null {
  if (limit.resetAt === null) {
    return null;
  }
  if (limit.windowDurationMins !== null && limit.windowDurationMins < 24 * 60) {
    return formatMessage(messages.resetsAt, {
      date: formatShortDate(limit.resetAt, locale, soonLabel),
    });
  }
  return formatMessage(messages.resetAt, {
    date: formatShortDate(limit.resetAt, locale, soonLabel),
  });
}

function SpendControlMeter(props: {
  readonly limit: SpendControlLimitSnapshot;
  readonly locale: string;
  readonly messages: SettingsMessages;
  readonly soonLabel: string;
}) {
  const usedPercent = () => Math.max(0, Math.min(100, 100 - props.limit.remainingPercent));
  return (
    <div class="usage-meter-row">
      <span class="usage-meter-copy">
        <strong>{props.messages.spendLimit}</strong>
        <small>
          {formatMessage(props.messages.usedOf, {
            used: props.limit.used,
            limit: props.limit.limit,
          })}
          <i>
            {" · "}
            {formatMessage(props.messages.resetsAt, {
              date: formatShortDate(props.limit.resetsAt, props.locale, props.soonLabel),
            })}
          </i>
        </small>
      </span>
      <progress class="usage-meter" max={100} value={usedPercent()}>
        {usedPercent()}%
      </progress>
    </div>
  );
}

function creditsLabel(credits: CreditsSnapshot, messages: SettingsMessages): string {
  if (credits.unlimited) {
    return messages.unlimited;
  }
  return credits.balance ?? "—";
}

function ProfileSettings(props: { readonly controller: SettingsDialogController }) {
  const i18n = useI18n();
  const messages = () => i18n.messages().settings;
  return (
    <div class="settings-page profile-settings-page">
      <SettingsHeading title={messages().profile} description={messages().profileDescription} />
      <ProfileView controller={props.controller} mode="settings" />
    </div>
  );
}

function DiagnosticsSettings(props: { readonly controller: SettingsDialogController }) {
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

function ArchivedChatsSettings(props: { readonly controller: SettingsDialogController }) {
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

function OutputDetailSelect(props: {
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

function SettingsRow(props: {
  readonly children: JSX.Element;
  readonly description: string;
  readonly label: string;
}) {
  return (
    <div class="settings-row">
      <span>
        <strong>{props.label}</strong>
        <small>{props.description}</small>
      </span>
      <div>{props.children}</div>
    </div>
  );
}

function parseWebSearch(value: string): WebSearchMode | undefined {
  return value === "disabled" || value === "live" ? value : undefined;
}

function parsePersonality(value: string): Personality | undefined {
  return value === "friendly" || value === "none" || value === "pragmatic" ? value : undefined;
}
