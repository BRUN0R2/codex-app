import { Show, type JSX } from "solid-js";

interface RequestFrameProps {
  actions: JSX.Element;
  children: JSX.Element;
  eyebrow: string;
  pendingCount: number;
  subtitle?: string | null;
  title: string;
}

export function RequestFrame(props: RequestFrameProps) {
  return (
    <section
      aria-labelledby="interactive-request-title"
      class="interactive-request"
      role="dialog"
    >
      <header class="interactive-request-header">
        <div>
          <p class="interactive-request-eyebrow">{props.eyebrow}</p>
          <h2 id="interactive-request-title">{props.title}</h2>
          <Show when={props.subtitle}>
            {(subtitle) => <p>{subtitle()}</p>}
          </Show>
        </div>
        <Show when={props.pendingCount > 1}>
          <span class="interactive-request-count">
            +{props.pendingCount - 1} pendente{props.pendingCount === 2 ? "" : "s"}
          </span>
        </Show>
      </header>
      <div class="interactive-request-body">{props.children}</div>
      <footer class="interactive-request-actions">{props.actions}</footer>
    </section>
  );
}
