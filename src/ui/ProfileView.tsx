import { createMemo, createSignal, For, onMount, Show } from "solid-js";

import type {
  AccountProfileActivityInsights,
  AccountProfileInvocation,
  AccountProfileSummary,
  ReasoningEffort,
} from "../contracts/types";
import { useI18n } from "../i18n/context";
import { formatMessage, type TranslationMessages } from "../i18n/messages";
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

const TOP_INVOCATIONS_LIMIT: number = 5;
const PROFILE_WEEK_COLUMN_SPAN: number = 4;

export function ProfileView(props: {
  readonly controller: ProfileController;
  readonly mode?: "settings" | "surface";
}) {
  const i18n = useI18n();
  const [activityView, setActivityView] = createSignal<ProfileActivityView>("daily");
  const profile = () => props.controller.accountProfile();
  const account = () => props.controller.account()?.account;
  const projection = createMemo(() =>
    projectProfileActivity(
      profile()?.dailyUsage ?? [],
      profileTodayIso(),
      activityView(),
      i18n.locale(),
    ),
  );

  onMount(() => {
    void props.controller.refreshAccountProfile();
  });

  return (
    <section
      aria-label={i18n.messages().profile.label}
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
                      {accountPlanName(account()?.planType ?? null, i18n.messages().account)}
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
  const i18n = useI18n();
  return (
    <Show when={props.error !== null && !props.loading} fallback={<ProfileSkeleton />}>
      <div class="profile-load-error" role="alert">
        <Icon name="helpCircle" size={20} />
        <strong>{i18n.messages().profile.loadFailure}</strong>
        <p>{props.error}</p>
        <button onClick={props.onRetry} type="button">
          {i18n.messages().common.tryAgain}
        </button>
      </div>
    </Show>
  );
}

function ProfileSkeleton() {
  const i18n = useI18n();
  return (
    <div aria-label={i18n.messages().profile.loading} class="profile-skeleton" role="status">
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
  const i18n = useI18n();
  const formatters = createMemo(() => createProfileFormatters(i18n.locale()));
  const entries = () => [
    {
      label: i18n.messages().profile.totalTokens,
      value: formatOptionalCompact(props.summary.lifetimeTokens, formatters().compactNumber),
    },
    {
      label: i18n.messages().profile.peakTokens,
      value: formatOptionalCompact(props.summary.peakDailyTokens, formatters().compactNumber),
    },
    {
      label: i18n.messages().profile.longestChat,
      value: formatOptionalDuration(props.summary.longestRunningTurnSeconds),
    },
    {
      label: i18n.messages().profile.currentStreak,
      value: formatOptionalDays(
        props.summary.currentStreakDays,
        formatters().integer,
        i18n.messages().profile,
      ),
    },
    {
      label: i18n.messages().profile.longestStreak,
      value: formatOptionalDays(
        props.summary.longestStreakDays,
        formatters().integer,
        i18n.messages().profile,
      ),
    },
  ];

  return (
    <section aria-label={i18n.messages().profile.activitySummary} class="profile-summary">
      <Show
        when={props.status === "available"}
        fallback={<p>{i18n.messages().profile.statisticsUnavailable}</p>}
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
  const i18n = useI18n();
  const formatters = createMemo(() => createProfileFormatters(i18n.locale()));
  const tabs = () =>
    [
      { label: i18n.messages().profile.daily, value: "daily" },
      { label: i18n.messages().profile.weekly, value: "weekly" },
      { label: i18n.messages().profile.cumulative, value: "cumulative" },
    ] as const;

  return (
    <section class="profile-activity-chart">
      <header>
        <h2>{i18n.messages().profile.tokenActivity}</h2>
        <fieldset class="profile-activity-tabs">
          <legend class="visually-hidden">{i18n.messages().profile.activityAggregation}</legend>
          <For each={tabs()}>
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
        fallback={
          <div class="profile-section-unavailable">
            {i18n.messages().profile.tokenHistoryUnavailable}
          </div>
        }
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
            aria-label={i18n.messages().profile.tokenCalendar}
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
                  title={activityCellLabel(
                    cell.date,
                    cell.tokens,
                    props.activityView,
                    i18n.messages().profile,
                    formatters(),
                  )}
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
  const i18n = useI18n();
  const formatters = createMemo(() => createProfileFormatters(i18n.locale()));
  const insightRows = () =>
    [
      props.insights.fastModePercent === null
        ? null
        : {
            label: i18n.messages().profile.fastMode,
            value: formatPercentage(props.insights.fastModePercent, formatters().percentage),
          },
      props.insights.mostUsedReasoningEffort === null ||
      props.insights.mostUsedReasoningEffortPercent === null
        ? null
        : {
            label: i18n.messages().profile.mostUsedReasoning,
            value: `${reasoningEffortLabel(
              props.insights.mostUsedReasoningEffort,
              i18n.messages().profile,
            )} · ${formatPercentage(
              props.insights.mostUsedReasoningEffortPercent,
              formatters().percentage,
            )}`,
          },
      props.insights.uniqueSkillsUsed === null
        ? null
        : {
            label: i18n.messages().profile.skillsExplored,
            value: formatters().integer.format(props.insights.uniqueSkillsUsed),
          },
      props.insights.totalSkillsUsed === null
        ? null
        : {
            label: i18n.messages().profile.totalSkillsUsed,
            value: formatters().integer.format(props.insights.totalSkillsUsed),
          },
      props.insights.totalThreads === null
        ? null
        : {
            label: i18n.messages().profile.totalChats,
            value: formatters().integer.format(props.insights.totalThreads),
          },
    ].filter(
      (entry): entry is { readonly label: string; readonly value: string } => entry !== null,
    );
  const invocations = () => props.insights.topInvocations?.slice(0, TOP_INVOCATIONS_LIMIT) ?? [];

  return (
    <section aria-label={i18n.messages().profile.codexActivity} class="profile-insights-grid">
      <div>
        <h2>{i18n.messages().profile.activityInsights}</h2>
        <Show
          when={!props.unavailable}
          fallback={
            <div class="profile-section-unavailable">
              {i18n.messages().profile.insightsUnavailable}
            </div>
          }
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
        <h2>{i18n.messages().profile.topPlugins}</h2>
        <Show
          when={!props.unavailable && invocations().length > 0}
          fallback={
            <div class="profile-section-unavailable">
              {props.unavailable
                ? i18n.messages().profile.pluginActivityUnavailable
                : i18n.messages().profile.noPlugins}
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
  const i18n = useI18n();
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
        {props.invocation.usageCount}{" "}
        {props.invocation.usageCount === 1
          ? i18n.messages().profile.oneRun
          : i18n.messages().profile.manyRuns}
      </small>
    </li>
  );
}

function formatOptionalCompact(value: number | null, formatter: Intl.NumberFormat): string {
  return value === null ? "—" : formatter.format(value);
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

function formatOptionalDays(
  value: number | null,
  formatter: Intl.NumberFormat,
  messages: TranslationMessages["profile"],
): string {
  if (value === null) {
    return "—";
  }
  return `${formatter.format(value)} ${value === 1 ? messages.oneDay : messages.manyDays}`;
}

function formatPercentage(value: number, formatter: Intl.NumberFormat): string {
  return formatter.format(value / 100);
}

function reasoningEffortLabel(
  effort: ReasoningEffort,
  messages: TranslationMessages["profile"],
): string {
  switch (effort) {
    case "none":
      return messages.reasoningNone;
    case "minimal":
      return messages.reasoningMinimal;
    case "low":
      return messages.reasoningLow;
    case "medium":
      return messages.reasoningMedium;
    case "high":
      return messages.reasoningHigh;
    case "xhigh":
      return messages.reasoningVeryHigh;
    case "max":
      return messages.reasoningMaximum;
    case "ultra":
      return "Ultra";
  }
}

function activityCellLabel(
  dateIso: string,
  tokens: number,
  view: ProfileActivityView,
  messages: TranslationMessages["profile"],
  formatters: ProfileFormatters,
): string {
  const date = formatters.activityDate.format(new Date(`${dateIso}T00:00:00.000Z`));
  const prefix =
    view === "daily"
      ? messages.tokens
      : view === "weekly"
        ? messages.weeklyTokens
        : messages.cumulativeTokens;
  return formatMessage(messages.activityCell, {
    date,
    prefix,
    tokens: formatters.compactNumber.format(tokens),
  });
}

interface ProfileFormatters {
  readonly activityDate: Intl.DateTimeFormat;
  readonly compactNumber: Intl.NumberFormat;
  readonly integer: Intl.NumberFormat;
  readonly percentage: Intl.NumberFormat;
}

function createProfileFormatters(locale: string): ProfileFormatters {
  return {
    activityDate: new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
      year: "numeric",
    }),
    compactNumber: new Intl.NumberFormat(locale, {
      maximumFractionDigits: 1,
      notation: "compact",
    }),
    integer: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
    percentage: new Intl.NumberFormat(locale, {
      maximumFractionDigits: 0,
      style: "percent",
    }),
  };
}
