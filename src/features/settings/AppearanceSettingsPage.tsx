import { createMemo } from "solid-js";

import { SettingsPageHeading, SettingsSection, SettingsSelect, SettingsToggle } from "./SettingsControls";
import {
  APPEARANCE_SETTING_PATHS,
  UI_FONT_SIZES,
  parseUiFontSize,
  readAppearancePreferences,
} from "./appearancePreferences";
import type { SettingsPageProps } from "./settingsTypes";

export function AppearanceSettingsPage(props: SettingsPageProps) {
  const appearance = createMemo(() =>
    readAppearancePreferences(props.session.config()),
  );
  const saving = () => props.savingKey() !== null;

  return (
    <>
      <SettingsPageHeading
        description="Ajustes locais do desktop, isolados da configuração do agente."
        title="Aparência"
      />

      <div class="appearance-preview" aria-hidden="true">
        <span />
        <div>
          <i />
          <i />
          <i />
        </div>
      </div>

      <SettingsSection title="Interface">
        <SettingsSelect
          description="Tamanho base aplicado de forma consistente a toda a interface."
          disabled={saving()}
          label="Tamanho da interface"
          onChange={(next) => {
            const size = parseUiFontSize(next);
            if (size !== null) {
              void props.saveSetting(APPEARANCE_SETTING_PATHS.uiFontSize, size);
            }
          }}
          options={UI_FONT_SIZES.map((size) => ({
            label: `${size} px`,
            value: String(size),
          }))}
          value={String(appearance().uiFontSize)}
        />
        <SettingsSelect
          description="Reduz animações, respeita o Windows ou mantém o movimento completo."
          disabled={saving()}
          label="Reduzir movimento"
          onChange={(next) =>
            void props.saveSetting(APPEARANCE_SETTING_PATHS.motion, next)
          }
          options={[
            { label: "Seguir o sistema", value: "system" },
            { label: "Ativado", value: "reduce" },
            { label: "Desativado", value: "full" },
          ]}
          value={appearance().motion}
        />
        <SettingsToggle
          checked={appearance().pointerCursor}
          description="Usa o cursor de ponteiro sobre controles interativos."
          disabled={saving()}
          label="Usar cursores de ponteiro"
          onChange={(next) =>
            void props.saveSetting(APPEARANCE_SETTING_PATHS.pointerCursor, next)
          }
        />
        <SettingsSelect
          description="Distingue alterações por cor ou por marcadores +/−."
          disabled={saving()}
          label="Marcadores de diferença"
          onChange={(next) =>
            void props.saveSetting(APPEARANCE_SETTING_PATHS.diffDisplay, next)
          }
          options={[
            { label: "Cores", value: "color" },
            { label: "Mais e menos", value: "markers" },
          ]}
          value={appearance().diffDisplay}
        />
      </SettingsSection>
    </>
  );
}
