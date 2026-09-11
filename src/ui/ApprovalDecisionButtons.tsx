import { For } from "solid-js";

import { approvalDecisionsFor } from "../contracts/approval";
import type { ApprovalDecision, EngineServerRequest } from "../contracts/types";
import { useI18n } from "../i18n/context";
import type { TranslationMessages } from "../i18n/messages";

export function ApprovalDecisionButtons(props: {
  readonly buttonClass?: string;
  readonly disabled: boolean;
  readonly onDecision: (decision: ApprovalDecision) => void;
  readonly request: EngineServerRequest;
}) {
  const i18n = useI18n();
  const decisions = () => approvalDecisionsFor(props.request);

  return (
    <For each={decisions()}>
      {(decision) => (
        <button
          class={decision === "accept" ? primaryClass(props.buttonClass) : props.buttonClass}
          disabled={props.disabled}
          onClick={() => props.onDecision(decision)}
          type="button"
        >
          {decisionLabel(decision, props.request.method, i18n.messages())}
        </button>
      )}
    </For>
  );
}

function primaryClass(buttonClass: string | undefined): string {
  return buttonClass === undefined ? "primary-button" : `${buttonClass} primary-button`;
}

function decisionLabel(
  decision: ApprovalDecision,
  method: EngineServerRequest["method"],
  messages: TranslationMessages,
): string {
  switch (decision) {
    case "cancel":
      return messages.common.cancelTurn;
    case "decline":
      return messages.common.decline;
    case "acceptForSession":
      return messages.approval.allowForTask;
    case "accept":
      return method === "approval.command"
        ? messages.approval.runOnce
        : messages.approval.allowOnce;
  }
}
