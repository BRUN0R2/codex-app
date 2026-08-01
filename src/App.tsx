import { Match, Switch } from "solid-js";

import { createAppController } from "./state/createAppController";
import { AppShell } from "./ui/AppShell";
import { LoginScreen } from "./ui/LoginScreen";

export default function App() {
  const controller = createAppController();

  return (
    <Switch>
      <Match when={controller.runtimeStatus().state === "failed" && controller.engine() === null}>
        <main class="boot-screen error-state">
          <div class="boot-card">
            <span class="brand-mark large">C</span>
            <p class="eyebrow">Falha de inicialização</p>
            <h1>O engine nativo não iniciou</h1>
            <p>
              {controller.runtimeStatus().message ?? controller.error() ?? "Falha sem diagnóstico."}
            </p>
          </div>
        </main>
      </Match>
      <Match when={controller.engine() === null || controller.account() === undefined}>
        <main class="boot-screen">
          <div class="boot-loader">
            <span class="brand-mark large">C</span>
            <i />
            <p>Inicializando o engine nativo…</p>
          </div>
        </main>
      </Match>
      <Match when={!controller.signedIn()}>
        <LoginScreen controller={controller} />
      </Match>
      <Match when={controller.signedIn()}>
        <AppShell controller={controller} />
      </Match>
    </Switch>
  );
}
