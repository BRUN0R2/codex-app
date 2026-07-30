import { For, Show, createMemo, createSignal } from "solid-js";

import { buildGrantedPermissions, permissionGrantOptions } from "./permissionGrants";
import { RequestFrame } from "./RequestFrame";
import type { InteractiveRequestPanelProps } from "./InteractiveRequestPanel";
import type { PermissionGrantScope } from "./permissionTypes";
import type { PermissionsApprovalRequest } from "./serverRequestTypes";

interface PermissionsRequestPanelProps {
  onRespond: InteractiveRequestPanelProps["onRespond"];
  pendingCount: number;
  request: PermissionsApprovalRequest;
}

export function PermissionsRequestPanel(props: PermissionsRequestPanelProps) {
  const options = createMemo(() => permissionGrantOptions(props.request.permissions));
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [scope, setScope] = createSignal<PermissionGrantScope>("turn");
  const [strictAutoReview, setStrictAutoReview] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);

  function toggle(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  function chooseScope(value: PermissionGrantScope) {
    setScope(value);
    if (value === "session") {
      setStrictAutoReview(false);
    }
  }

  async function respond(grantSelected: boolean) {
    setSubmitting(true);
    const selectedIds = grantSelected ? selected() : new Set<string>();
    const resolved = await props.onRespond(props.request, {
      permissions: buildGrantedPermissions(props.request.permissions, selectedIds),
      scope: grantSelected ? scope() : "turn",
      ...(grantSelected && scope() === "turn" && strictAutoReview()
        ? { strictAutoReview: true }
        : {}),
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
            class="secondary-button"
            disabled={submitting()}
            onClick={() => void respond(false)}
            type="button"
          >
            Recusar
          </button>
          <button
            class="primary-button request-action-push"
            disabled={submitting() || selected().size === 0}
            onClick={() => void respond(true)}
            type="button"
          >
            Permitir selecionadas
          </button>
        </>
      }
      eyebrow="PERMISSÕES ADICIONAIS"
      pendingCount={props.pendingCount}
      subtitle={props.request.reason}
      title="Escolha exatamente o que liberar"
    >
      <div class="request-context-grid">
        <span>
          <small>Diretório</small>
          {props.request.cwd}
        </span>
        <Show when={props.request.environmentId}>
          {(environment) => (
            <span>
              <small>Ambiente</small>
              {environment()}
            </span>
          )}
        </Show>
      </div>
      <Show
        when={options().length > 0}
        fallback={<p class="request-empty">Nenhuma permissão concedível foi solicitada.</p>}
      >
        <div class="permission-grant-list">
          <For each={options()}>
            {(option) => (
              <label class="permission-grant-option">
                <input
                  checked={selected().has(option.id)}
                  onChange={(event) => toggle(option.id, event.currentTarget.checked)}
                  type="checkbox"
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.detail}</small>
                </span>
              </label>
            )}
          </For>
        </div>
      </Show>
      <Show when={selected().size > 0}>
        <div class="permission-scope">
          <p>Manter a liberação por quanto tempo?</p>
          <div role="radiogroup" aria-label="Duração da permissão">
            <label>
              <input
                checked={scope() === "turn"}
                name="permission-scope"
                onChange={() => chooseScope("turn")}
                type="radio"
              />
              Somente neste turno
            </label>
            <label>
              <input
                checked={scope() === "session"}
                name="permission-scope"
                onChange={() => chooseScope("session")}
                type="radio"
              />
              Nesta sessão
            </label>
          </div>
          <Show when={scope() === "turn"}>
            <label class="strict-review-option">
              <input
                checked={strictAutoReview()}
                onChange={(event) => setStrictAutoReview(event.currentTarget.checked)}
                type="checkbox"
              />
              Revisar todos os comandos seguintes deste turno
            </label>
          </Show>
        </div>
      </Show>
    </RequestFrame>
  );
}
