import { createMemo, createSignal, For, onMount, Show } from "solid-js";

import type {
  AccountProfileActivityInsights,
  AccountProfileInvocation,
  AccountProfileSummary,
  ReasoningEffort,
} from "../contracts/types";
import type { AppController } from "../state/appController";
import { AccountAvatar, accountDisplayName } from "./AccountAvatar";
import { accountPlanName } from "./accountPresentation";
import { Icon } from "./Icon";
import {
  type ProfileActivityView,
  profileTodayIso,
  projectProfileActivity,
} from "./profileActivity";

type ProfileController = Pick<
  AppController,
  | "account"
  | "accountProfile"
  | "accountProfileError"
  | "accountProfileLoading"
  | "refreshAccountProfile"
>;

const compactNumberFormatter = new Intl.NumberFormat("pt-BR", {
  maximumFractionDigits: 1,
  notation: "compact",
});
const integerFormatter = new Intl.NumberFormat("pt-BR", {
  maximumFractionDigits: 0,
});
const percentageFormatter = new Intl.NumberFormat("pt-BR", {
  maximumFractionDigits: 0,
  style: "percent",
});
const activityDateFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});
const TOP_INVOCATIONS_LIMIT: number = 5;
const PROFILE_WEEK_COLUMN_SPAN: number = 4;

export function ProfileView(props: {
  readonly controller: ProfileController;
  readonly mode?: "settings" | "surface";
}) {
  const [activityView, setActivityView] = createSignal<ProfileActivityView>("daily");
  const profile = () => props.controller.accountProfile();
  const account = () => props.controller.account()?.account;
  const projection = createMemo(() =>
    projectProfileActivity(profile()?.dailyUsage ?? [], profileTodayIso(), activityView()),
  );

  onMount(() => {
    void props.controller.refreshAccountProfile();
  });

  return (
    <section
      aria-label="Perfil"
      class="profile-page"
      classList={{ "profile-page-settings": props.mode === "settings" }}
    >
      <div class="profile-page-scroll">
        <div class="profile-page-content">
          <Show
            when={profile()}
            fallback={
              <ProfileInitialState
                error={props.controller.accountProfileError()}
                loading={props.controller.accountProfileLoading()}
                onRetry={() => void props.controller.refreshAccountProfile()}
              />
            }
          >
            {(loadedProfile) => (
              <>
                <header class="profile-identity">
                  <AccountAvatar account={account()} size="profile" />
                  <h1>{loadedProfile().displayName ?? accountDisplayName(account())}</h1>
                  <div class="profile-identity-meta">
                    <Show when={loadedProfile().username}>
                      {(username) => <span>@{username()}</span>}
                    </Show>
                    <span class="profile-plan-badge">
                      {accountPlanName(account()?.planType ?? null)}
                    </span>
                  </div>
                </header>

                <ProfileSummary
                  status={loadedProfile().statisticsStatus}
                  summary={loadedProfile().summary}
                />

                <ProfileActivityChart
                  activityView={activityView()}
                  onSelectView={setActivityView}
                  projection={projection()}
                  unavailable={loadedProfile().statisticsStatus === "unavailable"}
                />

                <ProfileInsights
                  insights={loadedProfile().activityInsights}
                  unavailable={loadedProfile().statisticsStatus === "unavailable"}
                />
              </>
            )}
          </Show>
        </div>
      </div>
    </section>
  );
}

function ProfileInitialState(props: {
  readonly error: string | null;
  readonly loading: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <Show when={props.error !== null && !props.loading} fallback={<ProfileSkeleton />}>
      <div class="profile-load-error" role="alert">
        <Icon name="helpCircle" size={20} />
        <strong>Não foi possível carregar seu perfil.</strong>
        <p>{props.error}</p>
        <button onClick={props.onRetry} type="button">
          Tentar novamente
        </button>
      </div>
    </Show>
  );
}

function ProfileSkeleton() {
  return (
    <div aria-label="Carregando perfil" class="profile-skeleton" role="status">
      <span class="profile-skeleton-avatar" />
      <span class="profile-skeleton-line profile-skeleton-name" />
      <span class="profile-skeleton-line profile-skeleton-handle" />
      <span class="profile-skeleton-card" />
      <span class="profile-skeleton-chart" />
    </div>
  );
}

function ProfileSummary(props: {
  readonly status: "available" | "unavailable";
  readonly summary: AccountProfileSummary;
}) {
  const entries = () => [
    {
      label: "Total de tokens",
      value: formatOptionalCompact(props.summary.lifetimeTokens),
    },
    {
      label: "Pico de tokens",
      value: formatOptionalCompact(props.summary.peakDailyTokens),
    },
    {
      label: "Chat mais longo",
      value: formatOptionalDuration(props.summary.longestRunningTurnSeconds),
    },
    {
      label: "Sequência atual",
      value: formatOptionalDays(props.summary.currentStreakDays),
    },
    {
      label: "Maior sequência",
      value: formatOptionalDays(props.summary.longestStreakDays),
    },
  ];

  return (
    <section aria-label="Resumo de atividade" class="profile-summary">
      <Show
        when={props.status === "available"}
        fallback={<p>Estatísticas do perfil indisponíveis.</p>}
      >
        <For each={entries()}>
          {(entry) => (
            <div class="profile-summary-stat">
              <strong>{entry.value}</strong>
              <span>{entry.label}</span>
            </div>
          )}
        </For>
      </Show>
    </section>
  );
}

function ProfileActivityChart(props: {
  readonly activityView: ProfileActivityView;
  readonly onSelectView: (view: ProfileActivityView) => void;
  readonly projection: ReturnType<typeof projectProfileActivity>;
  readonly unavailable: boolean;
}) {
  const tabs = [
    { label: "Diário", value: "daily" },
    { label: "Semanal", value: "weekly" },
    { label: "Acumulado", value: "cumulative" },
  ] as const;

  return (
    <section class="profile-activity-chart">
      <header>
        <h2>Atividade de tokens</h2>
        <fieldset class="profile-activity-tabs">
          <legend class="visually-hidden">Agregação da atividade</legend>
          <For each={tabs}>
            {(tab) => (
              <button
                aria-pressed={props.activityView === tab.value}
                disabled={props.unavailable}
                onClick={() => props.onSelectView(tab.value)}
                type="button"
              >
                {tab.label}
              </button>
            )}
          </For>
        </fieldset>
      </header>
      <Show
        when={!props.unavailable}
        fallback={<div class="profile-section-unavailable">Histórico de tokens indisponível.</div>}
      >
        <div class="profile-activity-visual">
          <div aria-hidden="true" class="profile-activity-months">
            <For each={props.projection.monthLabels}>
              {(month) => (
                <span
                  style={{
                    "grid-column": `${month.column + 1} / span ${PROFILE_WEEK_COLUMN_SPAN}`,
                  }}
                >
                  {month.label}
                </span>
              )}
            </For>
          </div>
          <div
            aria-label="Calendário de atividade de tokens"
            class="profile-activity-grid"
            role="img"
          >
            <For each={props.projection.cells}>
              {(cell) => (
                <span
                  aria-hidden="true"
                  class="profile-activity-cell"
                  classList={{ future: cell.future }}
                  data-level={cell.level}
                  title={activityCellLabel(cell.date, cell.tokens, props.activityView)}
                />
              )}
            </For>
          </div>
        </div>
      </Show>
    </section>
  );
}

function ProfileInsights(props: {
  readonly insights: AccountProfileActivityInsights;
  readonly unavailable: boolean;
}) {
  const insightRows = () =>
    [
      props.insights.fastModePercent === null
        ? null
        : {
            label: "Modo rápido",
            value: formatPercentage(props.insights.fastModePercent),
          },
      props.insights.mostUsedReasoningEffort === null ||
      props.insights.mostUsedReasoningEffortPercent === null
        ? null
        : {
            label: "Raciocínio mais usado",
            value: `${reasoningEffortLabel(props.insights.mostUsedReasoningEffort)} · ${formatPercentage(
              props.insights.mostUsedReasoningEffortPercent,
            )}`,
          },
      props.insights.uniqueSkillsUsed === null
        ? null
        : {
            label: "Habilidades exploradas",
            value: integerFormatter.format(props.insights.uniqueSkillsUsed),
          },
      props.insights.totalSkillsUsed === null
        ? null
        : {
            label: "Total de habilidades usadas",
            value: integerFormatter.format(props.insights.totalSkillsUsed),
          },
      props.insights.totalThreads === null
        ? null
        : {
            label: "Total de chats",
            value: integerFormatter.format(props.insights.totalThreads),
          },
    ].filter(
      (entry): entry is { readonly label: string; readonly value: string } => entry !== null,
    );
  const invocations = () => props.insights.topInvocations?.slice(0, TOP_INVOCATIONS_LIMIT) ?? [];

  return (
    <section aria-label="Atividade do Codex" class="profile-insights-grid">
      <div>
        <h2>Insights de atividade</h2>
        <Show
          when={!props.unavailable}
          fallback={<div class="profile-section-unavailable">Insights indisponíveis.</div>}
        >
          <dl class="profile-insight-list">
            <For each={insightRows()}>
              {(entry) => (
                <div>
                  <dt>{entry.label}</dt>
                  <dd>{entry.value}</dd>
                </div>
              )}
            </For>
          </dl>
        </Show>
      </div>
      <div>
        <h2>Plugins mais usados</h2>
        <Show
          when={!props.unavailable && invocations().length > 0}
          fallback={
            <div class="profile-section-unavailable">
              {props.unavailable ? "Atividade de plugins indisponível." : "Nenhum plugin usado."}
            </div>
          }
        >
          <ul class="profile-invocation-list">
            <For each={invocations()}>
              {(invocation) => <ProfileInvocation invocation={invocation} />}
            </For>
          </ul>
        </Show>
      </div>
    </section>
  );
}

function ProfileInvocation(props: { readonly invocation: AccountProfileInvocation }) {
  const label = () =>
    props.invocation.type === "skill"
      ? (props.invocation.name.split(":").at(-1) ?? props.invocation.name)
      : props.invocation.name;
  return (
    <li>
      <span>
        <span class="profile-invocation-icon">
          <Icon name={props.invocation.type === "plugin" ? "puzzle" : "sparkles"} size={13} />
        </span>
        <span title={props.invocation.name}>{label()}</span>
      </span>
      <small>
        {props.invocation.usageCount} {props.invocation.usageCount === 1 ? "execução" : "execuções"}
      </small>
    </li>
  );
}

function formatOptionalCompact(value: number | null): string {
  return value === null ? "—" : compactNumberFormatter.format(value);
}

function formatOptionalDuration(seconds: number | null): string {
  if (seconds === null) {
    return "—";
  }
  const roundedSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(roundedSeconds / 3_600);
  const minutes = Math.floor((roundedSeconds % 3_600) / 60);
  if (hours > 0) {
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  return minutes > 0 ? `${minutes}m` : `${roundedSeconds}s`;
}

function formatOptionalDays(value: number | null): string {
  if (value === null) {
    return "—";
  }
  return `${integerFormatter.format(value)} ${value === 1 ? "dia" : "dias"}`;
}

function formatPercentage(value: number): string {
  return percentageFormatter.format(value / 100);
}

function reasoningEffortLabel(effort: ReasoningEffort): string {
  switch (effort) {
    case "none":
      return "Nenhum";
    case "minimal":
      return "Mínimo";
    case "low":
      return "Baixo";
    case "medium":
      return "Médio";
    case "high":
      return "Alto";
    case "xhigh":
      return "Muito alto";
    case "max":
      return "Máximo";
    case "ultra":
      return "Ultra";
  }
}

function activityCellLabel(dateIso: string, tokens: number, view: ProfileActivityView): string {
  const date = activityDateFormatter.format(new Date(`${dateIso}T00:00:00.000Z`));
  const prefix =
    view === "daily" ? "Tokens" : view === "weekly" ? "Tokens na semana" : "Tokens acumulados";
  return `${prefix}: ${compactNumberFormatter.format(tokens)} em ${date}`;
}
