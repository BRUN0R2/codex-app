import { Show } from "solid-js";

interface LoginScreenProps {
  error: string | null;
  pending: boolean;
  onLogin: () => Promise<void>;
}

export function LoginScreen(props: LoginScreenProps) {
  return (
    <main class="auth-screen">
      <section class="auth-card">
        <div class="brand-mark brand-mark-large" aria-hidden="true">
          C
        </div>
        <p class="eyebrow">CODEX APP</p>
        <h1>Seu agente de código, em uma base nativa.</h1>
        <p class="auth-description">
          Entre com sua conta ChatGPT pelo fluxo oficial do Codex. O aplicativo
          não recebe nem armazena seus tokens.
        </p>
        <button
          class="primary-button auth-button"
          disabled={props.pending}
          onClick={() => void props.onLogin()}
          type="button"
        >
          {props.pending ? "Aguardando o navegador…" : "Continuar com ChatGPT"}
        </button>
        <Show when={props.error}>
          {(message) => <p class="inline-error">{message()}</p>}
        </Show>
        <p class="auth-footnote">
          O login é executado pelo <code>codex app-server</code> instalado neste
          computador.
        </p>
      </section>
    </main>
  );
}
