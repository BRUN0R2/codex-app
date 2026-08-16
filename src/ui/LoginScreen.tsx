import { Show } from "solid-js";

import type { AppController } from "../state/appController";
import { CodexGlyph } from "./CodexGlyph";
import { Icon } from "./Icon";

export function LoginScreen(props: { readonly controller: AppController }) {
  return (
    <main class="login-screen">
      <section class="login-card" aria-labelledby="login-title">
        <div class="login-brand" aria-hidden="true">
          <CodexGlyph size={30} />
        </div>
        <p class="eyebrow">Codex Desktop</p>
        <h1 id="login-title">Seu agente de código, nativo no PC</h1>
        <p class="login-copy">
          Entre com sua conta ChatGPT usando o fluxo OAuth oficial. Credenciais permanecem no
          armazenamento seguro do sistema e nunca chegam à interface.
        </p>
        <button
          class="primary-button login-button"
          disabled={props.controller.loginPending()}
          onClick={() => void props.controller.login()}
          type="button"
        >
          <Icon name="shield" size={18} />
          {props.controller.loginPending() ? "Aguardando o navegador…" : "Entrar com ChatGPT"}
        </button>
        <Show when={props.controller.loginPending()}>
          <button
            class="text-button"
            onClick={() => void props.controller.cancelLogin()}
            type="button"
          >
            Cancelar login
          </button>
        </Show>
        <div class="login-security">
          <span>
            <i /> OAuth com PKCE
          </span>
          <span>
            <i /> Tokens criptografados
          </span>
          <span>
            <i /> Engine independente
          </span>
        </div>
      </section>
      <Show when={props.controller.error()}>
        {(message) => (
          <p class="login-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </main>
  );
}
