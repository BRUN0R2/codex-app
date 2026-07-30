import { For, Show, createMemo, createSignal } from "solid-js";

import { DiffView } from "../chat/DiffView";
import type { FileChangeEntry, TimelineEntry } from "../chat/timelineTypes";
import { permissionGrantOptions } from "./permissionGrants";
import { RequestFrame } from "./RequestFrame";
import type { InteractiveRequestPanelProps } from "./InteractiveRequestPanel";
import type {
  CommandApprovalDecision,
  CommandApprovalRequest,
  FileChangeApprovalRequest,
} from "./serverRequestTypes";

interface ApprovalRequestPanelProps {
  onRespond: InteractiveRequestPanelProps["onRespond"];
  pendingCount: number;
  request: CommandApprovalRequest | FileChangeApprovalRequest;
  timeline: TimelineEntry[];
}

export function ApprovalRequestPanel(props: ApprovalRequestPanelProps) {
  return props.request.kind === "commandApproval" ? (
    <CommandApprovalPanel
      onRespond={props.onRespond}
      pendingCount={props.pendingCount}
      request={props.request}
    />
  ) : (
    <FileApprovalPanel
      onRespond={props.onRespond}
      pendingCount={props.pendingCount}
      request={props.request}
      timeline={props.timeline}
    />
  );
}

function CommandApprovalPanel(props: {
  onRespond: InteractiveRequestPanelProps["onRespond"];
  pendingCount: number;
  request: CommandApprovalRequest;
}) {
  const [submitting, setSubmitting] = createSignal(false);
  const decisions = createMemo(() => commandDecisions(props.request));
  const permissionOptions = createMemo(() =>
    props.request.additionalPermissions === null
      ? []
      : permissionGrantOptions(props.request.additionalPermissions),
  );

  async function decide(decision: CommandApprovalDecision) {
    setSubmitting(true);
    const resolved = await props.onRespond(props.request, { decision });
    if (!resolved) {
      setSubmitting(false);
    }
  }

  return (
    <RequestFrame
      actions={
        <For each={decisions()}>
          {(decision) => (
            <button
              class={decisionClass(decision)}
              disabled={submitting()}
              onClick={() => void decide(decision)}
              type="button"
            >
              {decisionLabel(decision)}
            </button>
          )}
        </For>
      }
      eyebrow="APROVAÇÃO DE COMANDO"
      pendingCount={props.pendingCount}
      subtitle={props.request.reason}
      title={
        props.request.networkApprovalContext === null
          ? "Permitir esta execução?"
          : `Permitir acesso a ${props.request.networkApprovalContext.host}?`
      }
    >
      <Show when={props.request.command}>
        {(command) => <pre class="request-command">{command()}</pre>}
      </Show>
      <Show when={props.request.cwd}>
        {(cwd) => <p class="request-context">Diretório de trabalho · {cwd()}</p>}
      </Show>
      <Show when={props.request.commandActions.length > 0}>
        <div class="request-summary-list">
          <For each={props.request.commandActions}>
            {(action) => (
              <div>
                <strong>{commandActionLabel(action.type)}</strong>
                <span>{action.name ?? action.query ?? action.path ?? action.command}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={permissionOptions().length > 0}>
        <div class="request-permission-preview">
          <p>Permissões adicionais desta execução</p>
          <For each={permissionOptions()}>
            {(option) => (
              <div>
                <strong>{option.label}</strong>
                <span>{option.detail}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </RequestFrame>
  );
}

function FileApprovalPanel(props: {
  onRespond: InteractiveRequestPanelProps["onRespond"];
  pendingCount: number;
  request: FileChangeApprovalRequest;
  timeline: TimelineEntry[];
}) {
  const [submitting, setSubmitting] = createSignal(false);
  const fileChange = createMemo(() => findFileChange(props.timeline, props.request.itemId));

  async function decide(
    decision: "accept" | "acceptForSession" | "cancel" | "decline",
  ) {
    setSubmitting(true);
    const resolved = await props.onRespond(props.request, { decision });
    if (!resolved) {
      setSubmitting(false);
    }
  }

  return (
    <RequestFrame
      actions={
        <>
          <button
            class="ghost-button"
            disabled={submitting()}
            onClick={() => void decide("cancel")}
            type="button"
          >
            Cancelar tarefa
          </button>
          <button
            class="secondary-button"
            disabled={submitting()}
            onClick={() => void decide("decline")}
            type="button"
          >
            Recusar
          </button>
          <button
            class="secondary-button request-action-push"
            disabled={submitting()}
            onClick={() => void decide("acceptForSession")}
            type="button"
          >
            Permitir na sessão
          </button>
          <button
            class="primary-button"
            disabled={submitting()}
            onClick={() => void decide("accept")}
            type="button"
          >
            Permitir
          </button>
        </>
      }
      eyebrow="APROVAÇÃO DE ARQUIVOS"
      pendingCount={props.pendingCount}
      subtitle={props.request.reason}
      title="Aplicar estas alterações?"
    >
      <Show when={props.request.grantRoot}>
        {(root) => (
          <p class="request-context">Acesso de escrita solicitado · {root()}</p>
        )}
      </Show>
      <Show
        when={fileChange()}
        fallback={<p class="request-empty">O diff ainda não está disponível.</p>}
      >
        {(entry) => (
          <div class="request-diff-list">
            <For each={entry().changes}>
              {(change) => (
                <details>
                  <summary>
                    <span>{change.path}</span>
                    <small>{changeKindLabel(change.kind)}</small>
                  </summary>
                  <DiffView diff={change.diff} />
                </details>
              )}
            </For>
          </div>
        )}
      </Show>
    </RequestFrame>
  );
}

function commandDecisions(request: CommandApprovalRequest): CommandApprovalDecision[] {
  if (request.availableDecisions !== null) {
    return request.availableDecisions;
  }
  const decisions: CommandApprovalDecision[] = ["cancel", "decline"];
  if (request.proposedExecpolicyAmendment !== null) {
    decisions.push({
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: request.proposedExecpolicyAmendment,
      },
    });
  }
  for (const amendment of request.proposedNetworkPolicyAmendments) {
    decisions.push({
      applyNetworkPolicyAmendment: { network_policy_amendment: amendment },
    });
  }
  decisions.push("acceptForSession", "accept");
  return decisions;
}

function decisionLabel(decision: CommandApprovalDecision): string {
  if (typeof decision === "string") {
    return {
      accept: "Permitir",
      acceptForSession: "Permitir na sessão",
      cancel: "Cancelar tarefa",
      decline: "Recusar",
    }[decision];
  }
  if ("acceptWithExecpolicyAmendment" in decision) {
    return "Permitir e lembrar comando";
  }
  return decision.applyNetworkPolicyAmendment.network_policy_amendment.action === "allow"
    ? "Permitir e lembrar domínio"
    : "Aplicar bloqueio de domínio";
}

function decisionClass(decision: CommandApprovalDecision): string {
  if (decision === "accept") {
    return "primary-button";
  }
  if (decision === "cancel") {
    return "ghost-button";
  }
  return "secondary-button";
}

function findFileChange(
  timeline: TimelineEntry[],
  itemId: string,
): FileChangeEntry | undefined {
  return timeline.find(
    (entry): entry is FileChangeEntry =>
      entry.type === "fileChange" && entry.id === itemId,
  );
}

function commandActionLabel(type: string): string {
  return {
    listFiles: "Listar arquivos",
    read: "Ler arquivo",
    search: "Pesquisar",
    unknown: "Executar comando",
  }[type] ?? "Executar comando";
}

function changeKindLabel(kind: FileChangeEntry["changes"][number]["kind"]): string {
  return { add: "Novo", delete: "Excluir", update: "Alterar" }[kind];
}
