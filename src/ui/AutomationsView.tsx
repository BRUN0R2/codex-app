import { createMemo, createSignal, For, Show } from "solid-js";

import type {
  Automation,
  AutomationInput,
  AutomationRun,
  AutomationRunStatus,
} from "../contracts/types";
import { useI18n } from "../i18n/context";
import { formatMessage, type TranslationMessages } from "../i18n/messages";
import type { AppController } from "../state/appController";
import { pathsEqual } from "../state/projects";
import { Icon } from "./Icon";

const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 10_080;
const MAX_AUTOMATION_NAME_BYTES = 160;
const MAX_AUTOMATION_PROMPT_BYTES = 262_144;
const MAXIMUM_CONCURRENT_AUTOMATION_RUNS = 2;
const RECENT_RUN_LIMIT = 20;

type IntervalUnit = "days" | "hours" | "minutes";

interface AutomationEditorState {
  readonly automationId: string | null;
  readonly expectedVersion: number | null;
}

export function AutomationsView(props: {
  readonly controller: AppController;
  readonly onOpenSettings: () => void;
  readonly onShowChat: () => void;
}) {
  const i18n = useI18n();
  const [editor, setEditor] = createSignal<AutomationEditorState | null>(null);
  const [name, setName] = createSignal("");
  const [prompt, setPrompt] = createSignal("");
  const [projectPath, setProjectPath] = createSignal<string | null>(null);
  const [enabled, setEnabled] = createSignal(true);
  const [intervalValue, setIntervalValue] = createSignal(1);
  const [intervalUnit, setIntervalUnit] = createSignal<IntervalUnit>("hours");
  const [formError, setFormError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);

  const activeRuns = createMemo(() =>
    props.controller
      .automationRuns()
      .filter((run) => run.status === "queued" || run.status === "running"),
  );
  const recentRuns = createMemo(() => props.controller.automationRuns().slice(0, RECENT_RUN_LIMIT));
  const unreadRuns = () => props.controller.unreadAutomationRuns();
  const commandPending = () => props.controller.pendingOperations() > 0 || saving();

  function beginCreate(): void {
    const preferredProject = props.controller.workspace();
    setEditor({ automationId: null, expectedVersion: null });
    setName("");
    setPrompt("");
    setProjectPath(
      preferredProject !== null &&
        props.controller.projects().some((project) => pathsEqual(project.path, preferredProject))
        ? preferredProject
        : null,
    );
    setEnabled(true);
    setIntervalValue(1);
    setIntervalUnit("hours");
    setFormError(null);
  }

  function beginEdit(automation: Automation): void {
    const presentation = intervalPresentation(automation.intervalMinutes);
    setEditor({
      automationId: automation.id,
      expectedVersion: automation.version,
    });
    setName(automation.name);
    setPrompt(automation.prompt);
    setProjectPath(automation.projectPath);
    setEnabled(automation.enabled);
    setIntervalValue(presentation.value);
    setIntervalUnit(presentation.unit);
    setFormError(null);
  }

  function closeEditor(): void {
    if (!saving()) {
      setEditor(null);
      setFormError(null);
    }
  }

  function changeIntervalUnit(nextUnit: IntervalUnit): void {
    const currentMinutes = intervalValue() * intervalFactor(intervalUnit());
    setIntervalUnit(nextUnit);
    setIntervalValue(
      clampIntervalValue(Math.round(currentMinutes / intervalFactor(nextUnit)), nextUnit),
    );
  }

  async function submitAutomation(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (saving()) {
      return;
    }
    const input = readAutomationInput();
    if (input === null) {
      return;
    }
    const currentEditor = editor();
    if (currentEditor === null) {
      return;
    }
    setSaving(true);
    try {
      const saved =
        currentEditor.automationId === null || currentEditor.expectedVersion === null
          ? await props.controller.createAutomation(input)
          : await props.controller.updateAutomation(
              currentEditor.automationId,
              currentEditor.expectedVersion,
              input,
            );
      if (saved) {
        setEditor(null);
        setFormError(null);
      }
    } finally {
      setSaving(false);
    }
  }

  function readAutomationInput(): AutomationInput | null {
    const normalizedName = name().trim();
    const normalizedPrompt = prompt().trim();
    const intervalMinutes = intervalValue() * intervalFactor(intervalUnit());
    if (normalizedName.length === 0 || utf8Length(normalizedName) > MAX_AUTOMATION_NAME_BYTES) {
      setFormError(i18n.messages().automations.nameValidation);
      return null;
    }
    if (
      normalizedPrompt.length === 0 ||
      utf8Length(normalizedPrompt) > MAX_AUTOMATION_PROMPT_BYTES
    ) {
      setFormError(i18n.messages().automations.instructionsValidation);
      return null;
    }
    if (
      !Number.isSafeInteger(intervalMinutes) ||
      intervalMinutes < MIN_INTERVAL_MINUTES ||
      intervalMinutes > MAX_INTERVAL_MINUTES
    ) {
      setFormError(i18n.messages().automations.intervalValidation);
      return null;
    }
    setFormError(null);
    return {
      name: normalizedName,
      prompt: normalizedPrompt,
      projectPath: projectPath(),
      enabled: enabled(),
      intervalMinutes,
    };
  }

  async function toggleAutomation(automation: Automation): Promise<void> {
    await props.controller.updateAutomation(automation.id, automation.version, {
      ...automationInputFrom(automation),
      enabled: !automation.enabled,
    });
  }

  async function openRun(run: AutomationRun): Promise<void> {
    if (run.threadId === null) {
      return;
    }
    if (await props.controller.openThread(run.threadId)) {
      props.onShowChat();
      if (!run.reviewed && isTerminalRun(run)) {
        void props.controller.markAutomationRunReviewed(run.id);
      }
    }
  }

  return (
    <section aria-labelledby="automations-title" class="automations-view">
      <header class="automations-header">
        <div>
          <span class="automations-eyebrow">
            <Icon name="calendar" size={14} />
            {i18n.messages().automations.engineLocal}
          </span>
          <h1 id="automations-title">{i18n.messages().automations.title}</h1>
          <p>{i18n.messages().automations.description}</p>
        </div>
        <div class="automations-header-actions">
          <button
            aria-label={i18n.messages().automations.refresh}
            class="automation-icon-button"
            disabled={props.controller.automationsLoading()}
            onClick={() => void props.controller.refreshAutomations()}
            title={i18n.messages().automations.refreshTitle}
            type="button"
          >
            <Icon name="syncCheck" size={16} />
          </button>
          <button class="automation-primary-button" onClick={beginCreate} type="button">
            <Icon name="plus" size={15} />
            {i18n.messages().automations.newAutomation}
          </button>
        </div>
      </header>

      <aside class="automation-local-notice">
        <span class="automation-local-notice-icon">
          <Icon name="computer" size={17} />
        </span>
        <div>
          <strong>{i18n.messages().automations.reliableBackgroundTitle}</strong>
          <p>{i18n.messages().automations.reliableBackgroundDescription}</p>
        </div>
        <button onClick={props.onOpenSettings} type="button">
          {i18n.messages().automations.configure}
        </button>
      </aside>

      <Show when={unreadRuns().length > 0}>
        <section aria-labelledby="automation-inbox-title" class="automation-section">
          <div class="automation-section-heading">
            <div>
              <h2 id="automation-inbox-title">{i18n.messages().automations.inbox}</h2>
              <p>{i18n.messages().automations.inboxDescription}</p>
            </div>
            <span class="automation-count-badge">{unreadRuns().length}</span>
          </div>
          <div class="automation-inbox">
            <For each={unreadRuns()}>
              {(run) => (
                <AutomationRunRow
                  automation={automationForRun(props.controller.automations(), run)}
                  onMarkReviewed={() => void props.controller.markAutomationRunReviewed(run.id)}
                  onOpen={() => void openRun(run)}
                  run={run}
                />
              )}
            </For>
          </div>
        </section>
      </Show>

      <div class="automations-workspace">
        <section aria-labelledby="automation-list-title" class="automation-section">
          <div class="automation-section-heading">
            <div>
              <h2 id="automation-list-title">{i18n.messages().automations.schedules}</h2>
              <p>{i18n.messages().automations.schedulesDescription}</p>
            </div>
            <Show when={props.controller.automationsLoading()}>
              <span class="automation-loading" role="status">
                {i18n.messages().automations.updating}
              </span>
            </Show>
          </div>

          <Show
            when={props.controller.automations().length > 0}
            fallback={
              <div class="automation-empty-state">
                <span>
                  <Icon name="calendar" size={22} />
                </span>
                <h3>{i18n.messages().automations.emptyTitle}</h3>
                <p>{i18n.messages().automations.emptyDescription}</p>
                <button class="automation-primary-button" onClick={beginCreate} type="button">
                  {i18n.messages().automations.createFirst}
                </button>
              </div>
            }
          >
            <div class="automation-card-list">
              <For each={props.controller.automations()}>
                {(automation) => {
                  const activeRun = () =>
                    activeRuns().find((run) => run.automationId === automation.id);
                  const latestRun = () =>
                    props.controller
                      .automationRuns()
                      .find((run) => run.automationId === automation.id);
                  return (
                    <article
                      class="automation-card"
                      classList={{
                        paused: !automation.enabled,
                        running: activeRun() !== undefined,
                      }}
                    >
                      <div class="automation-card-main">
                        <div class="automation-card-title-row">
                          <span
                            aria-hidden="true"
                            class="automation-state-dot"
                            data-state={
                              activeRun()?.status ?? (automation.enabled ? "enabled" : "paused")
                            }
                          />
                          <div>
                            <h3>{automation.name}</h3>
                            <p class="automation-project">
                              {automationProjectLabel(
                                props.controller.projects(),
                                automation.projectPath,
                                i18n.messages().automations.noProject,
                              )}
                            </p>
                          </div>
                          <span
                            class="automation-status-pill"
                            data-state={
                              activeRun()?.status ?? (automation.enabled ? "enabled" : "paused")
                            }
                          >
                            {activeRun() === undefined
                              ? automation.enabled
                                ? i18n.messages().automations.active
                                : i18n.messages().automations.paused
                              : automationRunStatusLabel(
                                  activeRun()?.status ?? "queued",
                                  i18n.messages().automations,
                                )}
                          </span>
                        </div>
                        <p class="automation-prompt-preview">{automation.prompt}</p>
                        <div class="automation-card-meta">
                          <span>
                            <Icon name="reset" size={13} />
                            {formatMessage(i18n.messages().automations.every, {
                              interval: formatInterval(
                                automation.intervalMinutes,
                                i18n.messages().automations,
                              ),
                            })}
                          </span>
                          <Show
                            when={automation.nextRunAt}
                            fallback={<span>{i18n.messages().automations.noNextRun}</span>}
                          >
                            {(nextRunAt) => (
                              <span>
                                <Icon name="calendar" size={13} />
                                {formatMessage(i18n.messages().automations.nextRun, {
                                  date: formatUnixTimestamp(nextRunAt(), i18n.locale()),
                                })}
                              </span>
                            )}
                          </Show>
                          <Show when={latestRun()}>
                            {(run) => (
                              <span>
                                {formatMessage(i18n.messages().automations.lastRun, {
                                  status: automationRunStatusLabel(
                                    run().status,
                                    i18n.messages().automations,
                                  ).toLocaleLowerCase(i18n.locale()),
                                })}
                              </span>
                            )}
                          </Show>
                        </div>
                      </div>
                      <div class="automation-card-actions">
                        <button
                          disabled={
                            commandPending() ||
                            activeRun() !== undefined ||
                            activeRuns().length >= MAXIMUM_CONCURRENT_AUTOMATION_RUNS
                          }
                          onClick={() => void props.controller.runAutomationNow(automation.id)}
                          type="button"
                        >
                          <Icon name="arrowUp" size={14} />
                          {i18n.messages().automations.runNow}
                        </button>
                        <button
                          disabled={commandPending()}
                          onClick={() => void toggleAutomation(automation)}
                          type="button"
                        >
                          {automation.enabled
                            ? i18n.messages().automations.pause
                            : i18n.messages().automations.enable}
                        </button>
                        <button
                          aria-label={formatMessage(i18n.messages().automations.editNamed, {
                            name: automation.name,
                          })}
                          class="automation-icon-button"
                          disabled={commandPending()}
                          onClick={() => beginEdit(automation)}
                          title={i18n.messages().automations.edit}
                          type="button"
                        >
                          <Icon name="edit" size={15} />
                        </button>
                        <button
                          aria-label={formatMessage(i18n.messages().automations.deleteNamed, {
                            name: automation.name,
                          })}
                          class="automation-icon-button danger"
                          disabled={commandPending() || activeRun() !== undefined}
                          onClick={() => void props.controller.deleteAutomation(automation.id)}
                          title={i18n.messages().automations.delete}
                          type="button"
                        >
                          <Icon name="trash" size={15} />
                        </button>
                      </div>
                    </article>
                  );
                }}
              </For>
            </div>
          </Show>
        </section>

        <Show when={recentRuns().length > 0}>
          <section aria-labelledby="automation-history-title" class="automation-section">
            <div class="automation-section-heading">
              <div>
                <h2 id="automation-history-title">{i18n.messages().automations.recentRuns}</h2>
                <p>{i18n.messages().automations.recentRunsDescription}</p>
              </div>
            </div>
            <div class="automation-history">
              <For each={recentRuns()}>
                {(run) => (
                  <AutomationRunRow
                    automation={automationForRun(props.controller.automations(), run)}
                    compact
                    onMarkReviewed={() => void props.controller.markAutomationRunReviewed(run.id)}
                    onOpen={() => void openRun(run)}
                    run={run}
                  />
                )}
              </For>
            </div>
          </section>
        </Show>
      </div>

      <Show when={editor()}>
        <div class="automation-editor-backdrop">
          <section
            aria-labelledby="automation-editor-title"
            aria-modal="true"
            class="automation-editor"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeEditor();
              }
            }}
            role="dialog"
          >
            <header>
              <div>
                <span class="automations-eyebrow">{i18n.messages().automations.localSchedule}</span>
                <h2 id="automation-editor-title">
                  {editor()?.automationId === null
                    ? i18n.messages().automations.newAutomation
                    : i18n.messages().automations.editAutomation}
                </h2>
              </div>
              <button
                aria-label={i18n.messages().automations.closeEditor}
                class="automation-icon-button"
                disabled={saving()}
                onClick={closeEditor}
                type="button"
              >
                <Icon name="close" size={16} />
              </button>
            </header>
            <form onSubmit={(event) => void submitAutomation(event)}>
              <label class="automation-field">
                <span>{i18n.messages().automations.name}</span>
                <input
                  autofocus
                  maxlength={MAX_AUTOMATION_NAME_BYTES}
                  onInput={(event) => setName(event.currentTarget.value)}
                  placeholder={i18n.messages().automations.namePlaceholder}
                  required
                  value={name()}
                />
              </label>
              <label class="automation-field">
                <span>{i18n.messages().automations.instructions}</span>
                <textarea
                  maxlength={MAX_AUTOMATION_PROMPT_BYTES}
                  onInput={(event) => setPrompt(event.currentTarget.value)}
                  placeholder={i18n.messages().automations.instructionsPlaceholder}
                  required
                  rows={8}
                  value={prompt()}
                />
                <small>{i18n.messages().automations.instructionsHelp}</small>
              </label>
              <div class="automation-field-grid">
                <label class="automation-field">
                  <span>{i18n.messages().automations.project}</span>
                  <select
                    onChange={(event) => setProjectPath(event.currentTarget.value || null)}
                    value={projectPath() ?? ""}
                  >
                    <option value="">{i18n.messages().automations.noProject}</option>
                    <Show
                      when={
                        projectPath() !== null &&
                        !props.controller
                          .projects()
                          .some((project) => pathsEqual(project.path, projectPath() ?? ""))
                      }
                    >
                      <option value={projectPath() ?? ""}>{projectPath()}</option>
                    </Show>
                    <For each={props.controller.projects()}>
                      {(project) => <option value={project.path}>{project.name}</option>}
                    </For>
                  </select>
                </label>
                <fieldset class="automation-field automation-interval-field">
                  <legend>{i18n.messages().automations.frequency}</legend>
                  <div>
                    <input
                      aria-label={i18n.messages().automations.interval}
                      inputmode="numeric"
                      max={maxIntervalValue(intervalUnit())}
                      min={minIntervalValue(intervalUnit())}
                      onInput={(event) =>
                        setIntervalValue(
                          clampIntervalValue(
                            Number.parseInt(event.currentTarget.value, 10) || 0,
                            intervalUnit(),
                          ),
                        )
                      }
                      required
                      type="number"
                      value={intervalValue()}
                    />
                    <select
                      aria-label={i18n.messages().automations.intervalUnit}
                      onChange={(event) =>
                        changeIntervalUnit(decodeIntervalUnit(event.currentTarget.value))
                      }
                      value={intervalUnit()}
                    >
                      <option value="minutes">{i18n.messages().automations.minutes}</option>
                      <option value="hours">{i18n.messages().automations.hours}</option>
                      <option value="days">{i18n.messages().automations.days}</option>
                    </select>
                  </div>
                </fieldset>
              </div>
              <label class="automation-enabled-field">
                <span>
                  <strong>{i18n.messages().automations.enableOnSave}</strong>
                  <small>{i18n.messages().automations.firstRunHelp}</small>
                </span>
                <input
                  aria-checked={enabled()}
                  checked={enabled()}
                  onChange={(event) => setEnabled(event.currentTarget.checked)}
                  role="switch"
                  type="checkbox"
                />
              </label>
              <Show when={formError()}>
                {(message) => (
                  <p class="automation-form-error" role="alert">
                    {message()}
                  </p>
                )}
              </Show>
              <footer>
                <button
                  class="automation-secondary-button"
                  disabled={saving()}
                  onClick={closeEditor}
                  type="button"
                >
                  {i18n.messages().common.cancel}
                </button>
                <button class="automation-primary-button" disabled={saving()} type="submit">
                  {saving() ? i18n.messages().automations.saving : i18n.messages().automations.save}
                </button>
              </footer>
            </form>
          </section>
        </div>
      </Show>
    </section>
  );
}

function AutomationRunRow(props: {
  readonly automation: Automation | undefined;
  readonly compact?: boolean;
  readonly onMarkReviewed: () => void;
  readonly onOpen: () => void;
  readonly run: AutomationRun;
}) {
  const i18n = useI18n();
  const terminal = () => isTerminalRun(props.run);
  return (
    <article class="automation-run-row" classList={{ compact: props.compact === true }}>
      <span class="automation-run-icon" data-state={props.run.status}>
        <Icon
          name={
            props.run.status === "completed"
              ? "check"
              : props.run.status === "failed"
                ? "bug"
                : props.run.status === "interrupted"
                  ? "stop"
                  : "syncCheck"
          }
          size={15}
        />
      </span>
      <div class="automation-run-copy">
        <div>
          <strong>{props.automation?.name ?? i18n.messages().automations.removed}</strong>
          <span class="automation-status-pill" data-state={props.run.status}>
            {automationRunStatusLabel(props.run.status, i18n.messages().automations)}
          </span>
          <Show when={props.run.reviewed}>
            <small>{i18n.messages().automations.reviewed}</small>
          </Show>
        </div>
        <p>
          {props.run.error ??
            `${
              props.run.trigger === "manual"
                ? i18n.messages().automations.manualRun
                : i18n.messages().automations.scheduledRun
            } · ${formatUnixTimestamp(
              props.run.completedAt ?? props.run.startedAt ?? props.run.createdAt,
              i18n.locale(),
            )}`}
        </p>
      </div>
      <div class="automation-run-actions">
        <Show when={props.run.threadId !== null}>
          <button onClick={props.onOpen} type="button">
            {i18n.messages().automations.openConversation}
          </button>
        </Show>
        <Show when={terminal() && !props.run.reviewed}>
          <button class="automation-mark-reviewed" onClick={props.onMarkReviewed} type="button">
            {i18n.messages().automations.markReviewed}
          </button>
        </Show>
      </div>
    </article>
  );
}

function automationInputFrom(automation: Automation): AutomationInput {
  return {
    name: automation.name,
    prompt: automation.prompt,
    projectPath: automation.projectPath,
    enabled: automation.enabled,
    intervalMinutes: automation.intervalMinutes,
  };
}

function automationForRun(
  automations: readonly Automation[],
  run: AutomationRun,
): Automation | undefined {
  return automations.find((automation) => automation.id === run.automationId);
}

function isTerminalRun(run: AutomationRun): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "interrupted";
}

function automationRunStatusLabel(
  status: AutomationRunStatus,
  messages: TranslationMessages["automations"],
): string {
  switch (status) {
    case "queued":
      return messages.statusQueued;
    case "running":
      return messages.statusRunning;
    case "completed":
      return messages.statusCompleted;
    case "failed":
      return messages.statusFailed;
    case "interrupted":
      return messages.statusInterrupted;
  }
}

function automationProjectLabel(
  projects: readonly { readonly name: string; readonly path: string }[],
  projectPath: string | null,
  noProjectLabel: string,
): string {
  if (projectPath === null) {
    return noProjectLabel;
  }
  const project = projects.find((entry) => pathsEqual(entry.path, projectPath));
  return project?.name ?? projectPath;
}

function intervalPresentation(intervalMinutes: number): {
  readonly unit: IntervalUnit;
  readonly value: number;
} {
  if (intervalMinutes % 1_440 === 0) {
    return { unit: "days", value: intervalMinutes / 1_440 };
  }
  if (intervalMinutes % 60 === 0) {
    return { unit: "hours", value: intervalMinutes / 60 };
  }
  return { unit: "minutes", value: intervalMinutes };
}

function formatInterval(
  intervalMinutes: number,
  messages: TranslationMessages["automations"],
): string {
  const presentation = intervalPresentation(intervalMinutes);
  switch (presentation.unit) {
    case "days":
      return `${presentation.value} ${presentation.value === 1 ? messages.oneDay : messages.manyDays}`;
    case "hours":
      return `${presentation.value} ${presentation.value === 1 ? messages.oneHour : messages.manyHours}`;
    case "minutes":
      return `${presentation.value} ${
        presentation.value === 1 ? messages.oneMinute : messages.manyMinutes
      }`;
  }
}

function intervalFactor(unit: IntervalUnit): number {
  switch (unit) {
    case "minutes":
      return 1;
    case "hours":
      return 60;
    case "days":
      return 1_440;
  }
}

function minIntervalValue(unit: IntervalUnit): number {
  return unit === "minutes" ? MIN_INTERVAL_MINUTES : 1;
}

function maxIntervalValue(unit: IntervalUnit): number {
  return Math.floor(MAX_INTERVAL_MINUTES / intervalFactor(unit));
}

function clampIntervalValue(value: number, unit: IntervalUnit): number {
  return Math.min(
    maxIntervalValue(unit),
    Math.max(minIntervalValue(unit), Number.isFinite(value) ? Math.round(value) : 1),
  );
}

function formatUnixTimestamp(timestampSeconds: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(new Date(timestampSeconds * 1_000));
}

function decodeIntervalUnit(value: string): IntervalUnit {
  if (value === "days" || value === "hours" || value === "minutes") return value;
  throw new Error(`Unsupported automation interval unit ${JSON.stringify(value)}.`);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
