import { For, Show, createEffect } from "solid-js";

import { ShieldAlertIcon } from "../../shared/components/Icons";
import type {
  CodexSession,
  WindowsWorldWritableWarningState,
} from "../session/createCodexSession";

interface WindowsWorldWritableWarningProps {
  session: Pick<
    CodexSession,
    "resolveWorldWritableWarning" | "worldWritableWarningState"
  >;
}

export function WindowsWorldWritableWarning(
  props: WindowsWorldWritableWarningProps,
) {
  let dialog: HTMLElement | undefined;
  let wasActive = false;

  createEffect(() => {
    const isActive = props.session.worldWritableWarningState().type !== "idle";
    if (isActive && !wasActive) {
      queueMicrotask(() => dialog?.focus());
    }
    wasActive = isActive;
  });

  return (
    <Show when={activeWarning(props.session.worldWritableWarningState())}>
      {(active) => (
        <section
          aria-describedby="world-writable-warning-description"
          aria-labelledby="world-writable-warning-title"
          aria-live="assertive"
          aria-modal="false"
          class="world-writable-warning"
          ref={dialog}
          role="alertdialog"
          tabIndex={-1}
        >
          <div class="world-writable-warning-heading">
            <ShieldAlertIcon size={19} />
            <div>
              <strong id="world-writable-warning-title">
                A proteção do sandbox precisa da sua atenção
              </strong>
              <p id="world-writable-warning-description">
                {active().warning.failedScan
                  ? "Não foi possível concluir a verificação. O sandbox do Windows não pode garantir a proteção neste modo."
                  : "O sandbox do Windows não protege gravações em pastas nas quais o grupo Todos possui acesso de escrita."}
              </p>
            </div>
          </div>

          <Show when={active().warning.samplePaths.length > 0}>
            <div class="world-writable-warning-paths">
              <span>
                {active().warning.failedScan
                  ? "Pastas identificadas antes da falha:"
                  : "Revise o acesso de escrita destas pastas:"}
              </span>
              <ul>
                <For each={active().warning.samplePaths}>
                  {(path) => <li title={path}>{path}</li>}
                </For>
              </ul>
              <Show when={active().warning.extraCount > 0}>
                <small>e mais {active().warning.extraCount}</small>
              </Show>
            </div>
          </Show>

          <p class="world-writable-warning-note">
            O app não altera permissões de arquivos automaticamente.
          </p>

          <Show when={warningError(active())}>
            {(message) => (
              <p class="world-writable-warning-error" role="alert">
                {message()}
              </p>
            )}
          </Show>

          <div class="world-writable-warning-actions">
            <button
              disabled={active().type === "persisting"}
              onClick={() => {
                void props.session.resolveWorldWritableWarning(false);
              }}
              type="button"
            >
              Continuar nesta sessão
            </button>
            <button
              class="primary"
              disabled={active().type === "persisting"}
              onClick={() => {
                void props.session.resolveWorldWritableWarning(true);
              }}
              type="button"
            >
              {active().type === "persisting"
                ? "Salvando…"
                : "Continuar e não avisar novamente"}
            </button>
          </div>
        </section>
      )}
    </Show>
  );
}

function activeWarning(
  state: WindowsWorldWritableWarningState,
): Exclude<WindowsWorldWritableWarningState, { type: "idle" }> | undefined {
  return state.type === "idle" ? undefined : state;
}

function warningError(
  state: Exclude<WindowsWorldWritableWarningState, { type: "idle" }>,
): string | undefined {
  return state.type === "failed" ? state.error : undefined;
}
