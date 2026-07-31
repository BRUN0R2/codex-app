import { Show } from "solid-js";

import { SparkIcon } from "../../shared/components/Icons";
import type { CodexSession } from "../session/createCodexSession";

interface SafetyBufferingNoticeProps {
  session: Pick<
    CodexSession,
    | "dismissSafetyBuffering"
    | "openSafetyBufferingHelp"
    | "retrySafetyBufferedTurn"
    | "safetyBufferingState"
  >;
}

export function SafetyBufferingNotice(props: SafetyBufferingNoticeProps) {
  const active = () => {
    const state = props.session.safetyBufferingState();
    return state.type === "waiting" ? state : null;
  };

  return (
    <Show when={active()}>
      {(state) => (
        <section aria-live="polite" class="safety-buffering-notice">
          <SparkIcon size={18} />
          <div class="safety-buffering-copy">
            <strong>Os sistemas estão analisando esta solicitação com mais cuidado</strong>
            <p>
              {state().retrying
                ? "Criando uma nova tarefa segura com o modelo mais rápido…"
                : "Aguarde ou tente um modelo mais rápido para receber a resposta antes, embora ele possa lidar pior com solicitações complexas."}
            </p>
            <Show when={!state().retrying}>
              <p>Nenhuma ação é necessária; o Codex continuará aguardando.</p>
            </Show>
            <Show when={state().error}>
              {(message) => <p class="safety-buffering-error">{message()}</p>}
            </Show>
          </div>
          <div class="safety-buffering-actions">
            <Show when={state().canRetry}>
              <button
                class="primary"
                disabled={state().retrying}
                onClick={() => void props.session.retrySafetyBufferedTurn()}
                title={
                  state().fasterModel === null
                    ? undefined
                    : `Usar ${state().fasterModel}`
                }
                type="button"
              >
                {state().retrying ? "Preparando…" : "Tentar com modelo mais rápido"}
              </button>
            </Show>
            <button
              disabled={state().retrying}
              onClick={props.session.dismissSafetyBuffering}
              type="button"
            >
              Continuar aguardando
            </button>
            <button
              class="link"
              onClick={() => void props.session.openSafetyBufferingHelp()}
              type="button"
            >
              Saiba mais
            </button>
          </div>
        </section>
      )}
    </Show>
  );
}
