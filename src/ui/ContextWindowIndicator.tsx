import { createMemo, type JSX, Show } from "solid-js";

import type { ContextUsageItem, ModelContextWindow } from "../contracts/types";
import { calculateContextWindowMetrics, formatContextTokens } from "./contextWindowMetrics";

interface ContextWindowIndicatorProps {
  readonly modelWindow: ModelContextWindow | null;
  readonly usage: ContextUsageItem | null;
}

export function ContextWindowIndicator(props: ContextWindowIndicatorProps): JSX.Element {
  const metrics = createMemo(() => calculateContextWindowMetrics(props.usage, props.modelWindow));
  const percent = () => metrics()?.percent ?? 0;
  const remainingPercent = () => metrics()?.remainingPercent ?? 0;
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = () => (circumference * remainingPercent()) / 100;
  const roundedPercent = () => Math.round(percent());
  const statusLabel = () =>
    roundedPercent() >= 50
      ? `${roundedPercent()}% cheia`
      : `${roundedPercent()}% usado (${Math.round(remainingPercent())}% restante)`;

  return (
    <Show when={metrics()} fallback={null}>
      {(current) => (
        <div
          aria-label={`Uso de contexto: ${roundedPercent()}%`}
          class="composer-context-ring-anchor"
          classList={{ full: roundedPercent() >= 100 }}
          role="img"
        >
          <span aria-hidden="true" class="composer-context-ring-icon">
            <svg class="composer-context-ring-svg" height={12} viewBox="0 0 12 12" width={12}>
              <title>Uso de contexto</title>
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
            <div class="context-window-popover-title">Janela de contexto:</div>
            <div class="context-window-popover-percent">{statusLabel()}</div>
            <div class="context-window-popover-tokens">
              {formatContextTokens(current().usedTokens)} /{" "}
              {formatContextTokens(current().contextWindow)} tokens usados
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
