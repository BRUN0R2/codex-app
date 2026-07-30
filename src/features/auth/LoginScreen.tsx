import { Show } from "solid-js";

interface LoginScreenProps {
  error: string | null;
  pending: boolean;
  onCancel: () => Promise<void>;
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
          Entre com sua conta ChatGPT pelo mesmo fluxo OAuth do Codex. A sessão
          é processada pelo backend Rust e protegida pelo Gerenciador de
          Credenciais do Windows.
        </p>
        <button
          class="primary-button auth-button"
          disabled={props.pending}
          onClick={() => void props.onLogin()}
          type="button"
        >
          {props.pending ? "Aguardando o navegador…" : "Continuar com ChatGPT"}
        </button>
        <Show when={props.pending}>
          <button
            class="secondary-button auth-cancel-button"
            onClick={() => void props.onCancel()}
            type="button"
          >
            Cancelar
          </button>
        </Show>
        <Show when={props.error}>
          {(message) => <p class="inline-error">{message()}</p>}
        </Show>
        <p class="auth-footnote">
          Tokens nunca atravessam a interface. A CLI não participa do login,
          renovação ou logout.
        </p>
      </section>
    </main>
  );
}
