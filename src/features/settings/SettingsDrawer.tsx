import {
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  onMount,
} from "solid-js";

import {
  configString,
  configuredModel,
  configuredReasoningEffort,
  reasoningEfforts,
  reasoningLabel,
} from "../../shared/codex/models";
import type { JsonValue } from "../../shared/codex/types";
import {
  ChevronLeftIcon,
  RefreshIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  SparkIcon,
} from "../../shared/components/Icons";
import type { CodexSession } from "../session/createCodexSession";

interface SettingsDrawerProps {
  session: CodexSession;
  onClose: () => void;
}

type SettingsPage = "general" | "account" | "advanced";

interface SelectOption {
  label: string;
  value: string;
}

interface SettingsSelectProps {
  description: string;
  disabled: boolean;
  label: string;
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
}

export function SettingsDrawer(props: SettingsDrawerProps) {
  const [page, setPage] = createSignal<SettingsPage>("general");
  const [query, setQuery] = createSignal("");
  const [keyPath, setKeyPath] = createSignal("");
  const [value, setValue] = createSignal("true");
  const [mergeStrategy, setMergeStrategy] = createSignal<"replace" | "upsert">("replace");
  const [savingKey, setSavingKey] = createSignal<string | null>(null);
  const [formError, setFormError] = createSignal<string | null>(null);
  const configJson = createMemo(() =>
    JSON.stringify(props.session.config()?.config ?? {}, null, 2),
  );
  const model = createMemo(() =>
    configuredModel(props.session.config(), props.session.models()),
  );
  const effort = createMemo(() =>
    configuredReasoningEffort(props.session.config(), model()),
  );
  const accountLabel = createMemo(() => {
    const account = props.session.account()?.account;
    if (account === null || account === undefined) {
      return "Provedor local";
    }
    if ("email" in account && typeof account.email === "string") {
      return account.email;
    }
    return account.type === "apiKey" ? "Chave da API" : account.type;
  });
  const matchesQuery = (label: string) =>
    label.toLocaleLowerCase("pt-BR").includes(query().trim().toLocaleLowerCase("pt-BR"));

  onMount(() => {
    void props.session.loadCompatibilityContext().catch((reason) => {
      setFormError(describeError(reason));
    });
  });

  function updateQuery(nextQuery: string) {
    setQuery(nextQuery);
    const normalized = nextQuery.trim().toLocaleLowerCase("pt-BR");
    if (normalized.length === 0) {
      return;
    }
    const matches = [
      { label: "Geral", page: "general" as const },
      { label: "Conta e runtime", page: "account" as const },
      { label: "Configuração avançada", page: "advanced" as const },
    ].filter(({ label }) => label.toLocaleLowerCase("pt-BR").includes(normalized));
    if (matches.length === 1 && matches[0] !== undefined) {
      setPage(matches[0].page);
    }
  }

  async function saveSetting(key: string, nextValue: JsonValue) {
    setSavingKey(key);
    setFormError(null);
    try {
      await props.session.writeSetting(key, nextValue, "replace");
    } catch (reason) {
      setFormError(describeError(reason));
    } finally {
      setSavingKey(null);
    }
  }

  async function saveAdvanced() {
    const path = keyPath().trim();
    if (path.length === 0) {
      setFormError("Informe o caminho da configuração.");
      return;
    }
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(value()) as JsonValue;
    } catch {
      setFormError("O valor precisa ser JSON válido, como true, 42, \"texto\" ou {...}.");
      return;
    }

    setSavingKey(path);
    setFormError(null);
    try {
      await props.session.writeSetting(path, parsed, mergeStrategy());
    } catch (reason) {
      setFormError(describeError(reason));
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <section
      aria-label="Configurações"
      aria-modal="true"
      class="settings-screen"
      role="dialog"
    >
      <aside class="settings-sidebar">
        <button class="settings-back" onClick={props.onClose} type="button">
          <ChevronLeftIcon size={16} />
          Voltar ao aplicativo
        </button>
        <label class="settings-search">
          <SearchIcon size={15} />
          <input
            aria-label="Pesquisar configurações"
            onInput={(event) => updateQuery(event.currentTarget.value)}
            placeholder="Pesquisar configurações…"
            type="search"
            value={query()}
          />
        </label>
        <span class="settings-nav-section">Pessoais</span>
        <nav aria-label="Seções das configurações" class="settings-nav">
          <Show when={matchesQuery("Geral")}>
            <button
              classList={{ active: page() === "general" }}
              onClick={() => setPage("general")}
              type="button"
            >
              <SparkIcon size={16} />
              Geral
            </button>
          </Show>
          <Show when={matchesQuery("Conta e runtime")}>
            <button
              classList={{ active: page() === "account" }}
              onClick={() => setPage("account")}
              type="button"
            >
              <ShieldIcon size={16} />
              Conta
            </button>
          </Show>
          <Show when={matchesQuery("Configuração avançada")}>
            <button
              classList={{ active: page() === "advanced" }}
              onClick={() => setPage("advanced")}
              type="button"
            >
              <SettingsIcon size={16} />
              Configuração
            </button>
          </Show>
        </nav>
      </aside>

      <main class="settings-content">
            <Switch>
              <Match when={page() === "general"}>
                <div class="settings-page-heading">
                  <h3>Geral</h3>
                  <p>Modelo, raciocínio e limites de execução das próximas tarefas.</p>
                </div>

                <div class="settings-group">
                  <SettingsSelect
                    description="Modelo padrão usado em novas tarefas."
                    disabled={savingKey() !== null}
                    label="Modelo"
                    onChange={(next) => void saveSetting("model", next)}
                    options={props.session.models().map((candidate) => ({
                      label: candidate.displayName,
                      value: candidate.model,
                    }))}
                    value={model()?.model ?? ""}
                  />
                  <SettingsSelect
                    description="Quanto tempo o modelo pode dedicar ao raciocínio."
                    disabled={savingKey() !== null}
                    label="Esforço de raciocínio"
                    onChange={(next) => void saveSetting("model_reasoning_effort", next)}
                    options={reasoningEfforts(model()).map((option) => ({
                      label: reasoningLabel(option.reasoningEffort),
                      value: option.reasoningEffort,
                    }))}
                    value={effort()}
                  />
                </div>

                <h4 class="settings-section-heading">Permissões</h4>
                <div class="settings-group">
                  <SettingsSelect
                    description="Controla quais arquivos e recursos o Codex pode acessar."
                    disabled={savingKey() !== null}
                    label="Permissões"
                    onChange={(next) => void saveSetting("sandbox_mode", next)}
                    options={[
                      { label: "Somente leitura", value: "read-only" },
                      { label: "Permissões padrão", value: "workspace-write" },
                      { label: "Acesso completo", value: "danger-full-access" },
                    ]}
                    value={configString(props.session.config(), "sandbox_mode") ?? "workspace-write"}
                  />
                  <SettingsSelect
                    description="Define quando o Codex precisa pedir sua confirmação."
                    disabled={savingKey() !== null}
                    label="Confirmações"
                    onChange={(next) => void saveSetting("approval_policy", next)}
                    options={[
                      { label: "Apenas ações desconhecidas", value: "untrusted" },
                      { label: "Quando necessário", value: "on-request" },
                      { label: "Não solicitar", value: "never" },
                    ]}
                    value={configString(props.session.config(), "approval_policy") ?? "on-request"}
                  />
                </div>

                <h4 class="settings-section-heading">Ferramentas</h4>
                <div class="settings-group">
                  <SettingsSelect
                    description="Seleciona a estratégia oficial de pesquisa na web."
                    disabled={savingKey() !== null}
                    label="Pesquisa na web"
                    onChange={(next) => void saveSetting("web_search", next)}
                    options={[
                      { label: "Desativada", value: "disabled" },
                      { label: "Cache", value: "cached" },
                      { label: "Índice", value: "indexed" },
                      { label: "Ao vivo", value: "live" },
                    ]}
                    value={configString(props.session.config(), "web_search") ?? "cached"}
                  />
                </div>

                <p class="settings-note">
                  As alterações são validadas e persistidas pelo próprio Codex. Uma
                  tarefa já iniciada pode manter as opções anteriores.
                </p>
              </Match>

              <Match when={page() === "account"}>
                <div class="settings-page-heading">
                  <h3>Conta e runtime</h3>
                  <p>Sessão ChatGPT, engine nativo e ponte de compatibilidade.</p>
                </div>

                <div class="account-card">
                  <div class="account-avatar">{accountLabel().slice(0, 1).toUpperCase()}</div>
                  <div>
                    <strong>{accountLabel()}</strong>
                    <span>{accountPlan(props.session)}</span>
                  </div>
                  <button
                    class="secondary-button compact-button"
                    onClick={() => void props.session.logout()}
                    type="button"
                  >
                    Sair
                  </button>
                </div>

                <dl class="settings-facts">
                  <div>
                    <dt>Engine</dt>
                    <dd>{props.session.runtime()?.engine.name ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Provider</dt>
                    <dd>{props.session.runtime()?.engine.provider ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Ponte de compatibilidade</dt>
                    <dd>
                      {compatibilityLabel(props.session)}
                    </dd>
                  </div>
                  <div>
                    <dt>Estado</dt>
                    <dd>{props.session.runtimeStatus().state}</dd>
                  </div>
                  <div>
                    <dt>Executável</dt>
                    <dd title={props.session.runtime()?.executable ?? undefined}>
                      {props.session.runtime()?.executable ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Modelos disponíveis</dt>
                    <dd>{props.session.models().length}</dd>
                  </div>
                </dl>

                <Show when={props.session.diagnostics().length > 0}>
                  <div class="diagnostic-block">
                    <h4>Diagnósticos recentes</h4>
                    <pre class="diagnostics">
                      {props.session
                        .diagnostics()
                        .map((entry) => `[${entry.stream}] ${entry.message}`)
                        .join("\n")}
                    </pre>
                  </div>
                </Show>
              </Match>

              <Match when={page() === "advanced"}>
                <div class="settings-page-heading section-title-row">
                  <div>
                    <h3>Configuração</h3>
                    <p>Configuração efetiva e editor direto para qualquer chave oficial.</p>
                  </div>
                  <button
                    aria-label="Atualizar configuração"
                    class="icon-button"
                    onClick={() => void props.session.refreshConfig()}
                    title="Atualizar"
                    type="button"
                  >
                    <RefreshIcon />
                  </button>
                </div>

                <pre class="config-json">{configJson()}</pre>

                <div class="settings-editor">
                  <h4>Editar chave</h4>
                  <label>
                    Caminho da chave
                    <input
                      onInput={(event) => setKeyPath(event.currentTarget.value)}
                      placeholder="model_reasoning_effort"
                      value={keyPath()}
                    />
                  </label>
                  <label>
                    Valor JSON
                    <textarea
                      onInput={(event) => setValue(event.currentTarget.value)}
                      rows={4}
                      value={value()}
                    />
                  </label>
                  <label>
                    Estratégia
                    <select
                      onChange={(event) =>
                        setMergeStrategy(event.currentTarget.value as "replace" | "upsert")
                      }
                      value={mergeStrategy()}
                    >
                      <option value="replace">Substituir</option>
                      <option value="upsert">Mesclar ou criar</option>
                    </select>
                  </label>
                  <button
                    class="primary-button"
                    disabled={savingKey() !== null}
                    onClick={() => void saveAdvanced()}
                    type="button"
                  >
                    {savingKey() !== null ? "Salvando…" : "Salvar configuração"}
                  </button>
                </div>
              </Match>
            </Switch>

            <Show when={formError()}>
              {(message) => <p class="inline-error settings-error">{message()}</p>}
            </Show>
            <Show when={savingKey()}>
              <div class="settings-saving" role="status">
                Salvando…
              </div>
            </Show>
      </main>
    </section>
  );
}

function SettingsSelect(props: SettingsSelectProps) {
  return (
    <label class="settings-row">
      <span>
        <strong>{props.label}</strong>
        <small>{props.description}</small>
      </span>
      <select
        disabled={props.disabled || props.options.length === 0}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        value={props.value}
      >
        <For each={props.options}>
          {(option) => <option value={option.value}>{option.label}</option>}
        </For>
      </select>
    </label>
  );
}

function accountPlan(session: CodexSession): string {
  const account = session.account()?.account;
  if (account !== null && account !== undefined && "planType" in account) {
    const plan = account.planType;
    if (typeof plan === "string" && plan.length > 0) {
      return `Plano ${plan}`;
    }
  }
  return "Autenticação oficial do ChatGPT";
}

function compatibilityLabel(session: CodexSession): string {
  const runtime = session.runtime();
  if (runtime === null || !runtime.compatibility.available) {
    return "Indisponível";
  }
  return runtime.engine.kind === "native" ? "Sob demanda" : "Ativa";
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
  return "Não foi possível salvar a configuração.";
}
