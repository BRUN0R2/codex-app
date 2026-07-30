import { createSignal } from "solid-js";

import { configString } from "../../shared/codex/models";
import { SettingsPageHeading, SettingsSection, SettingsSelect } from "./SettingsControls";
import { isAdministrativelyManaged } from "./configPolicy";
import type { SettingsPageProps } from "./settingsTypes";

export function PersonalizationSettingsPage(props: SettingsPageProps) {
  const configuredInstructions = () =>
    configString(props.session.config(), "instructions") ?? "";
  const [instructionsDraft, setInstructionsDraft] = createSignal<string | null>(null);
  const instructions = () => instructionsDraft() ?? configuredInstructions();
  const dirty = () =>
    instructionsDraft() !== null && instructions() !== configuredInstructions();
  const saving = () => props.savingKey() !== null;
  const personalityManaged = () =>
    isAdministrativelyManaged(props.session.config(), "personality");
  const instructionsManaged = () =>
    isAdministrativelyManaged(props.session.config(), "instructions");

  async function saveInstructions() {
    const next = instructions();
    const saved = await props.saveSetting(
      "instructions",
      next.trim().length === 0 ? null : next,
    );
    if (saved) {
      setInstructionsDraft(null);
    }
  }

  return (
    <>
      <SettingsPageHeading
        description="Tom e contexto aplicados às novas tarefas neste computador."
        title="Personalização"
      />

      <div class="settings-callout">
        A personalidade depende do modelo. Instruções personalizadas continuam sendo
        a fonte explícita de comportamento para todos os modelos.
      </div>

      <SettingsSection>
        <SettingsSelect
          description="Escolha o tom padrão das respostas do Codex."
          disabled={saving() || personalityManaged()}
          label="Personalidade"
          managed={personalityManaged()}
          onChange={(next) => void props.saveSetting("personality", next)}
          options={[
            { label: "Amigável", value: "friendly" },
            { label: "Pragmática", value: "pragmatic" },
            { label: "Sem personalidade", value: "none" },
          ]}
          value={configString(props.session.config(), "personality") ?? "friendly"}
        />
      </SettingsSection>

      <section class="settings-text-section">
        <div class="settings-text-heading">
          <span>
            <strong>Instruções personalizadas</strong>
            <small>Contexto adicional enviado para todas as novas tarefas.</small>
          </span>
          <button
            class="secondary-button compact-button"
            disabled={!dirty() || saving() || instructionsManaged()}
            onClick={() => void saveInstructions()}
            type="button"
          >
            {props.savingKey() === "instructions" ? "Salvando…" : "Salvar"}
          </button>
        </div>
        <textarea
          aria-label="Instruções personalizadas"
          disabled={saving() || instructionsManaged()}
          onInput={(event) => setInstructionsDraft(event.currentTarget.value)}
          placeholder="Adicione instruções personalizadas…"
          rows={8}
          value={instructions()}
        />
      </section>
    </>
  );
}
