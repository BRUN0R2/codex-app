import { For, Match, Show, Switch, createSignal, onMount } from "solid-js";

import {
  buildFormContent,
  initialFormDrafts,
  inputType,
  updateMultiValue,
  type FormDraft,
} from "./mcpFormState";
import { RequestFrame } from "./RequestFrame";
import type { InteractiveRequestPanelProps } from "./InteractiveRequestPanel";
import type { McpFormField, McpFormRequest } from "./serverRequestTypes";

interface McpStructuredFormProps {
  onRespond: InteractiveRequestPanelProps["onRespond"];
  pendingCount: number;
  request: McpFormRequest;
}

export function McpStructuredForm(props: McpStructuredFormProps) {
  const [drafts, setDrafts] = createSignal(initialFormDrafts(props.request.fields));
  const [error, setError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  let firstControl: HTMLElement | undefined;

  onMount(() => queueMicrotask(() => firstControl?.focus()));

  function update(name: string, value: FormDraft) {
    setError(null);
    setDrafts((current) => ({ ...current, [name]: value }));
  }

  async function submit() {
    const content = buildFormContent(props.request.fields, drafts());
    if (!content.ok) {
      setError(content.error);
      return;
    }
    setSubmitting(true);
    const resolved = await props.onRespond(props.request, {
      action: "accept",
      content: content.value,
      _meta: null,
    });
    if (!resolved) {
      setSubmitting(false);
    }
  }

  async function finish(action: "cancel" | "decline") {
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
            onClick={() => void finish("cancel")}
            type="button"
          >
            Cancelar
          </button>
          <button
            class="secondary-button"
            disabled={submitting()}
            onClick={() => void finish("decline")}
            type="button"
          >
            Recusar
          </button>
          <button
            class="primary-button request-action-push"
            disabled={submitting()}
            onClick={() => void submit()}
            type="button"
          >
            Enviar
          </button>
        </>
      }
      eyebrow={`FORMULÁRIO MCP · ${props.request.serverName}`}
      pendingCount={props.pendingCount}
      title={props.request.message}
    >
      <div class="mcp-form-fields">
        <For each={props.request.fields}>
          {(field, index) => (
            <McpFieldControl
              captureFocus={(element) => {
                if (index() === 0) {
                  firstControl ??= element;
                }
              }}
              field={field}
              onChange={(value) => update(field.name, value)}
              value={drafts()[field.name] ?? null}
            />
          )}
        </For>
      </div>
      <Show when={error()}>{(message) => <p class="request-error">{message()}</p>}</Show>
    </RequestFrame>
  );
}

function McpFieldControl(props: {
  captureFocus: (element: HTMLElement) => void;
  field: McpFormField;
  onChange: (value: FormDraft) => void;
  value: FormDraft;
}) {
  return (
    <div class="mcp-form-field">
      <span>
        <strong>{props.field.label}</strong>
        <Show when={props.field.required}>
          <small class="required-mark">Obrigatório</small>
        </Show>
      </span>
      <Show when={props.field.description}>
        {(description) => <p>{description()}</p>}
      </Show>
      <Switch>
        <Match when={props.field.type === "text" ? props.field : undefined}>
          {(field) => (
            <input
              aria-label={field().label}
              maxLength={field().maximumLength ?? undefined}
              minLength={field().minimumLength ?? undefined}
              onInput={(event) => props.onChange(event.currentTarget.value)}
              ref={props.captureFocus}
              type={inputType(field().format)}
              value={typeof props.value === "string" ? props.value : ""}
            />
          )}
        </Match>
        <Match when={props.field.type === "number" ? props.field : undefined}>
          {(field) => (
            <input
              aria-label={field().label}
              max={field().maximum ?? undefined}
              min={field().minimum ?? undefined}
              onInput={(event) => props.onChange(event.currentTarget.value)}
              ref={props.captureFocus}
              step={field().integer ? 1 : "any"}
              type="number"
              value={typeof props.value === "string" ? props.value : ""}
            />
          )}
        </Match>
        <Match when={props.field.type === "boolean" ? props.field : undefined}>
          {(field) => (
            <select
              aria-label={field().label}
              onChange={(event) =>
                props.onChange(
                  event.currentTarget.value === ""
                    ? null
                    : event.currentTarget.value === "true",
                )
              }
              ref={props.captureFocus}
              value={typeof props.value === "boolean" ? String(props.value) : ""}
            >
              <option value="">Selecione…</option>
              <option value="true">Sim</option>
              <option value="false">Não</option>
            </select>
          )}
        </Match>
        <Match
          when={
            props.field.type === "select" && !props.field.multiple
              ? props.field
              : undefined
          }
        >
          {(field) => (
            <select
              aria-label={field().label}
              onChange={(event) => props.onChange(event.currentTarget.value)}
              ref={props.captureFocus}
              value={typeof props.value === "string" ? props.value : ""}
            >
              <option value="">Selecione…</option>
              <For each={field().options}>
                {(option) => <option value={option.value}>{option.label}</option>}
              </For>
            </select>
          )}
        </Match>
        <Match
          when={
            props.field.type === "select" && props.field.multiple
              ? props.field
              : undefined
          }
        >
          {(field) => (
            <div class="mcp-multi-select" ref={props.captureFocus} tabIndex={-1}>
              <For each={field().options}>
                {(option) => (
                  <label>
                    <input
                      checked={
                        Array.isArray(props.value) && props.value.includes(option.value)
                      }
                      onChange={(event) =>
                        props.onChange(
                          updateMultiValue(
                            Array.isArray(props.value) ? props.value : [],
                            option.value,
                            event.currentTarget.checked,
                          ),
                        )
                      }
                      type="checkbox"
                    />
                    {option.label}
                  </label>
                )}
              </For>
            </div>
          )}
        </Match>
      </Switch>
    </div>
  );
}
