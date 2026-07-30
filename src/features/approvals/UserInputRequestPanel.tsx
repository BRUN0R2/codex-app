import {
  For,
  Show,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { RequestFrame } from "./RequestFrame";
import type { InteractiveRequestPanelProps } from "./InteractiveRequestPanel";
import type {
  UserInputQuestion,
  UserInputRequest,
} from "./serverRequestTypes";

interface AnswerDraft {
  freeText: string;
  other: boolean;
  selectedLabel: string | null;
}

interface UserInputRequestPanelProps {
  onInterrupt: InteractiveRequestPanelProps["onInterrupt"];
  onRespond: InteractiveRequestPanelProps["onRespond"];
  pendingCount: number;
  request: UserInputRequest;
}

export function UserInputRequestPanel(props: UserInputRequestPanelProps) {
  const [answers, setAnswers] = createSignal(initialAnswers(props.request.questions));
  const [error, setError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  let firstControl: HTMLInputElement | undefined;

  onMount(() => queueMicrotask(() => firstControl?.focus()));

  function update(id: string, update: Partial<AnswerDraft>) {
    setError(null);
    setAnswers((current) => ({
      ...current,
      [id]: { ...current[id], ...update } as AnswerDraft,
    }));
  }

  async function submit() {
    const response = buildAnswers(props.request.questions, answers());
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setSubmitting(true);
    const resolved = await props.onRespond(props.request, {
      answers: response.answers,
    });
    if (!resolved) {
      setSubmitting(false);
    }
  }

  async function interrupt() {
    setSubmitting(true);
    await props.onInterrupt(props.request);
    setSubmitting(false);
  }

  return (
    <RequestFrame
      actions={
        <>
          <button
            class="ghost-button"
            disabled={submitting()}
            onClick={() => void interrupt()}
            type="button"
          >
            Interromper tarefa
          </button>
          <button
            class="primary-button request-action-push"
            disabled={submitting()}
            onClick={() => void submit()}
            type="button"
          >
            Enviar resposta
          </button>
        </>
      }
      eyebrow="RESPOSTA NECESSÁRIA"
      pendingCount={props.pendingCount}
      title="O Codex precisa de uma decisão"
    >
      <Show when={props.request.autoResolutionMs !== null}>
        <AutoResolutionNotice durationMs={props.request.autoResolutionMs ?? 0} />
      </Show>
      <div class="request-question-list">
        <For each={props.request.questions}>
          {(question, questionIndex) => (
            <fieldset class="request-question">
              <legend>
                <span>{question.header}</span>
                <small>
                  {questionIndex() + 1} de {props.request.questions.length}
                </small>
              </legend>
              <p>{question.question}</p>
              <Show
                when={question.options}
                fallback={
                  <input
                    aria-label={question.header}
                    class="request-text-input"
                    onInput={(event) =>
                      update(question.id, { freeText: event.currentTarget.value })
                    }
                    ref={(element) => {
                      firstControl ??= element;
                    }}
                    type={question.isSecret ? "password" : "text"}
                    value={answers()[question.id]?.freeText ?? ""}
                  />
                }
              >
                {(options) => (
                  <div class="request-option-list">
                    <For each={options()}>
                      {(option, optionIndex) => (
                        <label class="request-option">
                          <input
                            checked={
                              answers()[question.id]?.selectedLabel === option.label &&
                              answers()[question.id]?.other !== true
                            }
                            name={`question-${question.id}`}
                            onChange={() =>
                              update(question.id, {
                                selectedLabel: option.label,
                                other: false,
                              })
                            }
                            ref={(element) => {
                              if (questionIndex() === 0 && optionIndex() === 0) {
                                firstControl ??= element;
                              }
                            }}
                            type="radio"
                          />
                          <span>
                            <strong>{option.label}</strong>
                            <small>{option.description}</small>
                          </span>
                        </label>
                      )}
                    </For>
                    <Show when={question.isOther}>
                      <label class="request-option request-option-other">
                        <input
                          checked={answers()[question.id]?.other === true}
                          name={`question-${question.id}`}
                          onChange={() =>
                            update(question.id, {
                              selectedLabel: null,
                              other: true,
                            })
                          }
                          type="radio"
                        />
                        <span>
                          <strong>Outra resposta</strong>
                          <input
                            aria-label={`Outra resposta para ${question.header}`}
                            class="request-inline-input"
                            onFocus={() =>
                              update(question.id, {
                                selectedLabel: null,
                                other: true,
                              })
                            }
                            onInput={(event) =>
                              update(question.id, {
                                freeText: event.currentTarget.value,
                              })
                            }
                            type={question.isSecret ? "password" : "text"}
                            value={answers()[question.id]?.freeText ?? ""}
                          />
                        </span>
                      </label>
                    </Show>
                  </div>
                )}
              </Show>
            </fieldset>
          )}
        </For>
      </div>
      <Show when={error()}>{(message) => <p class="request-error">{message()}</p>}</Show>
    </RequestFrame>
  );
}

function initialAnswers(questions: UserInputQuestion[]): Record<string, AnswerDraft> {
  return Object.fromEntries(
    questions.map((question) => [
      question.id,
      { selectedLabel: null, other: false, freeText: "" },
    ]),
  );
}

function buildAnswers(
  questions: UserInputQuestion[],
  drafts: Record<string, AnswerDraft>,
):
  | { ok: true; answers: Record<string, { answers: string[] }> }
  | { ok: false; error: string } {
  const answers: Record<string, { answers: string[] }> = {};
  for (const question of questions) {
    const draft = drafts[question.id];
    if (draft === undefined) {
      return { ok: false, error: `Responda “${question.header}”.` };
    }
    if (question.options !== null && !draft.other) {
      if (draft.selectedLabel === null) {
        return { ok: false, error: `Selecione uma opção em “${question.header}”.` };
      }
      answers[question.id] = { answers: [draft.selectedLabel] };
      continue;
    }
    const text = draft.freeText.trim();
    if (text.length === 0) {
      return { ok: false, error: `Responda “${question.header}”.` };
    }
    answers[question.id] = { answers: [`user_note: ${text}`] };
  }
  return { ok: true, answers };
}

function AutoResolutionNotice(props: { durationMs: number }) {
  const startedAt = Date.now();
  const [remainingSeconds, setRemainingSeconds] = createSignal(
    Math.max(0, Math.ceil(props.durationMs / 1_000)),
  );

  onMount(() => {
    const timer = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setRemainingSeconds(Math.max(0, Math.ceil((props.durationMs - elapsed) / 1_000)));
    }, 1_000);
    onCleanup(() => window.clearInterval(timer));
  });

  return (
    <p class="request-countdown">
      {remainingSeconds() > 0
        ? `Resolução automática possível em ${remainingSeconds()} s.`
        : "Aguardando a resolução automática do servidor…"}
    </p>
  );
}
