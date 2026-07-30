import { createMemo } from "solid-js";

import {
  configString,
  configuredModel,
  configuredReasoningEffort,
  configuredServiceTier,
  reasoningEfforts,
  reasoningLabel,
  serviceTierLabel,
} from "../../shared/codex/models";
import type { SelectOption } from "./settingsTypes";
import type { WebSearchMode } from "../../shared/codex/types";
import { SettingsPageHeading, SettingsSection, SettingsSelect } from "./SettingsControls";
import { isAdministrativelyManaged } from "./configPolicy";
import type { SettingsPageProps } from "./settingsTypes";

const WEB_SEARCH_OPTIONS: ReadonlyArray<SelectOption & { value: WebSearchMode }> = [
  { label: "Desativada", value: "disabled" },
  { label: "Cache", value: "cached" },
  { label: "Índice", value: "indexed" },
  { label: "Ao vivo", value: "live" },
];

export function GeneralSettingsPage(props: SettingsPageProps) {
  const model = createMemo(() =>
    configuredModel(props.session.config(), props.session.models()),
  );
  const effort = createMemo(() =>
    configuredReasoningEffort(props.session.config(), model()),
  );
  const serviceTier = createMemo(() =>
    configuredServiceTier(props.session.config(), model()),
  );
  const allowedWebSearchModes = createMemo(
    () =>
      props.session.configRequirements()?.requirements?.allowedWebSearchModes
      ?? null,
  );
  const webSearchOptions = createMemo(() => {
    const allowed = allowedWebSearchModes();
    return allowed === null
      ? [...WEB_SEARCH_OPTIONS]
      : WEB_SEARCH_OPTIONS.filter((option) => allowed.includes(option.value));
  });
  const modelOptions = createMemo(() =>
    props.session.models()
      .filter((candidate) => !candidate.hidden)
      .map((candidate) => ({
        label: candidate.displayName,
        value: candidate.model,
      })),
  );
  const effortOptions = createMemo(() =>
    reasoningEfforts(model()).map((option) => ({
      label: reasoningLabel(option.reasoningEffort),
      value: option.reasoningEffort,
    })),
  );
  const serviceTierOptions = createMemo<SelectOption[]>(() => [
    { label: "Padrão", value: "" },
    ...(model()?.serviceTiers ?? [])
      .filter((tier) => tier.id !== "default")
      .map((tier) => ({
        label: serviceTierLabel(tier.id, model()),
        value: tier.id,
      })),
  ]);
  const saving = () => props.savingKey() !== null;
  const modelManaged = () =>
    isAdministrativelyManaged(props.session.config(), "model");
  const effortManaged = () =>
    isAdministrativelyManaged(props.session.config(), "model_reasoning_effort");
  const serviceTierManaged = () =>
    isAdministrativelyManaged(props.session.config(), "service_tier");
  const webSearchManaged = () =>
    allowedWebSearchModes() !== null
    || isAdministrativelyManaged(props.session.config(), "web_search");
  const webSearchLocked = () =>
    isAdministrativelyManaged(props.session.config(), "web_search")
    || (allowedWebSearchModes() !== null && webSearchOptions().length <= 1);

  return (
    <>
      <SettingsPageHeading
        description="Padrões usados ao iniciar novas tarefas e ferramentas do agente."
        title="Geral"
      />

      <SettingsSection title="Novas tarefas">
        <SettingsSelect
          description="Modelo padrão usado ao criar uma tarefa."
          disabled={saving() || modelManaged()}
          label="Modelo"
          managed={modelManaged()}
          onChange={(next) => void props.saveSetting("model", next)}
          options={modelOptions()}
          value={model()?.model ?? ""}
        />
        <SettingsSelect
          description="Profundidade de raciocínio padrão do modelo selecionado."
          disabled={saving() || effortManaged()}
          label="Esforço de raciocínio"
          managed={effortManaged()}
          onChange={(next) => void props.saveSetting("model_reasoning_effort", next)}
          options={effortOptions()}
          value={effort()}
        />
        <SettingsSelect
          description="Classe de serviço usada quando o modelo oferece mais de uma velocidade."
          disabled={saving() || serviceTierManaged()}
          label="Velocidade"
          managed={serviceTierManaged()}
          onChange={(next) =>
            void props.saveSetting("service_tier", next.length === 0 ? null : next)
          }
          options={serviceTierOptions()}
          value={serviceTier() ?? ""}
        />
      </SettingsSection>

      <SettingsSection title="Ferramentas">
        <SettingsSelect
          description="Estratégia oficial usada pelo Codex para pesquisar na web."
          disabled={saving() || webSearchLocked()}
          label="Pesquisa na web"
          managed={webSearchManaged()}
          onChange={(next) => void props.saveSetting("web_search", next)}
          options={webSearchOptions()}
          value={configString(props.session.config(), "web_search") ?? "cached"}
        />
      </SettingsSection>

      <p class="settings-note">
        Modelo, esforço, velocidade e personalidade são estáticos para tarefas já
        iniciadas. As novas escolhas passam a valer na próxima tarefa.
      </p>
    </>
  );
}
