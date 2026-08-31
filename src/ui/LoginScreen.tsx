import { Show } from "solid-js";

import { useI18n } from "../i18n/context";
import type { AppController } from "../state/appController";

type LoginScreenController = Pick<
  AppController,
  "cancelLogin" | "error" | "login" | "loginPending"
>;

import { CodexGlyph } from "./CodexGlyph";
import { Icon } from "./Icon";

export function LoginScreen(props: { readonly controller: LoginScreenController }) {
  const i18n = useI18n();

  return (
    <main class="login-screen">
      <section class="login-card" aria-labelledby="login-title">
        <div class="login-brand" aria-hidden="true">
          <CodexGlyph size={30} />
        </div>
        <p class="eyebrow">{i18n.messages().login.eyebrow}</p>
        <h1 id="login-title">{i18n.messages().login.title}</h1>
        <p class="login-copy">{i18n.messages().login.description}</p>
        <button
          class="primary-button login-button"
          disabled={props.controller.loginPending()}
          onClick={() => void props.controller.login()}
          type="button"
        >
          <Icon name="shield" size={18} />
          {props.controller.loginPending()
            ? i18n.messages().login.waitingForBrowser
            : i18n.messages().login.signIn}
        </button>
        <Show when={props.controller.loginPending()}>
          <button
            class="text-button"
            onClick={() => void props.controller.cancelLogin()}
            type="button"
          >
            {i18n.messages().login.cancel}
          </button>
        </Show>
        <div class="login-security">
          <span>
            <i /> {i18n.messages().login.pkce}
          </span>
          <span>
            <i /> {i18n.messages().login.encryptedTokens}
          </span>
          <span>
            <i /> {i18n.messages().login.independentEngine}
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
