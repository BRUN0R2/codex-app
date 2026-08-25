import { createMemo, For, Show } from "solid-js";

import type { FileChange, PlanItem, PlanStepStatus } from "../contracts/types";

import { Icon } from "./Icon";
import { ReviewStatisticsStore } from "./reviewChanges";

const POPOVER_ID = "active-plan-popover";
const REVIEW_PANEL_ID = "turn-review-panel";

interface TurnProgressProps {
  readonly changes: readonly FileChange[];
  readonly onToggleReview: () => void;
  readonly plan: PlanItem | null;
  readonly reviewOpen: boolean;
}

export function TurnProgress(props: TurnProgressProps) {
  const reviewStatistics = new ReviewStatisticsStore();
  const currentStepIndex = createMemo(() => {
    const plan = props.plan;
    if (plan === null) {
      return null;
    }
    const active = plan.steps.findIndex((step) => step.status === "inProgress");
    if (active >= 0) {
      return active;
    }
    const pending = plan.steps.findIndex((step) => step.status === "pending");
    return pending >= 0 ? pending : Math.max(0, plan.steps.length - 1);
  });
  const reviewStats = createMemo(() => reviewStatistics.summarize(props.changes));

  return (
    <div class="plan-progress">
      <div class="plan-progress-pill">
        <Show when={props.plan}>
          {(plan) => (
            <div class="plan-progress-plan">
              <span aria-hidden="true" class="plan-progress-current-mark" />
              <span>
                Passo {(currentStepIndex() ?? 0) + 1} / {plan().steps.length}
              </span>
              <section
                aria-label="Plano de trabalho"
                class="plan-progress-popover"
                id={POPOVER_ID}
                role="tooltip"
              >
                <ol>
                  <For each={plan().steps}>
                    {(step) => (
                      <li
                        aria-current={step.status === "inProgress" ? "step" : undefined}
                        data-status={step.status}
                      >
                        <PlanStatusMark status={step.status} />
                        <span>{step.step}</span>
                      </li>
                    )}
                  </For>
                </ol>
              </section>
            </div>
          )}
        </Show>

        <Show when={props.changes.length > 0}>
          <button
            aria-controls={REVIEW_PANEL_ID}
            aria-expanded={props.reviewOpen}
            class="plan-review-trigger"
            onClick={props.onToggleReview}
            title={props.reviewOpen ? "Fechar revisão" : "Revisar arquivos alterados"}
            type="button"
          >
            <span>
              {reviewStats().fileCount}{" "}
              {reviewStats().fileCount === 1 ? "arquivo alterado" : "arquivos alterados"}
            </span>
            <span class="plan-review-additions">+{reviewStats().additions}</span>
            <span class="plan-review-deletions">−{reviewStats().deletions}</span>
          </button>
        </Show>
      </div>
    </div>
  );
}

function PlanStatusMark(props: { readonly status: PlanStepStatus }) {
  return (
    <span aria-hidden="true" class="plan-status-mark" data-status={props.status}>
      <Show when={props.status === "completed"}>
        <Icon name="check" size={10} strokeWidth={2.5} />
      </Show>
    </span>
  );
}
