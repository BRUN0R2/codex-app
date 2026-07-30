import { For, Show, createMemo, createSignal } from "solid-js";

import type {
  WindowsSandboxReadiness,
  WindowsSandboxSetupMode,
} from "../../shared/codex/types";
import { ShieldIcon } from "../../shared/components/Icons";
import type { CodexSession } from "../session/createCodexSession";
import { SettingsSection, SettingsStatus } from "./SettingsControls";

interface WindowsSandboxSettingsProps {
  session: Pick<
    CodexSession,
    | "configRequirements"
    | "setupWindowsSandbox"
    | "windowsSandboxReadiness"
    | "windowsSandboxSetupState"
  >;
}

interface SandboxModeOption {
  description: string;
  label: string;
  mode: WindowsSandboxSetupMode;
  recommended: boolean;
}

const SANDBOX_MODE_OPTIONS: readonly SandboxModeOption[] = [
  {
    description:
      "Requer permissão de Administrador e oferece o isolamento padrão do Codex.",
    label: "Configurar sandbox padrão",
    mode: "elevated",
    recommended: true,
  },
  {
    description:
      "Não exige Administrador, mas apresenta maior risco em caso de prompt injection.",
    label: "Usar sem administrador",
    mode: "unelevated",
    recommended: false,
  },
];

export function WindowsSandboxSettings(props: WindowsSandboxSettingsProps) {
  const [confirmationOpen, setConfirmationOpen] = createSignal(false);
  const readiness = () => props.session.windowsSandboxReadiness()?.status ?? null;
  const presentation = () => windowsSandboxPresentation(readiness());
  const setupState = props.session.windowsSandboxSetupState;
  const allowedOptions = createMemo(() => {
    const allowed =
      props.session.configRequirements()?.requirements
        ?.allowedWindowsSandboxImplementations ?? null;
    return allowed === null
      ? [...SANDBOX_MODE_OPTIONS]
      : SANDBOX_MODE_OPTIONS.filter((option) => allowed.includes(option.mode));
  });
  const setupPending = () =>
    setupState().type === "starting" || setupState().type === "running";
  const setupError = () => {
    const state = setupState();
    return state.type === "failed" ? state.error : null;
  };
  const needsSetup = () =>
    readiness() === "notConfigured" || readiness() === "updateRequired";

  function configure(mode: WindowsSandboxSetupMode) {
    setConfirmationOpen(false);
    void props.session.setupWindowsSandbox(mode);
  }

  return (
    <SettingsSection title="Sandbox do Windows">
      <SettingsStatus
        description="Confirma se o executor compatível pode aplicar o isolamento do Windows."
        label="Prontidão do executor"
        tone={presentation().tone}
        value={presentation().label}
      />

      <Show when={needsSetup()}>
        <div class="windows-sandbox-action">
          <Show
            when={allowedOptions().length > 0}
            fallback={
              <p class="windows-sandbox-managed">
                A organização não permite configurar o sandbox por esta interface.
              </p>
            }
          >
            <Show
              when={setupPending()}
              fallback={
                <button
                  class="secondary-button compact-button"
                  onClick={() => setConfirmationOpen(true)}
                  type="button"
                >
                  Configurar sandbox
                </button>
              }
            >
              <div class="windows-sandbox-progress" role="status">
                <span />
                Configurando o sandbox do Windows…
              </div>
            </Show>
          </Show>
        </div>
      </Show>

      <Show when={confirmationOpen() && needsSetup() && !setupPending()}>
        <div
          aria-labelledby="windows-sandbox-confirmation-title"
          class="windows-sandbox-confirmation"
          role="alertdialog"
        >
          <div class="windows-sandbox-confirmation-heading">
            <ShieldIcon size={20} />
            <div>
              <strong id="windows-sandbox-confirmation-title">
                Configurar o sandbox do Windows?
              </strong>
              <p>
                A configuração prepara o isolamento para este ambiente e grava a
                implementação escolhida no Codex.
              </p>
            </div>
          </div>
          <div class="windows-sandbox-options">
            <For each={allowedOptions()}>
              {(option) => (
                <button
                  classList={{ recommended: option.recommended }}
                  onClick={() => configure(option.mode)}
                  type="button"
                >
                  <span>
                    <strong>{option.label}</strong>
                    <Show when={option.recommended}>
                      <small>Recomendado</small>
                    </Show>
                  </span>
                  <p>{option.description}</p>
                </button>
              )}
            </For>
          </div>
          <button
            class="windows-sandbox-cancel"
            onClick={() => setConfirmationOpen(false)}
            type="button"
          >
            Cancelar
          </button>
        </div>
      </Show>

      <Show when={needsSetup() ? setupError() : null}>
        {(message) => (
          <p class="windows-sandbox-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={setupState().type === "succeeded"}>
        <p class="windows-sandbox-success" role="status">
          Sandbox configurado. A prontidão foi atualizada.
        </p>
      </Show>
    </SettingsSection>
  );
}

function windowsSandboxPresentation(
  status: WindowsSandboxReadiness | null,
): { label: string; tone: "default" | "success" | "warning" } {
  switch (status) {
    case "ready":
      return { label: "Pronto", tone: "success" };
    case "notConfigured":
      return { label: "Não configurado", tone: "warning" };
    case "updateRequired":
      return { label: "Atualização necessária", tone: "warning" };
    case null:
      return { label: "Verificando…", tone: "default" };
  }
}
