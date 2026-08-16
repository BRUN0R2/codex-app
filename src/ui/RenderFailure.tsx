import { onMount } from "solid-js";

import { CodexGlyph } from "./CodexGlyph";

export function ApplicationRenderFailure(props: {
  readonly error: unknown;
  readonly onReport: (error: unknown) => void;
  readonly onReload: () => void;
}) {
  const message = renderFailureMessage(props.error);

  onMount(() => props.onReport(props.error));

  return (
    <main class="boot-screen error-state">
      <div class="boot-card">
        <span aria-hidden="true" class="brand-mark large">
          <CodexGlyph size={30} />
        </span>
        <p class="eyebrow">Falha de renderização</p>
        <h1>O shell do aplicativo falhou</h1>
        <p>{message}</p>
        <button class="primary-button" onClick={props.onReload} type="button">
          Reiniciar interface
        </button>
      </div>
    </main>
  );
}

export function TimelineTurnRenderFailure(props: {
  readonly error: unknown;
  readonly onReport: (error: unknown) => void;
  readonly onReset: () => void;
  readonly turnId: string;
}) {
  onMount(() => {
    props.onReport(
      new Error(
        `Falha ao renderizar o turno ${props.turnId}: ${renderFailureMessage(props.error)}`,
        {
          cause: props.error,
        },
      ),
    );
  });

  return (
    <section class="turn-failure" role="alert">
      <strong>Não foi possível renderizar este turno</strong>
      <p>{renderFailureMessage(props.error)}</p>
      <button class="secondary-button" onClick={props.onReset} type="button">
        Tentar novamente
      </button>
    </section>
  );
}

export function renderFailureMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
