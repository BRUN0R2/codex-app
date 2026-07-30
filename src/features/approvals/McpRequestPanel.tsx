import { Match, Show, Switch, createSignal } from "solid-js";

import { openExternalUrl } from "../../shared/codex/client";
import { McpStructuredForm } from "./McpStructuredForm";
import { RequestFrame } from "./RequestFrame";
import type { InteractiveRequestPanelProps } from "./InteractiveRequestPanel";
import type {
  McpFormRequest,
  McpUnsupportedFormRequest,
  McpUrlRequest,
} from "./serverRequestTypes";

type McpRequest = McpFormRequest | McpUnsupportedFormRequest | McpUrlRequest;

interface McpRequestPanelProps {
  onRespond: InteractiveRequestPanelProps["onRespond"];
  pendingCount: number;
  request: McpRequest;
}

export function McpRequestPanel(props: McpRequestPanelProps) {
  return (
    <Switch>
      <Match when={props.request.kind === "mcpForm" ? props.request : undefined}>
        {(request) =>
          request().fields.length === 0 ? (
            <McpApprovalPanel
              onRespond={props.onRespond}
              pendingCount={props.pendingCount}
              request={request()}
            />
          ) : (
            <McpStructuredForm
              onRespond={props.onRespond}
              pendingCount={props.pendingCount}
              request={request()}
            />
          )
        }
      </Match>
      <Match when={props.request.kind === "mcpUrl" ? props.request : undefined}>
        {(request) => (
          <McpUrlPanel
            onRespond={props.onRespond}
            pendingCount={props.pendingCount}
            request={request()}
          />
        )}
      </Match>
      <Match
        when={props.request.kind === "mcpUnsupportedForm" ? props.request : undefined}
      >
        {(request) => (
          <UnsupportedMcpFormPanel
            onRespond={props.onRespond}
            pendingCount={props.pendingCount}
            request={request()}
          />
        )}
      </Match>
    </Switch>
  );
}

function McpApprovalPanel(props: {
  onRespond: InteractiveRequestPanelProps["onRespond"];
  pendingCount: number;
  request: McpFormRequest;
}) {
  const [submitting, setSubmitting] = createSignal(false);

  async function respond(
    action: "accept" | "cancel" | "decline",
    persist: "always" | "session" | null = null,
  ) {
    setSubmitting(true);
    const resolved = await props.onRespond(props.request, {
      action,
      content:
        action === "accept" && !props.request.isToolApproval ? {} : null,
      _meta: persist === null ? null : { persist },
    });
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
            onClick={() => void respond("cancel")}
            type="button"
          >
            Cancelar
          </button>
          <Show when={!props.request.isToolApproval}>
            <button
              class="secondary-button"
              disabled={submitting()}
              onClick={() => void respond("decline")}
              type="button"
            >
              Recusar
            </button>
          </Show>
          <Show when={props.request.persistModes.includes("always")}>
            <button
              class="secondary-button request-action-push"
              disabled={submitting()}
              onClick={() => void respond("accept", "always")}
              type="button"
            >
              Sempre permitir
            </button>
          </Show>
          <Show when={props.request.persistModes.includes("session")}>
            <button
              class="secondary-button"
              classList={{
                "request-action-push": !props.request.persistModes.includes("always"),
              }}
              disabled={submitting()}
              onClick={() => void respond("accept", "session")}
              type="button"
            >
              Permitir na sessão
            </button>
          </Show>
          <button
            class="primary-button"
            classList={{
              "request-action-push": props.request.persistModes.length === 0,
            }}
            disabled={submitting()}
            onClick={() => void respond("accept")}
            type="button"
          >
            {props.request.isToolApproval ? "Executar ferramenta" : "Permitir"}
          </button>
        </>
      }
      eyebrow={`SOLICITAÇÃO MCP · ${props.request.serverName}`}
      pendingCount={props.pendingCount}
      title={props.request.message}
    >
      <p class="request-empty">
        {props.request.isToolApproval
          ? "O servidor MCP quer executar esta ferramenta. Nenhum campo adicional foi solicitado."
          : "O servidor MCP precisa da sua confirmação para continuar."}
      </p>
    </RequestFrame>
  );
}

function McpUrlPanel(props: {
  onRespond: InteractiveRequestPanelProps["onRespond"];
  pendingCount: number;
  request: McpUrlRequest;
}) {
  const [opened, setOpened] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function openUrl() {
    setError(null);
    try {
      await openExternalUrl(props.request.url);
      setOpened(true);
    } catch (reason) {
      setError(describeError(reason));
    }
  }

  async function respond(action: "accept" | "cancel" | "decline") {
    setSubmitting(true);
    const resolved = await props.onRespond(props.request, {
      action,
      content: null,
      _meta: null,
    });
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
            onClick={() => void respond("cancel")}
            type="button"
          >
            Cancelar
          </button>
          <button
            class="secondary-button"
            disabled={submitting()}
            onClick={() => void respond("decline")}
            type="button"
          >
            Recusar
          </button>
          <button
            class="secondary-button request-action-push"
            disabled={submitting()}
            onClick={() => void openUrl()}
            type="button"
          >
            Abrir link seguro
          </button>
          <button
            class="primary-button"
            disabled={submitting() || !opened()}
            onClick={() => void respond("accept")}
            type="button"
          >
            Concluir
          </button>
        </>
      }
      eyebrow={`AUTORIZAÇÃO MCP · ${props.request.serverName}`}
      pendingCount={props.pendingCount}
      title={props.request.message}
    >
      <p class="request-url">{props.request.url}</p>
      <p class="request-context">
        O link só é aberto após sua ação e apenas protocolos HTTP ou HTTPS são aceitos.
      </p>
      <Show when={error()}>{(message) => <p class="request-error">{message()}</p>}</Show>
    </RequestFrame>
  );
}

function UnsupportedMcpFormPanel(props: {
  onRespond: InteractiveRequestPanelProps["onRespond"];
  pendingCount: number;
  request: McpUnsupportedFormRequest;
}) {
  const [submitting, setSubmitting] = createSignal(false);

  async function cancel() {
    setSubmitting(true);
    const resolved = await props.onRespond(props.request, {
      action: "cancel",
      content: null,
      _meta: null,
    });
    if (!resolved) {
      setSubmitting(false);
    }
  }

  return (
    <RequestFrame
      actions={
        <button
          class="secondary-button request-action-push"
          disabled={submitting()}
          onClick={() => void cancel()}
          type="button"
        >
          Cancelar solicitação
        </button>
      }
      eyebrow={`FORMULÁRIO MCP · ${props.request.serverName}`}
      pendingCount={props.pendingCount}
      subtitle={props.request.explanation}
      title={props.request.message}
    >
      <p class="request-empty">
        O conteúdo opaco não foi mantido no estado da interface. A resposta segura é
        cancelar esta solicitação.
      </p>
    </RequestFrame>
  );
}

function describeError(reason: unknown): string {
  return reason instanceof Error
    ? reason.message
    : "Não foi possível abrir o link no navegador.";
}
