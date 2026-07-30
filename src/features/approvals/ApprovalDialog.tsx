import { Show } from "solid-js";

import type {
  ApprovalDecision,
  CodexSession,
} from "../session/createCodexSession";
import {
  isJsonObject,
  readString,
  type CodexServerRequest,
  type JsonObject,
  type JsonValue,
} from "../../shared/codex/types";

interface ApprovalDialogProps {
  request: CodexServerRequest;
  session: CodexSession;
}

export function ApprovalDialog(props: ApprovalDialogProps) {
  const supported = () =>
    props.request.method === "item/commandExecution/requestApproval" ||
    props.request.method === "item/fileChange/requestApproval";
  const params = () => asObject(props.request.params);
  const title = () =>
    props.request.method === "item/fileChange/requestApproval"
      ? "Permitir alteração de arquivos?"
      : props.request.method === "item/commandExecution/requestApproval"
        ? "Permitir execução?"
        : "O Codex precisa da sua resposta";
  const detail = () => requestDetail(props.request.method, params());

  function decide(decision: ApprovalDecision) {
    void props.session.respondToApproval(props.request, decision);
  }

  return (
    <div class="modal-backdrop" role="presentation">
      <section aria-labelledby="approval-title" aria-modal="true" class="approval-dialog" role="dialog">
        <p class="eyebrow">APROVAÇÃO</p>
        <h2 id="approval-title">{title()}</h2>
        <Show when={readString(params(), "reason")}>
          {(reason) => <p class="approval-reason">{reason()}</p>}
        </Show>
        <pre>{detail()}</pre>
        <Show
          when={supported()}
          fallback={
            <div class="approval-actions">
              <button
                class="secondary-button"
                onClick={() => void props.session.interruptPendingRequest(props.request)}
                type="button"
              >
                Interromper tarefa
              </button>
            </div>
          }
        >
          <div class="approval-actions approval-actions-split">
            <div>
              <button class="ghost-button" onClick={() => decide("cancel")} type="button">
                Cancelar tarefa
              </button>
              <button class="secondary-button" onClick={() => decide("decline")} type="button">
                Recusar
              </button>
            </div>
            <div>
              <button
                class="secondary-button"
                onClick={() => decide("acceptForSession")}
                type="button"
              >
                Permitir nesta sessão
              </button>
              <button class="primary-button" onClick={() => decide("accept")} type="button">
                Permitir
              </button>
            </div>
          </div>
        </Show>
      </section>
    </div>
  );
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function requestDetail(method: string, params: JsonObject | undefined): string {
  if (method === "item/commandExecution/requestApproval") {
    const command = params?.command;
    if (typeof command === "string") {
      return command;
    }
    if (Array.isArray(command)) {
      return command.filter((part): part is string => typeof part === "string").join(" ");
    }
  }
  if (method === "item/fileChange/requestApproval") {
    return readString(params, "grantRoot") ?? "Alterar os arquivos apresentados no turno.";
  }
  return JSON.stringify(params ?? {}, null, 2);
}
