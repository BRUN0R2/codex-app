import { onMount } from "solid-js";
import { useI18n } from "../i18n/context";
import { describeError } from "../infrastructure/errorDescription";

import { CodexGlyph } from "./CodexGlyph";

export function ApplicationRenderFailure(props: {
  readonly error: unknown;
  readonly onReport: (error: unknown) => void;
  readonly onReload: () => void;
}) {
  const i18n = useI18n();
  const message = renderFailureMessage(props.error);

  onMount(() => props.onReport(props.error));

  return (
    <main class="boot-screen error-state">
      <div class="boot-card">
        <span aria-hidden="true" class="brand-mark large">
          <CodexGlyph size={30} />
        </span>
        <p class="eyebrow">{i18n.messages().renderFailure.eyebrow}</p>
        <h1>{i18n.messages().renderFailure.applicationTitle}</h1>
        <p>{message}</p>
        <button class="primary-button" onClick={props.onReload} type="button">
          {i18n.messages().renderFailure.restart}
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
  const i18n = useI18n();
  onMount(() => {
    props.onReport(
      new Error(`Failed to render turn ${props.turnId}: ${renderFailureMessage(props.error)}`, {
        cause: props.error,
      }),
    );
  });

  return (
    <section class="turn-failure" role="alert">
      <strong>{i18n.messages().renderFailure.turnTitle}</strong>
      <p>{renderFailureMessage(props.error)}</p>
      <button class="secondary-button" onClick={props.onReset} type="button">
        {i18n.messages().common.tryAgain}
      </button>
    </section>
  );
}

export function renderFailureMessage(reason: unknown): string {
  return describeError(reason);
}
