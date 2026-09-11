import { createSignal, Show } from "solid-js";

import type { ApprovalDecision, EngineServerRequest } from "../contracts/types";
import { useI18n } from "../i18n/context";
import type { AppController } from "../state/appController";
import { ApprovalDecisionButtons } from "./ApprovalDecisionButtons";
import { ApprovalRequestDetails } from "./ApprovalRequestDetails";
import { Icon } from "./Icon";

type ApprovalCardController = Pick<AppController, "approvals" | "respondToApproval">;

export function ApprovalCard(props: { readonly controller: ApprovalCardController }) {
  return (
    <Show when={props.controller.approvals()[0]}>
      {(request) => <ApprovalRequest controller={props.controller} request={request()} />}
    </Show>
  );
}

function ApprovalRequest(props: {
  readonly controller: ApprovalCardController;
  readonly request: EngineServerRequest;
}) {
  const i18n = useI18n();
  const [responding, setResponding] = createSignal(false);
  const commandApproval = () => props.request.method === "approval.command";

  async function decide(decision: ApprovalDecision): Promise<void> {
    setResponding(true);
    await props.controller.respondToApproval(props.request.id, decision);
    setResponding(false);
  }

  return (
    <section class="approval-card" aria-labelledby={`approval-${props.request.id}`}>
      <header>
        <span class="approval-shield">
          <Icon name={commandApproval() ? "shield" : "globe"} size={18} />
        </span>
        <div>
          <p class="eyebrow">{i18n.messages().approval.eyebrow}</p>
          <h3 id={`approval-${props.request.id}`}>
            {commandApproval()
              ? i18n.messages().approval.commandTitle
              : i18n.messages().approval.browserTitle}
          </h3>
        </div>
        <Show when={props.controller.approvals().length > 1}>
          <span class="approval-count">+{props.controller.approvals().length - 1}</span>
        </Show>
      </header>
      <ApprovalRequestDetails request={props.request} />
      <footer>
        <ApprovalDecisionButtons
          disabled={responding()}
          onDecision={(decision) => void decide(decision)}
          request={props.request}
        />
      </footer>
    </section>
  );
}
