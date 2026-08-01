import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  Show,
  Switch,
} from "solid-js";

import type {
  CodexModel,
  DesktopPreferences,
  ModelVerbosity,
  MotionPreference,
  PermissionProfile,
  Personality,
  ReasoningEffort,
  WebSearchMode,
} from "../contracts/types";
import type { AppController } from "../state/createAppController";
import { Icon, type IconName } from "./Icon";

type SettingsPage =
  | "account"
  | "appearance"
  | "diagnostics"
  | "general"
  | "personalization"
  | "security";

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
      { icon: "shield", label: "Permissões", page: "security" },
      { icon: "user", label: "Personalização", page: "personalization" },
      { icon: "panel", label: "Aparência", page: "appearance" },
      { icon: "user", label: "Conta", page: "account" },
    ],
  },
  {
    label: "Sistema",
    items: [{ icon: "terminal", label: "Diagnósticos", page: "diagnostics" }],
  },
];

export function SettingsDialog(props: {
  readonly controller: AppController;
  readonly onClose: () => void;
}) {
  const [page, setPage] = createSignal<SettingsPage>("general");
  const [query, setQuery] = createSignal("");
  const [developerInstructions, setDeveloperInstructions] = createSignal("");
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

  return (
    <div class="settings-overlay">
      <section
        aria-label="Configurações"
        aria-modal="true"
        class="settings-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            props.onClose();
          }
        }}
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
            <Match when={page() === "account"}>
              <AccountSettings controller={props.controller} />
            </Match>
            <Match when={page() === "diagnostics"}>
              <DiagnosticsSettings controller={props.controller} />
            </Match>
          </Switch>
        </main>
      </section>
    </div>
  );
}

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
      <Icon name={props.icon} size={16} /> {props.label}
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

function SettingsSection(props: { readonly children: JSX.Element; readonly title: string }) {
  return (
    <section class="settings-section">
      <h3>{props.title}</h3>
      <div class="settings-card">{props.children}</div>
    </section>
  );
}

function GeneralSettings(props: { readonly controller: AppController }) {
  const configuration = () => props.controller.config()?.config;
  const selectedModel = () =>
    props.controller.models().find((model) => model.id === configuration()?.model) ??
    props.controller.models().find((model) => model.isDefault);

  return (
    <div class="settings-page">
      <SettingsHeading title="Geral" description="Padrões usados ao iniciar cada novo turno." />
      <SettingsSection title="Modelo">
        <SettingsRow label="Modelo" description="Catálogo autorizado pela conta ChatGPT.">
          <select
            onChange={(event) => {
              const model = props.controller
                .models()
                .find((entry) => entry.id === event.currentTarget.value);
              if (model !== undefined) {
                saveModelDefaults(
                  props.controller,
                  model,
                  model.defaultReasoningEffort,
                  model.defaultServiceTier,
                );
              }
            }}
            value={configuration()?.model ?? selectedModel()?.id ?? ""}
          >
            <For each={props.controller.models()}>
              {(model) => <option value={model.id}>{model.displayName}</option>}
            </For>
          </select>
        </SettingsRow>
        <SettingsRow
          label="Raciocínio"
          description="Nível padrão; só aparecem opções anunciadas pelo modelo."
        >
          <select
            onChange={(event) => {
              const value = parseReasoningEffort(
                event.currentTarget.value,
                selectedModel()?.supportedReasoningEfforts.map(
                  (option) => option.reasoningEffort,
                ) ?? [],
              );
              const model = selectedModel();
              if (value !== undefined && model !== undefined) {
                saveModelDefaults(
                  props.controller,
                  model,
                  value,
                  configuration()?.serviceTier ?? model.defaultServiceTier,
                );
              }
            }}
            value={
              configuration()?.modelReasoningEffort ?? selectedModel()?.defaultReasoningEffort ?? ""
            }
          >
            <option value="">Padrão do modelo</option>
            <For each={selectedModel()?.supportedReasoningEfforts ?? []}>
              {(option) => (
                <option value={option.reasoningEffort}>
                  {effortLabel(option.reasoningEffort)}
                </option>
              )}
            </For>
          </select>
        </SettingsRow>
        <Show when={(selectedModel()?.serviceTiers.length ?? 0) > 0}>
          <SettingsRow label="Velocidade" description="Perfil de serviço anunciado pelo modelo.">
            <select
              onChange={(event) => {
                const model = selectedModel();
                if (model !== undefined) {
                  saveModelDefaults(
                    props.controller,
                    model,
                    configuration()?.modelReasoningEffort ?? model.defaultReasoningEffort,
                    event.currentTarget.value || null,
                  );
                }
              }}
              value={configuration()?.serviceTier ?? selectedModel()?.defaultServiceTier ?? ""}
            >
              <option value="">Padrão do modelo</option>
              <For each={selectedModel()?.serviceTiers ?? []}>
                {(tier) => <option value={tier.id}>{tier.name}</option>}
              </For>
            </select>
          </SettingsRow>
        </Show>
        <SettingsRow
          label="Verbosidade"
          description="Controla o tamanho das respostas quando o modelo suporta."
        >
          <select
            onChange={(event) => {
              const value = parseVerbosity(event.currentTarget.value);
              if (value !== undefined)
                void props.controller.updateSetting({ type: "modelVerbosity", value });
            }}
            value={configuration()?.modelVerbosity ?? ""}
          >
            <option value="">Automática</option>
            <option value="low">Baixa</option>
            <option value="medium">Média</option>
            <option value="high">Alta</option>
          </select>
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

function SecuritySettings(props: { readonly controller: AppController }) {
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
  readonly controller: AppController;
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

function AppearanceSettings(props: { readonly controller: AppController }) {
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

function AccountSettings(props: { readonly controller: AppController }) {
  const account = () => props.controller.account()?.account;
  const engine = () => props.controller.engine()?.engine;
  return (
    <div class="settings-page">
      <SettingsHeading title="Conta" description="Sessão ChatGPT e composição atual do engine." />
      <section class="account-settings-card">
        <span class="account-avatar large">
          {account()?.email?.slice(0, 1).toUpperCase() ?? "C"}
        </span>
        <div>
          <strong>{account()?.email ?? "Conta ChatGPT"}</strong>
          <small>Plano {account()?.planType ?? "não informado"}</small>
        </div>
        <button class="danger-button" onClick={() => void props.controller.logout()} type="button">
          <Icon name="logout" size={15} /> Sair
        </button>
      </section>
      <dl class="engine-facts">
        <div>
          <dt>Engine</dt>
          <dd>{engine()?.name ?? "—"}</dd>
        </div>
        <div>
          <dt>Provedor</dt>
          <dd>{engine()?.provider ?? "—"}</dd>
        </div>
        <div>
          <dt>Autenticação</dt>
          <dd>{engine()?.auth ?? "—"}</dd>
        </div>
        <div>
          <dt>Transporte</dt>
          <dd>{engine()?.transport ?? "—"}</dd>
        </div>
        <div>
          <dt>Armazenamento</dt>
          <dd>{engine()?.storage ?? "—"}</dd>
        </div>
      </dl>
    </div>
  );
}

function DiagnosticsSettings(props: { readonly controller: AppController }) {
  return (
    <div class="settings-page diagnostics-page">
      <SettingsHeading
        title="Diagnósticos"
        description="Somente eventos operacionalmente úteis desta sessão."
      />
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

function parseReasoningEffort(
  value: string,
  supported: readonly ReasoningEffort[],
): ReasoningEffort | null | undefined {
  if (value === "") return null;
  return supported.find((effort) => effort === value);
}

function saveModelDefaults(
  controller: AppController,
  model: CodexModel,
  reasoningEffort: ReasoningEffort | null,
  serviceTier: string | null,
): void {
  void controller.updateSetting({
    type: "modelDefaults",
    value: { model: model.id, reasoningEffort, serviceTier },
  });
}

function parseWebSearch(value: string): WebSearchMode | undefined {
  return value === "disabled" || value === "live" ? value : undefined;
}

function parseVerbosity(value: string): ModelVerbosity | null | undefined {
  if (value === "") return null;
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
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
