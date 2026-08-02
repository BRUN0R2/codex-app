import { createMemo, Show } from "solid-js";

import type { ContextUsageItem } from "../contracts/types";
import { calculateContextWindowMetrics, formatContextTokens } from "./contextWindowMetrics";

export interface ContextWindowIndicatorProps {
  readonly usage: ContextUsageItem | null;
}

export function ContextWindowIndicator(props: ContextWindowIndicatorProps) {
  const metrics = createMemo(() => calculateContextWindowMetrics(props.usage));

  return (
    <Show when={metrics()}>
      {(value) => {
        const roundedPercent = () => Math.round(value().percent);
        return (
          <span class="context-window-control">
            <span
              aria-describedby="context-window-tooltip"
              aria-label={`Uso do contexto: ${roundedPercent()}%`}
              class="context-window-indicator"
              role="img"
            >
              <svg aria-hidden="true" class="context-window-ring" viewBox="0 0 12 12">
                <circle
                  class="context-window-track"
                  cx="6"
                  cy="6"
                  fill="none"
                  r="5"
                  stroke="currentColor"
                  stroke-width="2"
                />
                <circle
                  class="context-window-progress"
                  cx="6"
                  cy="6"
                  fill="none"
                  opacity={value().percent === 0 ? 0 : 1}
                  pathLength={100}
                  r="5"
                  stroke="currentColor"
                  stroke-dasharray="100"
                  stroke-dashoffset={100 - value().percent}
                  stroke-linecap="round"
                  stroke-width="2"
                  transform="rotate(-90 6 6)"
                />
              </svg>
            </span>
            <span class="context-window-tooltip" id="context-window-tooltip" role="tooltip">
              <span>Janela de contexto:</span>
              <span classList={{ warning: roundedPercent() >= 50 }}>
                {roundedPercent() >= 50
                  ? `${roundedPercent()}% cheia`
                  : `${roundedPercent()}% usada (${value().remainingPercent}% restante)`}
              </span>
              <span>
                {formatContextTokens(value().usedTokens)}k /{" "}
                {formatContextTokens(value().contextWindow)}k tokens usados
              </span>
            </span>
          </span>
        );
      }}
    </Show>
  );
}
