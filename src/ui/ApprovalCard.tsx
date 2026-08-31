import { createSignal, Show } from "solid-js";

import type {
  ApprovalDecision,
  BrowserOriginApprovalServerRequest,
  CommandApprovalServerRequest,
  EngineServerRequest,
} from "../contracts/types";
import { useI18n } from "../i18n/context";
import type { AppController } from "../state/appController";

type ApprovalCardController = Pick<AppController, "approvals" | "respondToApproval">;

import { Icon } from "./Icon";

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
  switch (props.request.method) {
    case "approval.command":
      return <CommandApproval controller={props.controller} request={props.request} />;
    case "approval.browserOrigin":
      return <BrowserOriginApproval controller={props.controller} request={props.request} />;
  }
}

function CommandApproval(props: {
  readonly controller: ApprovalCardController;
  readonly request: CommandApprovalServerRequest;
}) {
  const i18n = useI18n();
  const [responding, setResponding] = createSignal(false);

  async function decide(decision: ApprovalDecision): Promise<void> {
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
          <p class="eyebrow">{i18n.messages().approval.eyebrow}</p>
          <h3 id={`approval-${props.request.id}`}>{i18n.messages().approval.commandTitle}</h3>
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
          {i18n.messages().common.cancelTurn}
        </button>
        <button disabled={responding()} onClick={() => void decide("decline")} type="button">
          {i18n.messages().common.decline}
        </button>
        <button
          disabled={responding()}
          onClick={() => void decide("acceptForSession")}
          type="button"
        >
          {i18n.messages().approval.allowForTask}
        </button>
        <button
          class="primary-button"
          disabled={responding()}
          onClick={() => void decide("accept")}
          type="button"
        >
          {i18n.messages().approval.runOnce}
        </button>
      </footer>
    </section>
  );
}

function BrowserOriginApproval(props: {
  readonly controller: ApprovalCardController;
  readonly request: BrowserOriginApprovalServerRequest;
}) {
  const i18n = useI18n();
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
          <Icon name="globe" size={18} />
        </span>
        <div>
          <p class="eyebrow">{i18n.messages().approval.eyebrow}</p>
          <h3 id={`approval-${props.request.id}`}>{i18n.messages().approval.browserTitle}</h3>
        </div>
        <Show when={props.controller.approvals().length > 1}>
          <span class="approval-count">+{props.controller.approvals().length - 1}</span>
        </Show>
      </header>
      <p>{props.request.params.reason}</p>
      <pre class="approval-command">{props.request.params.origin}</pre>
      <small>{i18n.messages().approval.browserDescription}</small>
      <footer>
        <button disabled={responding()} onClick={() => void decide("cancel")} type="button">
          {i18n.messages().common.cancelTurn}
        </button>
        <button disabled={responding()} onClick={() => void decide("decline")} type="button">
          {i18n.messages().common.decline}
        </button>
        <button
          class="primary-button"
          disabled={responding()}
          onClick={() => void decide("accept")}
          type="button"
        >
          {i18n.messages().approval.allowOnce}
        </button>
      </footer>
    </section>
  );
}
