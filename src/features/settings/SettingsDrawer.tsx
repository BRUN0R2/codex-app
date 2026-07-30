import { For, Match, Show, Switch, createSignal, onMount } from "solid-js";

import {
  ChevronLeftIcon,
  CodeIcon,
  PaletteIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  SparkIcon,
  UserIcon,
} from "../../shared/components/Icons";
import type { CodexSession } from "../session/createCodexSession";
import { AccountSettingsPage } from "./AccountSettingsPage";
import { AdvancedSettingsPage } from "./AdvancedSettingsPage";
import { AppearanceSettingsPage } from "./AppearanceSettingsPage";
import { ConfigurationSettingsPage } from "./ConfigurationSettingsPage";
import { GeneralSettingsPage } from "./GeneralSettingsPage";
import { PersonalizationSettingsPage } from "./PersonalizationSettingsPage";
import type { SaveSetting, SettingsPage } from "./settingsTypes";

interface SettingsDrawerProps {
  session: CodexSession;
  onClose: () => void;
}

interface NavigationItem {
  label: string;
  page: SettingsPage;
  searchTerms: string;
}

const PERSONAL_ITEMS: NavigationItem[] = [
  { label: "Geral", page: "general", searchTerms: "modelo esforço velocidade web" },
  {
    label: "Aparência",
    page: "appearance",
    searchTerms: "fonte tamanho movimento cursor diff cores",
  },
  {
    label: "Personalização",
    page: "personalization",
    searchTerms: "personalidade instruções tom contexto",
  },
  { label: "Conta", page: "account", searchTerms: "login chatgpt runtime engine" },
];

const CODEX_ITEMS: NavigationItem[] = [
  {
    label: "Configuração",
    page: "configuration",
    searchTerms: "sandbox aprovações permissões raciocínio verbosidade",
  },
  {
    label: "Avançado",
    page: "advanced",
    searchTerms: "config toml json chave diagnóstico",
  },
];

export function SettingsDrawer(props: SettingsDrawerProps) {
  const [page, setPage] = createSignal<SettingsPage>("general");
  const [query, setQuery] = createSignal("");
  const [savingKey, setSavingKey] = createSignal<string | null>(null);
  const [formError, setFormError] = createSignal<string | null>(null);
  const saveSetting: SaveSetting = async (
    keyPath,
    value,
    mergeStrategy = "replace",
  ) => {
    setSavingKey(keyPath);
    setFormError(null);
    try {
      await props.session.writeSetting(keyPath, value, mergeStrategy);
      return true;
    } catch (reason) {
      setFormError(describeError(reason));
      return false;
    } finally {
      setSavingKey(null);
    }
  };
  const refreshConfig = async () => {
    setSavingKey("config/read");
    setFormError(null);
    try {
      await props.session.refreshConfig();
      return true;
    } catch (reason) {
      setFormError(describeError(reason));
      return false;
    } finally {
      setSavingKey(null);
    }
  };

  onMount(() => {
    void props.session.loadCompatibilityContext().catch((reason) => {
      setFormError(describeError(reason));
    });
  });

  function updateQuery(nextQuery: string) {
    setQuery(nextQuery);
    const normalized = normalizeSearch(nextQuery);
    if (normalized.length === 0) {
      return;
    }
    const matches = [...PERSONAL_ITEMS, ...CODEX_ITEMS].filter((item) =>
      normalizeSearch(`${item.label} ${item.searchTerms}`).includes(normalized),
    );
    if (matches.length === 1 && matches[0] !== undefined) {
      setPage(matches[0].page);
    }
  }

  function matchesQuery(item: NavigationItem): boolean {
    const normalized = normalizeSearch(query());
    return (
      normalized.length === 0
      || normalizeSearch(`${item.label} ${item.searchTerms}`).includes(normalized)
    );
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

        <SettingsNavigation
          activePage={page()}
          items={PERSONAL_ITEMS.filter(matchesQuery)}
          onSelect={setPage}
          title="Pessoais"
        />
        <SettingsNavigation
          activePage={page()}
          items={CODEX_ITEMS.filter(matchesQuery)}
          onSelect={setPage}
          title="Codex"
        />
      </aside>

      <main class="settings-content">
        <Switch>
          <Match when={page() === "general"}>
            <GeneralSettingsPage
              refreshConfig={refreshConfig}
              saveSetting={saveSetting}
              savingKey={savingKey}
              session={props.session}
            />
          </Match>
          <Match when={page() === "appearance"}>
            <AppearanceSettingsPage
              refreshConfig={refreshConfig}
              saveSetting={saveSetting}
              savingKey={savingKey}
              session={props.session}
            />
          </Match>
          <Match when={page() === "personalization"}>
            <PersonalizationSettingsPage
              refreshConfig={refreshConfig}
              saveSetting={saveSetting}
              savingKey={savingKey}
              session={props.session}
            />
          </Match>
          <Match when={page() === "configuration"}>
            <ConfigurationSettingsPage
              refreshConfig={refreshConfig}
              saveSetting={saveSetting}
              savingKey={savingKey}
              session={props.session}
            />
          </Match>
          <Match when={page() === "account"}>
            <AccountSettingsPage session={props.session} />
          </Match>
          <Match when={page() === "advanced"}>
            <AdvancedSettingsPage
              refreshConfig={refreshConfig}
              saveSetting={saveSetting}
              savingKey={savingKey}
              session={props.session}
            />
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

function SettingsNavigation(props: {
  activePage: SettingsPage;
  items: NavigationItem[];
  onSelect: (page: SettingsPage) => void;
  title: string;
}) {
  return (
    <Show when={props.items.length > 0}>
      <span class="settings-nav-section">{props.title}</span>
      <nav aria-label={props.title} class="settings-nav">
        <For each={props.items}>
          {(item) => (
            <button
              classList={{ active: props.activePage === item.page }}
              onClick={() => props.onSelect(item.page)}
              type="button"
            >
              <SettingsNavigationIcon page={item.page} />
              {item.label}
            </button>
          )}
        </For>
      </nav>
    </Show>
  );
}

function SettingsNavigationIcon(props: { page: SettingsPage }) {
  switch (props.page) {
    case "general":
      return <SparkIcon size={16} />;
    case "appearance":
      return <PaletteIcon size={16} />;
    case "personalization":
      return <UserIcon size={16} />;
    case "configuration":
      return <SettingsIcon size={16} />;
    case "account":
      return <ShieldIcon size={16} />;
    case "advanced":
      return <CodeIcon size={16} />;
  }
}

function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .trim()
    .toLocaleLowerCase("pt-BR");
}

function describeError(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  if (reason !== null && typeof reason === "object" && "message" in reason) {
    const message = reason.message;
    if (typeof message === "string") {
      return message;
    }
  }
  return "Não foi possível salvar a configuração.";
}
