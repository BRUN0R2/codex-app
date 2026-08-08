import { createMemo, For, Show } from "solid-js";

import type { FileChange, PlanItem, PlanStepStatus } from "../contracts/types";

import { Icon } from "./Icon";
import { summarizeReviewChanges } from "./reviewChanges";

const POPOVER_ID = "active-plan-popover";
const REVIEW_PANEL_ID = "turn-review-panel";

interface PlanProgressProps {
  readonly changes: readonly FileChange[];
  readonly onToggleReview: () => void;
  readonly plan: PlanItem;
  readonly reviewOpen: boolean;
}

export function PlanProgress(props: PlanProgressProps) {
  const currentStepIndex = createMemo(() => {
    const active = props.plan.steps.findIndex((step) => step.status === "inProgress");
    if (active >= 0) {
      return active;
    }
    const pending = props.plan.steps.findIndex((step) => step.status === "pending");
    return pending >= 0 ? pending : Math.max(0, props.plan.steps.length - 1);
  });
  const reviewStats = createMemo(() => summarizeReviewChanges(props.changes));

  return (
    <div class="plan-progress">
      <div class="plan-progress-pill">
        <div class="plan-progress-plan">
          <span aria-hidden="true" class="plan-progress-current-mark" />
          <span>
            Passo {currentStepIndex() + 1} / {props.plan.steps.length}
          </span>
          <section
            aria-label="Plano de trabalho"
            class="plan-progress-popover"
            id={POPOVER_ID}
            role="tooltip"
          >
            <Show when={props.plan.explanation}>
              {(explanation) => <p class="plan-progress-explanation">{explanation()}</p>}
            </Show>
            <ol>
              <For each={props.plan.steps}>
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
