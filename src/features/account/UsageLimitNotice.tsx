import { Show, createMemo } from "solid-js";

import { ClockIcon, RefreshIcon } from "../../shared/components/Icons";
import type { CodexSession } from "../session/createCodexSession";
import {
  findAccountUsageExhaustion,
  formatUsageResetTime,
} from "./accountUsage";

interface UsageLimitNoticeProps {
  session: Pick<
    CodexSession,
    | "accountRateLimits"
    | "accountRateLimitsState"
    | "refreshAccountRateLimits"
  >;
}

export function UsageLimitNotice(props: UsageLimitNoticeProps) {
  const exhaustion = createMemo(() =>
    findAccountUsageExhaustion(props.session.accountRateLimits()),
  );

  return (
    <Show when={exhaustion()}>
      {(limit) => (
        <section aria-live="polite" class="usage-limit-notice">
          <ClockIcon size={18} />
          <div class="usage-limit-copy">
            <strong>Você esgotou o uso do Codex</strong>
            <p>
              {props.session.accountRateLimitsState() === "failed"
                ? describeRefreshFailure(limit().resetsAt)
                : describeExhaustion(limit().resetsAt)}
            </p>
          </div>
          <button
            disabled={props.session.accountRateLimitsState() === "loading"}
            onClick={() => {
              void props.session.refreshAccountRateLimits().catch(() => undefined);
            }}
            type="button"
          >
            <RefreshIcon size={14} />
            Verificar novamente
          </button>
        </section>
      )}
    </Show>
  );
}

function describeExhaustion(resetsAt: number | null): string {
  const reset = formatUsageResetTime(resetsAt);
  return reset === null
    ? "O limite de uso atual da conta foi atingido."
    : `Aguarde a redefinição do uso em ${reset}.`;
}

function describeRefreshFailure(resetsAt: number | null): string {
  const previous = describeExhaustion(resetsAt);
  return `Não foi possível atualizar agora. ${previous}`;
}
