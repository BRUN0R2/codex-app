import { Show } from "solid-js";

import type { TurnProgressSummary } from "./createTurnProgress";

interface TurnProgressProps {
  busy: boolean;
  progress: TurnProgressSummary | null;
}

export function TurnProgress(props: TurnProgressProps) {
  return (
    <Show when={props.busy ? props.progress : null}>
      {(progress) => (
        <div class="turn-progress">
          <span class="turn-progress-spinner" />
          <Show when={progress().currentStep !== null}>
            <span>
              Passo {progress().currentStep}/{progress().totalSteps}
            </span>
          </Show>
          <Show
            when={progress().currentStep !== null && progress().fileCount > 0}
          >
            <span class="turn-progress-separator">·</span>
          </Show>
          <Show when={progress().fileCount > 0}>
            <span>
              {progress().fileCount} arquivo
              {progress().fileCount === 1 ? " alterado" : "s alterados"}
            </span>
            <span class="diff-additions">+{progress().additions}</span>
            <span class="diff-deletions">−{progress().deletions}</span>
          </Show>
        </div>
      )}
    </Show>
  );
}
