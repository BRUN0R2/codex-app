import { Match, Show, Switch, createMemo } from "solid-js";

import type { CodexSession } from "../session/createCodexSession";
import {
  findAccountUsageExhaustion,
  formatUsageResetTime,
  summarizeAccountUsage,
  type AccountUsageSummary,
} from "./accountUsage";

interface AccountUsageCardProps {
  session: Pick<
    CodexSession,
    | "accountRateLimits"
    | "accountRateLimitsState"
    | "refreshAccountRateLimits"
  >;
}

export function AccountUsageCard(props: AccountUsageCardProps) {
  const summary = createMemo(() =>
    summarizeAccountUsage(props.session.accountRateLimits()),
  );
  const exhaustion = createMemo(() =>
    findAccountUsageExhaustion(props.session.accountRateLimits()),
  );
  const state = () => props.session.accountRateLimitsState();

  return (
    <Show when={state() !== "idle"}>
      <Switch>
        <Match when={state() === "loading" && exhaustion() === null}>
          <section
            aria-label="Carregando uso da conta"
            class="account-usage-card account-usage-loading"
          >
            <span class="usage-skeleton usage-skeleton-title" />
            <span class="usage-skeleton usage-skeleton-copy" />
            <span class="usage-skeleton usage-skeleton-progress" />
          </section>
        </Match>
        <Match when={state() === "failed" && exhaustion() === null}>
          <UsageFailure
            onRetry={() => {
              void props.session.refreshAccountRateLimits().catch(() => undefined);
            }}
          />
        </Match>
        <Match
          when={
            state() === "ready"
            && summary() !== null
            && exhaustion() === null
          }
        >
          <UsageSnapshot summary={summary()!} />
        </Match>
      </Switch>
    </Show>
  );
}

function UsageSnapshot(props: { summary: AccountUsageSummary }) {
  const resetDescription = () => formatResetDescription(props.summary);
  return (
    <section class="account-usage-card" aria-label="Uso da conta ChatGPT">
      <strong>{props.summary.remainingPercent}% de uso restante</strong>
      <p>{resetDescription()}</p>
      <div
        aria-label={`${props.summary.usedPercent}% do limite usado`}
        aria-valuemax="100"
        aria-valuemin="0"
        aria-valuenow={props.summary.usedPercent}
        class="account-usage-progress"
        role="progressbar"
      >
        <span style={{ width: `${props.summary.usedPercent}%` }} />
      </div>
    </section>
  );
}

function UsageFailure(props: { onRetry: () => void }) {
  return (
    <section aria-live="polite" class="account-usage-card account-usage-failed">
      <strong>Uso indisponível</strong>
      <p>Não foi possível consultar os limites da conta.</p>
      <button onClick={props.onRetry} type="button">
        Tentar novamente
      </button>
    </section>
  );
}

function formatResetDescription(summary: AccountUsageSummary): string {
  const reset = formatUsageResetTime(summary.resetsAt);
  return reset === null
    ? summary.cadence
    : `${summary.cadence} · Próxima renovação em ${reset}`;
}
