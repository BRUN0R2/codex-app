import { Match, Show, Switch } from "solid-js";

import { LoginScreen } from "./features/auth/LoginScreen";
import { createCodexSession } from "./features/session/createCodexSession";
import { AppShell } from "./features/shell/AppShell";

export default function App() {
  const session = createCodexSession();

  return (
    <Switch>
      <Match when={session.runtimeStatus().state === "failed"}>
        <main class="boot-screen">
          <div class="boot-card boot-card-error">
            <div class="brand-mark brand-mark-large">C</div>
            <h1>Não foi possível iniciar o Codex</h1>
            <p>{session.runtimeStatus().message ?? session.error()}</p>
            <code>Instale o Codex CLI ou configure CODEX_APP_BINARY.</code>
          </div>
        </main>
      </Match>
      <Match when={session.runtime() === null || session.account() === undefined}>
        <main class="boot-screen">
          <div class="boot-loader">
            <div class="brand-mark brand-mark-large">C</div>
            <span />
            <p>Inicializando o app-server…</p>
          </div>
        </main>
      </Match>
      <Match when={!session.signedIn()}>
        <LoginScreen
          error={session.error()}
          onLogin={session.login}
          pending={session.loginPending()}
        />
      </Match>
      <Match when={session.signedIn()}>
        <Show when={session.account()}>
          <AppShell session={session} />
        </Show>
      </Match>
    </Switch>
  );
}
