import { createMemo, type JSX, Show } from "solid-js";

import type { ContextUsageItem } from "../contracts/types";
import { useI18n } from "../i18n/context";
import { formatMessage } from "../i18n/messages";
import { calculateContextWindowMetrics, formatContextTokens } from "./contextWindowMetrics";

interface ContextWindowIndicatorProps {
  readonly usage: ContextUsageItem | null;
}

export function ContextWindowIndicator(props: ContextWindowIndicatorProps): JSX.Element {
  const i18n = useI18n();
  const messages = () => i18n.messages().contextWindow;
  const metrics = createMemo(() => calculateContextWindowMetrics(props.usage));
  const usedPercent = () => metrics()?.usedPercent ?? 0;
  const remainingPercent = () => metrics()?.remainingPercent ?? 0;
  const radius: number = 5;
  const circumference: number = 2 * Math.PI * radius;
  const strokeDashoffset = () => (circumference * (100 - usedPercent())) / 100;
  const roundedUsedPercent = () => Math.round(usedPercent());
  const statusLabel = () =>
    roundedUsedPercent() >= 50
      ? formatMessage(messages().fullStatus, { percent: roundedUsedPercent() })
      : formatMessage(messages().usedStatus, {
          percent: roundedUsedPercent(),
          remaining: remainingPercent(),
        });

  return (
    <Show when={metrics()} fallback={null}>
      {(current) => (
        <div
          aria-label={formatMessage(messages().usage, { percent: roundedUsedPercent() })}
          class="composer-context-ring-anchor"
          classList={{ full: roundedUsedPercent() >= 100 }}
          role="img"
        >
          <span aria-hidden="true" class="composer-context-ring-icon">
            <svg class="composer-context-ring-svg" height={12} viewBox="0 0 12 12" width={12}>
              <title>{messages().title}</title>
              <circle
                class="composer-context-ring-track"
                cx={6}
                cy={6}
                fill="none"
                r={radius}
                stroke="currentColor"
                stroke-width={2}
              />
              <circle
                class="composer-context-ring-progress"
                cx={6}
                cy={6}
                fill="none"
                r={radius}
                stroke="currentColor"
                stroke-linecap="round"
                stroke-width={2}
                stroke-dasharray={`${circumference} ${circumference}`}
                stroke-dashoffset={strokeDashoffset()}
                transform="rotate(-90 6 6)"
              />
            </svg>
          </span>
          <div class="context-window-popover" role="tooltip">
            <div class="context-window-popover-title">{messages().window}</div>
            <div class="context-window-popover-percent">{statusLabel()}</div>
            <div class="context-window-popover-tokens">
              {formatMessage(messages().tokensUsed, {
                used: formatContextTokens(current().usedTokens),
                total: formatContextTokens(current().usableContextWindow),
              })}
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
