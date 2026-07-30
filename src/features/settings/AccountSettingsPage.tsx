import { Show, createMemo } from "solid-js";

import type { CodexSession } from "../session/createCodexSession";
import { SettingsPageHeading } from "./SettingsControls";

export function AccountSettingsPage(props: { session: CodexSession }) {
  const accountLabel = createMemo(() => {
    const account = props.session.account()?.account;
    if (account === null || account === undefined) {
      return "Provedor local";
    }
    if ("email" in account && typeof account.email === "string") {
      return account.email;
    }
    return account.type === "apiKey" ? "Chave da API" : account.type;
  });

  return (
    <>
      <SettingsPageHeading
        description="Sessão ChatGPT, Native Engine e ponte de compatibilidade."
        title="Conta"
      />

      <div class="account-card">
        <div class="account-avatar">{accountLabel().slice(0, 1).toUpperCase()}</div>
        <div>
          <strong>{accountLabel()}</strong>
          <span>{accountPlan(props.session)}</span>
        </div>
        <button
          class="secondary-button compact-button"
          onClick={() => void props.session.logout()}
          type="button"
        >
          Sair
        </button>
      </div>

      <dl class="settings-facts">
        <div>
          <dt>Engine</dt>
          <dd>{props.session.runtime()?.engine.name ?? "—"}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{props.session.runtime()?.engine.provider ?? "—"}</dd>
        </div>
        <div>
          <dt>Ponte de compatibilidade</dt>
          <dd>{compatibilityLabel(props.session)}</dd>
        </div>
        <div>
          <dt>Estado</dt>
          <dd>{props.session.runtimeStatus().state}</dd>
        </div>
        <div>
          <dt>Executável</dt>
          <dd title={props.session.runtime()?.executable ?? undefined}>
            {props.session.runtime()?.executable ?? "—"}
          </dd>
        </div>
        <div>
          <dt>Modelos disponíveis</dt>
          <dd>{props.session.models().length}</dd>
        </div>
      </dl>

      <Show when={props.session.diagnostics().length > 0}>
        <div class="diagnostic-block">
          <h4>Diagnósticos recentes</h4>
          <pre class="diagnostics">
            {props.session
              .diagnostics()
              .map((entry) => `[${entry.stream}] ${entry.message}`)
              .join("\n")}
          </pre>
        </div>
      </Show>
    </>
  );
}

function accountPlan(session: CodexSession): string {
  const account = session.account()?.account;
  if (account !== null && account !== undefined && "planType" in account) {
    const plan = account.planType;
    if (typeof plan === "string" && plan.length > 0) {
      return `Plano ${plan}`;
    }
  }
  return "Autenticação oficial do ChatGPT";
}

function compatibilityLabel(session: CodexSession): string {
  const runtime = session.runtime();
  if (runtime === null || !runtime.compatibility.available) {
    return "Indisponível";
  }
  return runtime.engine.kind === "native" ? "Sob demanda" : "Ativa";
}
