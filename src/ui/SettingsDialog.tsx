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
import {
  describeError,
  openExternalUrl,
  readApplicationPreferences,
  updateApplicationPreferences,
} from "../infrastructure/codexClient";
import { isBrowserPreview, isDesktopRuntime } from "../platform/DesktopRuntime";
import type { AppController } from "../state/appController";

type SettingsDialogController = Pick<
  AppController,
  | "account"
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
  | "models"
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
  | "enableAutoTopUp"
  | "updateAutoTopUp"
  | "disableAutoTopUp"
  | "reportError"
  | "turnBusy"
  | "unarchiveThread"
  | "updateSetting"
>;

import { AccountAvatar, accountDisplayName } from "./AccountAvatar";
import { accountPlanLabel } from "./accountPresentation";
import {
  DEFAULT_APPLICATION_PREFERENCES,
  mergeApplicationPreferences,
} from "./applicationPreferences";
import { formatShortDate, formatShortDateWithTimeZone } from "./dateFormat";
import { Icon, type IconName } from "./Icon";
import {
  formatModelContextTokens,
  modelContextWindowPreference,
  modelSupportsMaximumContext,
} from "./modelContextWindow";
import { OUTPUT_DETAIL_OPTIONS, outputDetailLabel } from "./outputDetail";
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

const SETTINGS_NAVIGATION: readonly SettingsNavigationSection[] = [
  {
    label: "Pessoais",
    items: [
      { icon: "settings", label: "Geral", page: "general" },
      { icon: "user", label: "Perfil", page: "profile" },
      { icon: "sparkles", label: "Personalização", page: "personalization" },
      { icon: "keyboard", label: "Atalhos de teclado", page: "shortcuts" },
      { icon: "creditCard", label: "Uso e faturamento", page: "usage" },
    ],
  },
  {
    label: "Sistema",
    items: [{ icon: "bug", label: "Diagnósticos", page: "diagnostics" }],
  },
  {
    label: "Arquivadas",
    items: [{ icon: "archive", label: "Chats arquivados", page: "archived" }],
  },
];

export function SettingsDialog(props: {
  readonly controller: SettingsDialogController;
  readonly initialPage?: SettingsPage | undefined;
  readonly onClose: () => void;
}) {
  const [page, setPage] = createSignal<SettingsPage>(props.initialPage ?? "general");
  const [query, setQuery] = createSignal("");
  const [developerInstructions, setDeveloperInstructions] = createSignal("");
  let dialogElement: HTMLElement | undefined;
  let settingsMainContentElement: HTMLDivElement | undefined;
  let settingsMainElement: HTMLElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  let previouslyFocusedElement: HTMLElement | null = null;
  const visibleNavigation = createMemo(() => {
    const normalizedQuery = normalizeSearch(query());
    if (normalizedQuery.length === 0) {
      return SETTINGS_NAVIGATION;
    }
    return SETTINGS_NAVIGATION.map((section) => ({
      ...section,
      items: section.items.filter((item) => normalizeSearch(item.label).includes(normalizedQuery)),
    })).filter((section) => section.items.length > 0);
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
        aria-label="Configurações"
        aria-modal="true"
        class="settings-dialog"
        onKeyDown={handleDialogKeyDown}
        ref={dialogElement}
        role="dialog"
      >
        <aside class="settings-nav">
          <button class="settings-back" onClick={props.onClose} type="button">
            <Icon name="arrowLeft" size={15} />
            <span>Voltar ao aplicativo</span>
          </button>
          <label class="settings-search">
            <Icon name="search" size={14} />
            <input
              aria-label="Pesquisar configurações"
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder="Pesquisar configurações..."
              ref={searchInput}
              type="search"
              value={query()}
            />
          </label>
          <nav aria-label="Seções de configurações">
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
              <p class="settings-search-empty">Nenhuma configuração encontrada.</p>
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
            label="configurações"
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

function normalizeSearch(value: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR");
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
      return "Disponível apenas no aplicativo desktop.";
    }
    if (loading()) {
      return "Carregando preferências do aplicativo…";
    }
    return operationError() ?? "";
  };

  return (
    <>
      <SettingsSection
        busy={loading()}
        description="Escolha como o Codex App inicia e se comporta ao fechar a janela principal."
        title="Aplicativo"
      >
        <PreferenceCheckbox
          checked={preferences().startWithWindows}
          description="Abre o Codex App automaticamente ao entrar na sua conta do Windows."
          disabled={controlsDisabled()}
          label="Iniciar com o Windows"
          onChange={(startWithWindows) => save({ startWithWindows })}
        />
        <PreferenceCheckbox
          checked={preferences().startMinimized}
          description="Quando iniciado com o Windows, mantém o Codex App na bandeja do sistema."
          disabled={controlsDisabled() || !preferences().startWithWindows}
          label="Iniciar minimizado"
          onChange={(startMinimized) => save({ startMinimized })}
        />
        <PreferenceCheckbox
          checked={preferences().closeToTray}
          description="Mantém o Codex App em segundo plano quando a janela principal é fechada."
          disabled={controlsDisabled()}
          label="Ir para a bandeja ao fechar"
          onChange={(closeToTray) => save({ closeToTray })}
        />
      </SettingsSection>
      <span aria-live="polite" class="visually-hidden">
        {saving() ? "Salvando preferências do aplicativo." : ""}
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
  const configuration = () => props.controller.config()?.config;
  const expandedContextModels = createMemo(() =>
    props.controller
      .models()
      .filter((model) => !model.hidden && modelSupportsMaximumContext(model)),
  );

  return (
    <div class="settings-page">
      <SettingsHeading
        title="Geral"
        description="Preferências do aplicativo e padrões usados ao iniciar novos turnos."
      />
      <ApplicationPreferencesSettings controller={props.controller} />
      <SettingsSection allowOverflow title="Modelo">
        <SettingsRow
          label="Detalhamento da saída"
          description="Escolha o nível de detalhe que o Codex inclui nas respostas."
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
      <Show when={expandedContextModels().length > 0}>
        <SettingsSection
          title="Janela de contexto"
          description="As capacidades são carregadas do catálogo oficial do Codex para a sua conta."
        >
          <For each={expandedContextModels()}>
            {(model) => {
              const contextWindow = model.contextWindow;
              const maximumTokens = contextWindow?.maximumTokens ?? null;
              const preference = () =>
                modelContextWindowPreference(
                  configuration()?.modelContextWindowPreferences ?? {},
                  model.id,
                );
              return (
                <SettingsRow
                  label={model.displayName}
                  description={
                    contextWindow === null || maximumTokens === null
                      ? "O catálogo não anunciou uma janela configurável."
                      : `Padrão de ${formatModelContextTokens(contextWindow.tokens)}; máximo de ${formatModelContextTokens(maximumTokens)}. A opção máxima pode aumentar latência e uso de tokens.`
                  }
                >
                  <select
                    disabled={configuration() === undefined || props.controller.turnBusy()}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      if (value === "default" || value === "maximum") {
                        void props.controller.updateSetting({
                          type: "modelContextWindow",
                          model: model.id,
                          value,
                        });
                      }
                    }}
                    value={preference()}
                  >
                    <option value="default">
                      Padrão
                      {contextWindow === null
                        ? ""
                        : ` — ${formatModelContextTokens(contextWindow.tokens)}`}
                    </option>
                    <option value="maximum">
                      Máxima
                      {maximumTokens === null
                        ? ""
                        : ` — ${formatModelContextTokens(maximumTokens)}`}
                    </option>
                  </select>
                </SettingsRow>
              );
            }}
          </For>
          <div class="settings-note">
            A preferência é salva por modelo e aplicada a novos turnos. Se o catálogo mudar, o
            aplicativo usa automaticamente o novo limite anunciado.
          </div>
        </SettingsSection>
      </Show>
      <SettingsSection title="Ferramentas">
        <SettingsRow
          label="Pesquisa na web"
          description="Usa a ferramenta hospedada oficial quando habilitada."
        >
          <select
            onChange={(event) => {
              const value = parseWebSearch(event.currentTarget.value);
              if (value !== undefined)
                void props.controller.updateSetting({ type: "webSearch", value });
            }}
            value={configuration()?.webSearch ?? "disabled"}
          >
            <option value="disabled">Desativada</option>
            <option value="live">Internet ao vivo</option>
          </select>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}

function PersonalizationSettings(props: {
  readonly controller: SettingsDialogController;
  readonly developerInstructions: string;
  readonly setDeveloperInstructions: (value: string) => void;
}) {
  const personality = () => props.controller.config()?.config.personality ?? "pragmatic";
  return (
    <div class="settings-page">
      <SettingsHeading
        title="Personalização"
        description="Tom e instruções próprias acrescentadas ao contrato do modelo."
      />
      <SettingsRow
        label="Personalidade"
        description="Estilo de comunicação, sem alterar regras de segurança."
      >
        <select
          onChange={(event) => {
            const value = parsePersonality(event.currentTarget.value);
            if (value !== undefined)
              void props.controller.updateSetting({ type: "personality", value });
          }}
          value={personality()}
        >
          <option value="pragmatic">Pragmática</option>
          <option value="friendly">Amigável</option>
          <option value="none">Sem estilo adicional</option>
        </select>
      </SettingsRow>
      <label class="settings-textarea-row">
        <span>
          <strong>Instruções do desenvolvedor</strong>
          <small>Até 256 KiB, armazenadas localmente no SQLite do app.</small>
        </span>
        <textarea
          maxlength={262_144}
          onInput={(event) => props.setDeveloperInstructions(event.currentTarget.value)}
          placeholder="Ex.: prefira APIs pequenas e explique decisões arquiteturais importantes."
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
          Salvar instruções
        </button>
      </div>
    </div>
  );
}

function ShortcutsSettings() {
  return (
    <div class="settings-page">
      <SettingsHeading
        title="Atalhos de teclado"
        description="Atalhos disponíveis no aplicativo de desktop."
      />
      <SettingsSection title="Geral">
        <ShortcutRow keys={["Ctrl", "N"]} label="Novo chat" />
        <ShortcutRow keys={["Ctrl", "K"]} label="Pesquisar na barra lateral" />
        <ShortcutRow keys={["Ctrl", ","]} label="Abrir configurações" />
        <ShortcutRow keys={["Ctrl", "B"]} label="Alternar barra lateral" />
        <ShortcutRow keys={["Ctrl", "R"]} label="Recarregar a janela" />
      </SettingsSection>
      <SettingsSection title="Conversa">
        <ShortcutRow keys={["Enter"]} label="Enviar mensagem" />
        <ShortcutRow keys={["Shift", "Enter"]} label="Inserir nova linha" />
        <ShortcutRow keys={["Esc"]} label="Fechar menus e diálogos" />
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
  const rateLimits = () => props.controller.rateLimits();
  const snapshot = () => rateLimits()?.rateLimits;
  const autoTopUp = () => props.controller.autoTopUpSettings();
  const [autoTopUpEditing, setAutoTopUpEditing] = createSignal(false);
  const [rechargeThreshold, setRechargeThreshold] = createSignal("125");
  const [rechargeTarget, setRechargeTarget] = createSignal("250");
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
    setRechargeThreshold(settings.rechargeThreshold ?? "125");
    setRechargeTarget(settings.rechargeTarget ?? "250");
    setRechargeMonthlyLimit(settings.rechargeMonthlyLimit ?? "");
  });

  const limitGroups = () => presentUsageLimits(rateLimits());
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
      setResetSuccess("Limites de uso redefinidos.");
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
      <SettingsHeading
        title="Uso e faturamento"
        description="Consulte seu plano, créditos, limites de uso e redefinições disponíveis para a conta."
      />
      <Show when={snapshot()}>
        {(current) => (
          <SettingsSection title="Seu plano">
            <div class="usage-plan">
              <span>
                <strong>{accountPlanLabel(current().planType)}</strong>
                <small>{planPriceLabel(planPrice()) ?? "Seu plano atual do ChatGPT"}</small>
              </span>
              <button
                class="usage-credits-button"
                onClick={() => void openExternalUrl("https://chatgpt.com/membership/plans")}
                type="button"
              >
                Ver planos
              </button>
            </div>
          </SettingsSection>
        )}
      </Show>
      <Show when={credits() !== null || autoTopUp() !== null || props.controller.autoTopUpError()}>
        <SettingsSection
          description="Compre créditos ou ative a recarga automática para continuar usando o Codex ao atingir um limite."
          title="Saldo de créditos"
        >
          <Show when={credits()}>
            {(snap) => (
              <div class="usage-credits usage-credit-balance">
                <span>
                  <strong>{creditsLabel(snap())}</strong>
                  <small>Saldo atual</small>
                </span>
                <button
                  class="usage-credits-button"
                  onClick={() => void openExternalUrl("https://chatgpt.com/settings/billing")}
                  type="button"
                >
                  Comprar créditos
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
                    ? "Consultando recarga automática..."
                    : (props.controller.autoTopUpError() ?? "Recarga automática indisponível.")}
                </span>
                <Show when={!props.controller.autoTopUpLoading()}>
                  <button
                    class="usage-inline-action"
                    onClick={() => void props.controller.refreshAutoTopUpSettings()}
                    type="button"
                  >
                    Tentar novamente
                  </button>
                </Show>
              </div>
            }
          >
            {(settings) => (
              <>
                <div class="usage-auto-top-up-row">
                  <span class="usage-auto-top-up-copy">
                    <strong>Recarga automática</strong>
                    <small>{autoTopUpDescription(settings())}</small>
                  </span>
                  <span class="usage-auto-top-up-actions">
                    <Show when={settings().maximumDiscountPercent}>
                      {(discount) => (
                        <span class="usage-discount-badge">Até {discount()}% de desconto</span>
                      )}
                    </Show>
                    <Show when={settings().isEnabled}>
                      <button
                        class="usage-inline-action"
                        onClick={() => setAutoTopUpEditing((value) => !value)}
                        type="button"
                      >
                        Gerenciar
                      </button>
                    </Show>
                    <button
                      aria-checked={settings().isEnabled}
                      aria-label="Alternar recarga automática"
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
                      <span>Recarregar quando o saldo chegar a</span>
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
                      <span>Recarregar o saldo até</span>
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
                      <span>Limite mensal opcional</span>
                      <input
                        min="250"
                        onInput={(event) => setRechargeMonthlyLimit(event.currentTarget.value)}
                        placeholder="Sem limite definido"
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
                        Cancelar
                      </button>
                      <button
                        class="usage-credits-button"
                        disabled={props.controller.autoTopUpLoading()}
                        type="submit"
                      >
                        {props.controller.autoTopUpLoading() ? "Salvando..." : "Salvar"}
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
            title="Limites gerais de uso"
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
                    ? "Consultando detalhes de uso"
                    : props.controller.rateLimitsError() === null
                      ? "Detalhes de uso indisponíveis"
                      : "Não foi possível consultar o uso"}
                </strong>
                <p>
                  {props.controller.rateLimitsLoading()
                    ? "Aguarde enquanto os limites da conta são atualizados."
                    : (props.controller.rateLimitsError() ??
                      "Atualize para consultar os limites da sua conta.")}
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
                group.label === null ? "Limites gerais de uso" : `Limites de uso do ${group.label}`
              }
            >
              <section class="usage-limit-group">
                <For each={group.limits}>{(limit) => <UsageMeter limit={limit} />}</For>
              </section>
            </SettingsSection>
          )}
        </For>
      </Show>
      <Show when={spendControl()}>
        {(limit) => (
          <SettingsSection title="Limite de gastos">
            <SpendControlMeter limit={limit()} />
          </SettingsSection>
        )}
      </Show>
      <SettingsSection
        busy={props.controller.usageResetsLoading()}
        title="Redefinições do limite de uso"
      >
        <Show
          when={
            !props.controller.usageResetsLoading() ||
            props.controller.usageResets() !== null ||
            props.controller.usageResetsError() !== null
          }
          fallback={<div class="usage-reset-state">Consultando redefinições disponíveis...</div>}
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
                  Tentar novamente
                </button>
              </div>
            }
          >
            <Show
              when={resetRows().length > 0}
              fallback={<div class="usage-reset-state">Nenhuma redefinição disponível.</div>}
            >
              <For each={resetRows()}>
                {(credit) => {
                  const key = () => credit?.id ?? "automatic";
                  const confirming = () => confirmReset()?.key === key();
                  const resetting = () => props.controller.usageResetRedeemingId() === key();
                  return (
                    <div class="usage-reset-row">
                      <span>
                        <strong>{credit?.title?.trim() || "Redefinição completa"}</strong>
                        <Show when={credit?.expiresAt}>
                          {(expiration) => (
                            <small>Expira em {formatShortDateWithTimeZone(expiration())}</small>
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
                          ? "Redefinindo..."
                          : confirming()
                            ? "Confirmar"
                            : "Usar redefinição"}
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
            Comprar redefinição instantânea
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
): string | null {
  if (price === null) {
    return null;
  }
  const amount = price.amount / 10 ** price.minorUnitExponent;
  return `${new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: price.currency,
  }).format(amount)}/mês`;
}

function autoTopUpDescription(settings: AutoTopUpSettingsSnapshot): string {
  if (!settings.isEnabled) {
    return "Continue trabalhando quando o saldo de créditos atingir o limite configurado.";
  }
  const threshold = settings.rechargeThreshold ?? "—";
  const target = settings.rechargeTarget ?? "—";
  const monthly =
    settings.rechargeMonthlyLimit === null
      ? ""
      : ` Limite mensal: ${settings.rechargeMonthlyLimit} créditos.`;
  return `Recarrega para ${target} créditos quando o saldo chegar a ${threshold}.${monthly}`;
}

function UsageMeter(props: { readonly limit: UsageLimitEntry }) {
  const remaining = () => usagePercentLabel(props.limit.remainingPercent);
  const resetLabel = () => usageResetLabel(props.limit);
  return (
    <div class="usage-meter-row">
      <span class="usage-meter-copy">
        <strong>{props.limit.label}</strong>
        <Show when={resetLabel()}>{(label) => <small>{label()}</small>}</Show>
      </span>
      <div class="usage-meter-status">
        <progress
          aria-label={`${props.limit.label}: ${remaining()} restante`}
          class="usage-meter usage-limit-meter"
          max={100}
          value={props.limit.remainingPercent}
        >
          {remaining()}
        </progress>
        <strong>{remaining()} restante</strong>
      </div>
    </div>
  );
}

function usageResetLabel(limit: UsageLimitEntry): string | null {
  if (limit.resetAt === null) {
    return null;
  }
  if (limit.windowDurationMins !== null && limit.windowDurationMins < 24 * 60) {
    return `Redefine em ${formatShortDate(limit.resetAt)}`;
  }
  return `Redefinição ${formatShortDate(limit.resetAt)}`;
}

function SpendControlMeter(props: { readonly limit: SpendControlLimitSnapshot }) {
  const usedPercent = () => Math.max(0, Math.min(100, 100 - props.limit.remainingPercent));
  return (
    <div class="usage-meter-row">
      <span class="usage-meter-copy">
        <strong>Limite de gastos</strong>
        <small>
          {props.limit.used} de {props.limit.limit}
          <i> · Redefine em {formatShortDate(props.limit.resetsAt)}</i>
        </small>
      </span>
      <progress class="usage-meter" max={100} value={usedPercent()}>
        {usedPercent()}%
      </progress>
    </div>
  );
}

function creditsLabel(credits: CreditsSnapshot): string {
  if (credits.unlimited) {
    return "Ilimitado";
  }
  return credits.balance ?? "—";
}

function ProfileSettings(props: { readonly controller: SettingsDialogController }) {
  const account = () => props.controller.account()?.account;
  return (
    <div class="settings-page">
      <SettingsHeading title="Perfil" description="Conta ChatGPT usada pelo Codex App." />
      <section class="account-settings-card">
        <AccountAvatar account={account()} size="settings" />
        <div>
          <strong>{accountDisplayName(account())}</strong>
          <Show when={account()?.email}>{(email) => <small>{email()}</small>}</Show>
          <small>Plano {account()?.planType ?? "não informado"}</small>
        </div>
        <button class="danger-button" onClick={() => void props.controller.logout()} type="button">
          <Icon name="logout" size={15} /> Sair
        </button>
      </section>
    </div>
  );
}

function DiagnosticsSettings(props: { readonly controller: SettingsDialogController }) {
  return (
    <div class="settings-page diagnostics-page">
      <SettingsHeading
        title="Diagnósticos"
        description="Falhas operacionais ficam visíveis nesta sessão e persistidas em disco."
      />
      <Show when={props.controller.engine()?.diagnosticLogPath}>
        {(path) => (
          <section class="diagnostics-log-location">
            <strong>Arquivo de log</strong>
            <code>{path()}</code>
          </section>
        )}
      </Show>
      <Show
        when={props.controller.diagnostics().length > 0}
        fallback={<p class="diagnostics-empty">Nenhum diagnóstico registrado.</p>}
      >
        <ol class="diagnostics-list">
          <For each={[...props.controller.diagnostics()].reverse()}>
            {(entry) => (
              <li>
                <time>{entry.occurredAt.toLocaleTimeString("pt-BR")}</time>
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
  onMount(() => {
    if (!props.controller.archivedThreadsLoaded()) {
      void props.controller.loadMoreArchivedThreads();
    }
  });

  return (
    <div class="settings-page">
      <SettingsHeading
        title="Chats arquivados"
        description="Conversas arquivadas da barra lateral. Restaure para voltar à lista ou exclua permanentemente."
      />
      <SettingsSection busy={props.controller.archivedThreadsLoading()} title="Arquivadas">
        <Show
          when={props.controller.archivedThreadsLoaded()}
          fallback={
            <div class="archived-chats-status">
              <p class="archived-chats-empty">
                {props.controller.archivedThreadsLoading()
                  ? "Carregando chats arquivados..."
                  : "Não foi possível carregar os chats arquivados."}
              </p>
              <Show when={!props.controller.archivedThreadsLoading()}>
                <button
                  class="load-more-button"
                  onClick={() => void props.controller.loadMoreArchivedThreads()}
                  type="button"
                >
                  Tentar novamente
                </button>
              </Show>
            </div>
          }
        >
          <Show
            when={props.controller.archivedThreads().length > 0}
            fallback={<p class="archived-chats-empty">Nenhum chat arquivado.</p>}
          >
            <For each={props.controller.archivedThreads()}>
              {(thread) => (
                <div class="settings-row archived-chat-row">
                  <span>
                    <strong>{threadTitle(thread)}</strong>
                    <small>{thread.projectPath ?? "Sem projeto"}</small>
                  </span>
                  <div class="archived-chat-actions">
                    <button
                      aria-label={`Restaurar ${threadTitle(thread)}`}
                      onClick={() => void props.controller.unarchiveThread(thread.id)}
                      title="Restaurar para a barra lateral"
                      type="button"
                    >
                      <Icon name="reset" size={14} /> Restaurar
                    </button>
                    <button
                      aria-label={`Excluir ${threadTitle(thread)}`}
                      class="archived-chat-delete"
                      onClick={() => void props.controller.deleteThread(thread.id)}
                      title="Excluir permanentemente"
                      type="button"
                    >
                      <Icon name="close" size={14} /> Excluir
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
            Carregar mais
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
  const [open, setOpen] = createSignal(false);
  const [openAbove, setOpenAbove] = createSignal(false);
  let rootElement: HTMLDivElement | undefined;
  let triggerElement: HTMLButtonElement | undefined;
  const optionElements: Array<HTMLButtonElement | undefined> = [];

  const selectedIndex = () => {
    const index = OUTPUT_DETAIL_OPTIONS.findIndex((option) => option.value === props.value);
    return index < 0 ? 0 : index;
  };

  function focusOption(index: number): void {
    const optionCount = OUTPUT_DETAIL_OPTIONS.length;
    const normalizedIndex = (index + optionCount) % optionCount;
    queueMicrotask(() => optionElements[normalizedIndex]?.focus());
  }

  function shouldOpenAbove(): boolean {
    const bounds = triggerElement?.getBoundingClientRect();
    if (bounds === undefined) {
      return false;
    }
    const estimatedMenuHeight = 224;
    const availableBelow = window.innerHeight - bounds.bottom;
    return availableBelow < estimatedMenuHeight && bounds.top > availableBelow;
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
        focusOption(OUTPUT_DETAIL_OPTIONS.length - 1);
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
        aria-label="Detalhamento da saída"
        class="output-detail-trigger"
        classList={{ open: open() }}
        disabled={props.disabled}
        onClick={toggleMenu}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerElement}
        type="button"
      >
        <span>{outputDetailLabel(props.value)}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      <Show when={open()}>
        <div
          aria-label="Detalhamento da saída"
          class="output-detail-menu"
          id="output-detail-menu"
          role="menu"
        >
          <For each={OUTPUT_DETAIL_OPTIONS}>
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
