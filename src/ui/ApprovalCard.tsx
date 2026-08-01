import { createSignal, Show } from "solid-js";

import type { EngineServerRequest } from "../contracts/types";
import type { AppController } from "../state/createAppController";
import { Icon } from "./Icon";

export function ApprovalCard(props: { readonly controller: AppController }) {
  return (
    <Show when={props.controller.approvals()[0]}>
      {(request) => <CommandApproval controller={props.controller} request={request()} />}
    </Show>
  );
}

function CommandApproval(props: {
  readonly controller: AppController;
  readonly request: EngineServerRequest;
}) {
  const [responding, setResponding] = createSignal(false);

  async function decide(decision: "accept" | "cancel" | "decline"): Promise<void> {
    setResponding(true);
    await props.controller.respondToApproval(props.request.id, decision);
    setResponding(false);
  }

  return (
    <section class="approval-card" aria-labelledby={`approval-${props.request.id}`}>
      <header>
        <span class="approval-shield">
          <Icon name="shield" size={18} />
        </span>
        <div>
          <p class="eyebrow">Aprovação necessária</p>
          <h3 id={`approval-${props.request.id}`}>Executar este comando?</h3>
        </div>
        <Show when={props.controller.approvals().length > 1}>
          <span class="approval-count">+{props.controller.approvals().length - 1}</span>
        </Show>
      </header>
      <p>{props.request.params.reason}</p>
      <pre class="approval-command">{props.request.params.command}</pre>
      <small>{props.request.params.cwd}</small>
      <footer>
        <button disabled={responding()} onClick={() => void decide("cancel")} type="button">
          Cancelar turno
        </button>
        <button disabled={responding()} onClick={() => void decide("decline")} type="button">
          Recusar
        </button>
        <button
          class="primary-button"
          disabled={responding()}
          onClick={() => void decide("accept")}
          type="button"
        >
          Executar uma vez
        </button>
      </footer>
    </section>
  );
}
