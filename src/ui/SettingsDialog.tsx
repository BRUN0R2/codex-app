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
  AccountPlanType,
  ApplicationPreferences,
  CreditsSnapshot,
  DesktopPreferences,
  ModelVerbosity,
  MotionPreference,
  PermissionProfile,
  Personality,
  SpendControlLimitSnapshot,
  WebSearchMode,
} from "../contracts/types";
import {
  describeError,
  openExternalUrl,
  readApplicationPreferences,
  updateApplicationPreferences,
} from "../infrastructure/codexClient";
import { isDesktopRuntime } from "../platform/DesktopRuntime";
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
  | "rateLimits"
  | "rateLimitsError"
  | "rateLimitsLoading"
  | "refreshRateLimits"
  | "refreshRateLimitsIfStale"
  | "reportError"
  | "unarchiveThread"
  | "updateSetting"
>;

import { AccountAvatar, accountDisplayName } from "./AccountAvatar";
import { formatShortDate } from "./dateFormat";
import { Icon, type IconName } from "./Icon";
import { OUTPUT_DETAIL_OPTIONS, outputDetailLabel } from "./outputDetail";
import { threadTitle } from "./Sidebar";
import { presentUsageLimits, type UsageLimitEntry, usagePercentLabel } from "./usagePresentation";

export type SettingsPage =
  | "appearance"
  | "archived"
  | "diagnostics"
  | "general"
  | "personalization"
  | "profile"
  | "security"
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
      { icon: "sun", label: "Aparência", page: "appearance" },
      { icon: "sparkles", label: "Personalização", page: "personalization" },
      { icon: "keyboard", label: "Atalhos de teclado", page: "shortcuts" },
      { icon: "creditCard", label: "Uso e faturamento", page: "usage" },
    ],
  },
  {
    label: "Sistema",
    items: [
      { icon: "shield", label: "Segurança e permissões", page: "security" },
      { icon: "bug", label: "Diagnósticos", page: "diagnostics" },
    ],
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
        <main class="settings-main">
          <Switch>
            <Match when={page() === "general"}>
              <GeneralSettings controller={props.controller} />
            </Match>
            <Match when={page() === "security"}>
              <SecuritySettings controller={props.controller} />
            </Match>
            <Match when={page() === "personalization"}>
              <PersonalizationSettings
                controller={props.controller}
                developerInstructions={developerInstructions()}
                setDeveloperInstructions={setDeveloperInstructions}
              />
            </Match>
            <Match when={page() === "appearance"}>
              <AppearanceSettings controller={props.controller} />
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
        </main>
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

const DEFAULT_APPLICATION_PREFERENCES = {
  schemaVersion: 1,
  startWithWindows: false,
  startMinimized: false,
  closeToTray: false,
} as const satisfies ApplicationPreferences;

function ApplicationPreferencesSettings(props: { readonly controller: SettingsDialogController }) {
  const desktopRuntime = isDesktopRuntime();
  const [preferences, setPreferences] = createSignal<ApplicationPreferences>(
    DEFAULT_APPLICATION_PREFERENCES,
  );
  const [loaded, setLoaded] = createSignal(false);
  const [loading, setLoading] = createSignal(desktopRuntime);
  const [saving, setSaving] = createSignal(false);
  const [operationError, setOperationError] = createSignal<string | null>(null);
  let confirmedPreferences = DEFAULT_APPLICATION_PREFERENCES as ApplicationPreferences;
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
    if (!loaded() || saving()) {
      return;
    }

    const merged = { ...preferences(), ...patch };
    const nextPreferences: ApplicationPreferences = merged.startWithWindows
      ? merged
      : { ...merged, startMinimized: false };
    const previousPreferences = confirmedPreferences;
    setOperationError(null);
    setPreferences(nextPreferences);
    setSaving(true);

    void updateApplicationPreferences(nextPreferences)
      .then((storedPreferences) => {
        confirmedPreferences = storedPreferences;
        if (active) setPreferences(storedPreferences);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setPreferences(previousPreferences);
        setOperationError(describeError(reason));
        props.controller.reportError(reason);
      })
      .finally(() => {
        if (active) setSaving(false);
      });
  }

  const controlsDisabled = () => !desktopRuntime || !loaded() || loading() || saving();
  const status = () => {
    if (!desktopRuntime) {
      return "Disponível apenas no aplicativo desktop.";
    }
    if (loading()) {
      return "Carregando preferências do aplicativo…";
    }
    if (saving()) {
      return "Salvando preferências do aplicativo…";
    }
    return operationError() ?? "";
  };

  return (
    <>
      <SettingsSection
        busy={loading() || saving()}
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
      <input
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <span class="application-preference-copy">
        <strong>{props.label}</strong>
        <small>{props.description}</small>
      </span>
    </label>
  );
}

function GeneralSettings(props: { readonly controller: SettingsDialogController }) {
  const configuration = () => props.controller.config()?.config;

  return (
    <div class="settings-page">
      <SettingsHeading
        title="Geral"
        description="Preferências do aplicativo e padrões usados ao iniciar novos turnos."
      />
      <ApplicationPreferencesSettings controller={props.controller} />
      <SettingsSection title="Modelo">
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

function SecuritySettings(props: { readonly controller: SettingsDialogController }) {
  const profile = () => props.controller.config()?.config.permissionProfile;
  return (
    <div class="settings-page">
      <SettingsHeading
        title="Permissões"
        description="Perfis fechados e previsíveis, aplicados pelo backend nativo."
      />
      <div class="permission-grid">
        <For each={props.controller.engine()?.permissionProfiles ?? []}>
          {(entry) => (
            <button
              class="permission-option"
              classList={{ selected: samePermission(entry, profile()) }}
              onClick={() =>
                void props.controller.updateSetting({ type: "permissionProfile", value: entry })
              }
              type="button"
            >
              <Icon name="shield" size={18} />
              <strong>{permissionName(entry)}</strong>
              <span>{permissionDescription(entry)}</span>
              <code>
                {entry.sandbox} · {entry.approvals}
              </code>
            </button>
          )}
        </For>
      </div>
      <div class="settings-note">
        Comandos pedem aprovação no perfil Projeto. Leitura e escrita continuam confinadas ao
        diretório selecionado.
      </div>
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

function AppearanceSettings(props: { readonly controller: SettingsDialogController }) {
  const desktop = () => props.controller.config()?.config.desktop;

  function save(patch: Partial<DesktopPreferences>): void {
    const current = desktop();
    if (current !== undefined) {
      void props.controller.updateSetting({ type: "desktop", value: { ...current, ...patch } });
    }
  }

  return (
    <div class="settings-page">
      <SettingsHeading
        title="Aparência"
        description="Preferências locais, aplicadas imediatamente."
      />
      <SettingsRow label="Tamanho da interface" description={`${desktop()?.uiFontSize ?? 15}px`}>
        <input
          max="24"
          min="12"
          onChange={(event) => {
            const value = Number(event.currentTarget.value);
            if (Number.isInteger(value) && value >= 12 && value <= 24) save({ uiFontSize: value });
          }}
          type="range"
          value={desktop()?.uiFontSize ?? 15}
        />
      </SettingsRow>
      <SettingsRow label="Movimento" description="Reduza transições e rolagem animada.">
        <select
          onChange={(event) => {
            const value = parseMotion(event.currentTarget.value);
            if (value !== undefined) save({ motion: value });
          }}
          value={desktop()?.motion ?? "full"}
        >
          <option value="full">Completo</option>
          <option value="reduced">Reduzido</option>
        </select>
      </SettingsRow>
      <SettingsRow
        label="Cursor em botões"
        description="Mostra cursor de ponteiro em controles interativos."
      >
        <input
          checked={desktop()?.pointerCursor ?? true}
          onChange={(event) => save({ pointerCursor: event.currentTarget.checked })}
          type="checkbox"
        />
      </SettingsRow>
      <SettingsRow
        label="Diferenças"
        description="Visualização padrão para alterações em arquivos."
      >
        <select
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === "split" || value === "unified") save({ diffDisplay: value });
          }}
          value={desktop()?.diffDisplay ?? "unified"}
        >
          <option value="unified">Unificada</option>
          <option value="split">Lado a lado</option>
        </select>
      </SettingsRow>
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
  onMount(() => {
    void props.controller.refreshRateLimitsIfStale();
  });
  const limitGroups = () => presentUsageLimits(rateLimits());
  const credits = () => snapshot()?.credits ?? null;
  const spendControl = () => snapshot()?.individualLimit ?? null;
  return (
    <div class="settings-page">
      <SettingsHeading
        title="Uso e cobrança"
        description="Consulte o plano, os créditos e todos os limites disponíveis para sua conta ChatGPT."
      />
      <Show when={snapshot()}>
        {(current) => (
          <SettingsSection title="Seu plano">
            <div class="usage-plan">
              <span>
                <strong>{planLabel(current().planType)}</strong>
                <small>Plano atual</small>
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
      <Show when={credits()}>
        {(snap) => (
          <SettingsSection
            description="Use créditos para continuar tarefas do Codex quando atingir um limite."
            title="Saldo de créditos"
          >
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
          </SettingsSection>
        )}
      </Show>
      <SettingsSection busy={props.controller.rateLimitsLoading()} title="Limites gerais de uso">
        <Show
          when={limitGroups().length > 0}
          fallback={
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
          }
        >
          <For each={limitGroups()}>
            {(group) => (
              <section class="usage-limit-group">
                <Show when={group.label}>{(label) => <h4>Limites de uso do {label()}</h4>}</Show>
                <For each={group.limits}>{(limit) => <UsageMeter limit={limit} />}</For>
              </section>
            )}
          </For>
        </Show>
      </SettingsSection>
      <Show when={spendControl()}>
        {(limit) => (
          <SettingsSection title="Limite de gastos">
            <SpendControlMeter limit={limit()} />
          </SettingsSection>
        )}
      </Show>
      <div class="usage-actions">
        <button
          class="usage-upgrade-button"
          onClick={() => void openExternalUrl("https://chatgpt.com/membership/plans")}
          type="button"
        >
          Fazer upgrade do plano
        </button>
        <Show when={credits() !== null}>
          <button
            class="usage-credits-button"
            onClick={() => void openExternalUrl("https://chatgpt.com/settings/billing")}
            type="button"
          >
            Adicionar créditos
          </button>
        </Show>
        <button
          class="usage-refresh-button"
          classList={{ refreshing: props.controller.rateLimitsLoading() }}
          disabled={props.controller.rateLimitsLoading()}
          onClick={() => void props.controller.refreshRateLimits()}
          type="button"
        >
          <Icon name="reset" size={13} />
          {props.controller.rateLimitsLoading() ? "Atualizando..." : "Atualizar"}
        </button>
      </div>
    </div>
  );
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

function planLabel(planType: AccountPlanType | null): string {
  switch (planType) {
    case "free":
      return "Plano grátis";
    case "go":
      return "Plano Go";
    case "plus":
      return "Plano Plus";
    case "pro":
      return "Plano Pro";
    case "prolite":
      return "Plano Pro Lite";
    case "team":
      return "Plano Team";
    case "business":
      return "Plano Business";
    case "edu":
      return "Plano Education";
    case "enterprise":
      return "Plano Enterprise";
    case "ent26":
      return "Plano Enterprise";
    case "enterprise_cbp_usage_based":
      return "Plano Enterprise com uso baseado em créditos";
    case "self_serve_business_prolite":
      return "Plano Business Pro Lite";
    case "self_serve_business_usage_based":
      return "Plano Business com uso baseado em créditos";
    case null:
      return "Plano ChatGPT";
  }
}

function ProfileSettings(props: { readonly controller: SettingsDialogController }) {
  const account = () => props.controller.account()?.account;
  return (
    <div class="settings-page">
      <SettingsHeading title="Perfil" description="Conta ChatGPT usada pelo Codex App." />
      <section class="account-settings-card">
        <AccountAvatar account={account()} large />
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

  function openAndFocusSelected(): void {
    setOpen(true);
    focusOption(selectedIndex());
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

  onMount(() => document.addEventListener("pointerdown", handleDocumentPointerDown));
  onCleanup(() => document.removeEventListener("pointerdown", handleDocumentPointerDown));

  return (
    <div class="output-detail-select" ref={rootElement}>
      <button
        aria-controls="output-detail-menu"
        aria-expanded={open()}
        aria-haspopup="menu"
        aria-label="Detalhamento da saída"
        class="output-detail-trigger"
        classList={{ open: open() }}
        disabled={props.disabled}
        onClick={() => setOpen((value) => !value)}
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

function parseMotion(value: string): MotionPreference | undefined {
  return value === "full" || value === "reduced" ? value : undefined;
}

function samePermission(left: PermissionProfile, right: PermissionProfile | undefined): boolean {
  return (
    right !== undefined && left.sandbox === right.sandbox && left.approvals === right.approvals
  );
}

function permissionName(profile: PermissionProfile): string {
  switch (profile.sandbox) {
    case "read-only":
      return "Somente leitura";
    case "workspace-write":
      return "Projeto";
    case "danger-full-access":
      return "Acesso completo";
  }
}

function permissionDescription(profile: PermissionProfile): string {
  switch (profile.sandbox) {
    case "read-only":
      return "Lê o projeto; bloqueia escrita e comandos.";
    case "workspace-write":
      return "Edita o projeto e pede aprovação para comandos.";
    case "danger-full-access":
      return "Executa comandos sem aprovação. Use conscientemente.";
  }
}
