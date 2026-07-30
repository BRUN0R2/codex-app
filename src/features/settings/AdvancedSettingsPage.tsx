import { createSignal } from "solid-js";

import { RefreshIcon } from "../../shared/components/Icons";
import { isJsonValue } from "../../shared/codex/types";
import { SettingsPageHeading } from "./SettingsControls";
import type { MergeStrategy, SettingsPageProps } from "./settingsTypes";

export function AdvancedSettingsPage(props: SettingsPageProps) {
  const [keyPath, setKeyPath] = createSignal("");
  const [value, setValue] = createSignal("true");
  const [mergeStrategy, setMergeStrategy] = createSignal<MergeStrategy>("replace");
  const [parseError, setParseError] = createSignal<string | null>(null);
  const effectiveKeyCount = () => Object.keys(props.session.config()?.config ?? {}).length;
  const originCount = () => Object.keys(props.session.config()?.origins ?? {}).length;
  const layerCount = () => props.session.config()?.layers?.length ?? 0;

  async function saveAdvanced() {
    const path = keyPath().trim();
    if (path.length === 0) {
      setParseError("Informe o caminho da configuração.");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(value());
    } catch {
      setParseError("O valor precisa ser JSON válido, como true, 42, \"texto\" ou {...}.");
      return;
    }
    if (!isJsonValue(parsed)) {
      setParseError("O valor precisa conter somente tipos JSON.");
      return;
    }

    setParseError(null);
    await props.saveSetting(path, parsed, mergeStrategy());
  }

  return (
    <>
      <SettingsPageHeading
        description="Inspeção efetiva e edição explícita de chaves oficiais do config.toml."
        title="Avançado"
      >
        <button
          aria-label="Atualizar configuração"
          class="icon-button settings-heading-action"
          disabled={props.savingKey() !== null}
          onClick={() => void props.refreshConfig()}
          title="Atualizar configuração"
          type="button"
        >
          <RefreshIcon size={16} />
        </button>
      </SettingsPageHeading>

      <dl class="settings-facts settings-facts-advanced">
        <div>
          <dt>Chaves efetivas</dt>
          <dd>{effectiveKeyCount()}</dd>
        </div>
        <div>
          <dt>Origens rastreadas</dt>
          <dd>{originCount()}</dd>
        </div>
        <div>
          <dt>Camadas carregadas</dt>
          <dd>{layerCount()}</dd>
        </div>
      </dl>

      <p class="settings-note settings-privacy-note">
        Valores efetivos não são exibidos aqui para evitar exposição acidental de
        credenciais, cabeçalhos ou segredos de integrações.
      </p>

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
            onChange={(event) => {
              const nextStrategy = parseMergeStrategy(event.currentTarget.value);
              if (nextStrategy !== null) {
                setMergeStrategy(nextStrategy);
              }
            }}
            value={mergeStrategy()}
          >
            <option value="replace">Substituir</option>
            <option value="upsert">Mesclar ou criar</option>
          </select>
        </label>
        <button
          class="primary-button"
          disabled={props.savingKey() !== null}
          onClick={() => void saveAdvanced()}
          type="button"
        >
          {props.savingKey() !== null ? "Salvando…" : "Salvar configuração"}
        </button>
      </div>

      {parseError() !== null && (
        <p class="inline-error settings-error">{parseError()}</p>
      )}
    </>
  );
}

function parseMergeStrategy(value: string): MergeStrategy | null {
  return value === "replace" || value === "upsert" ? value : null;
}
