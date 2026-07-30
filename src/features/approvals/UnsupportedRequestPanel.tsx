import { createSignal } from "solid-js";

import { RequestFrame } from "./RequestFrame";
import type { InteractiveRequestPanelProps } from "./InteractiveRequestPanel";
import type { UnsupportedServerRequest } from "./serverRequestTypes";

interface UnsupportedRequestPanelProps {
  onInterrupt: InteractiveRequestPanelProps["onInterrupt"];
  pendingCount: number;
  request: UnsupportedServerRequest;
}

export function UnsupportedRequestPanel(props: UnsupportedRequestPanelProps) {
  const [submitting, setSubmitting] = createSignal(false);

  async function interrupt() {
    setSubmitting(true);
    await props.onInterrupt(props.request);
    setSubmitting(false);
  }

  return (
    <RequestFrame
      actions={
        <button
          class="secondary-button request-action-push"
          disabled={submitting()}
          onClick={() => void interrupt()}
          type="button"
        >
          Interromper tarefa com segurança
        </button>
      }
      eyebrow="INCOMPATIBILIDADE DE PROTOCOLO"
      pendingCount={props.pendingCount}
      subtitle={props.request.error}
      title="Esta solicitação não pode ser apresentada"
    >
      <p class="request-command">{props.request.method}</p>
      <p class="request-empty">
        Nenhum dado bruto ou segredo da solicitação foi colocado na interface.
      </p>
    </RequestFrame>
  );
}
