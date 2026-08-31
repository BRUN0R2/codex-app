import type {
  AccountRateLimitsResponse,
  RateLimitSnapshot,
  RateLimitWindow,
} from "../contracts/types";
import { formatMessage, type TranslationMessages } from "../i18n/messages";

type UsagePresentationMessages = Pick<
  TranslationMessages["settings"],
  | "annualUsageLimit"
  | "dailyUsageLimit"
  | "manyDaysUsageLimit"
  | "manyHoursUsageLimit"
  | "manyMinutesUsageLimit"
  | "manyWeeksUsageLimit"
  | "monthlyUsageLimit"
  | "oneDayUsageLimit"
  | "oneHourUsageLimit"
  | "oneMinuteUsageLimit"
  | "oneWeekUsageLimit"
  | "usageLimit"
  | "weeklyUsageLimit"
>;

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const MINUTES_PER_YEAR = 365 * MINUTES_PER_DAY;
const MINUTES_PER_LEAP_YEAR = 366 * MINUTES_PER_DAY;
const MINIMUM_MONTH_WINDOW_MINUTES = 28 * MINUTES_PER_DAY;
const MAXIMUM_MONTH_WINDOW_MINUTES = 31 * MINUTES_PER_DAY;

export interface UsageLimitEntry {
  readonly id: string;
  readonly label: string;
  readonly remainingPercent: number;
  readonly resetAt: number | null;
  readonly usedPercent: number;
  readonly windowDurationMins: number | null;
}

export interface UsageLimitGroup {
  readonly id: string;
  readonly label: string | null;
  readonly limits: readonly UsageLimitEntry[];
}

export function presentUsageLimits(
  response: AccountRateLimitsResponse | null | undefined,
  messages: UsagePresentationMessages,
  locale: string,
): readonly UsageLimitGroup[] {
  if (response === null || response === undefined) {
    return [];
  }

  const groups = [
    presentSnapshot("codex", response.rateLimits, messages),
    ...Object.entries(response.rateLimitsByLimitId)
      .filter(([limitId]) => limitId !== "codex")
      .sort(([leftId, left], [rightId, right]) =>
        displayLimitName(leftId, left).localeCompare(displayLimitName(rightId, right), locale),
      )
      .map(([limitId, snapshot]) => presentSnapshot(limitId, snapshot, messages)),
  ].filter((group): group is UsageLimitGroup => group !== null);

  return groups;
}

export function usageWindowLabel(
  windowDurationMins: number | null,
  messages: UsagePresentationMessages,
): string {
  if (windowDurationMins === null) {
    return messages.usageLimit;
  }
  if (windowDurationMins === MINUTES_PER_DAY) {
    return messages.dailyUsageLimit;
  }
  if (windowDurationMins === MINUTES_PER_WEEK) {
    return messages.weeklyUsageLimit;
  }
  if (
    windowDurationMins >= MINIMUM_MONTH_WINDOW_MINUTES &&
    windowDurationMins <= MAXIMUM_MONTH_WINDOW_MINUTES
  ) {
    return messages.monthlyUsageLimit;
  }
  if (windowDurationMins === MINUTES_PER_YEAR || windowDurationMins === MINUTES_PER_LEAP_YEAR) {
    return messages.annualUsageLimit;
  }
  if (windowDurationMins % MINUTES_PER_WEEK === 0) {
    const weeks = windowDurationMins / MINUTES_PER_WEEK;
    return weeks === 1
      ? messages.oneWeekUsageLimit
      : formatMessage(messages.manyWeeksUsageLimit, { count: weeks });
  }
  if (windowDurationMins % MINUTES_PER_DAY === 0) {
    const days = windowDurationMins / MINUTES_PER_DAY;
    return days === 1
      ? messages.oneDayUsageLimit
      : formatMessage(messages.manyDaysUsageLimit, { count: days });
  }
  if (windowDurationMins % MINUTES_PER_HOUR === 0) {
    const hours = windowDurationMins / MINUTES_PER_HOUR;
    return hours === 1
      ? messages.oneHourUsageLimit
      : formatMessage(messages.manyHoursUsageLimit, { count: hours });
  }
  return windowDurationMins === 1
    ? messages.oneMinuteUsageLimit
    : formatMessage(messages.manyMinutesUsageLimit, { count: windowDurationMins });
}

export function usagePercentLabel(percent: number): string {
  return `${Math.round(clampPercent(percent))}%`;
}

function presentSnapshot(
  limitId: string,
  snapshot: RateLimitSnapshot,
  messages: UsagePresentationMessages,
): UsageLimitGroup | null {
  const limits = [
    snapshot.primary === null
      ? null
      : presentWindow(limitId, "primary", snapshot.primary, messages),
    snapshot.secondary === null
      ? null
      : presentWindow(limitId, "secondary", snapshot.secondary, messages),
  ].filter((limit): limit is UsageLimitEntry => limit !== null);

  if (limits.length === 0) {
    return null;
  }
  return {
    id: limitId,
    label: limitId === "codex" ? null : displayLimitName(limitId, snapshot),
    limits,
  };
}

function presentWindow(
  limitId: string,
  windowKind: "primary" | "secondary",
  window: RateLimitWindow,
  messages: UsagePresentationMessages,
): UsageLimitEntry {
  const usedPercent = clampPercent(window.usedPercent);
  return {
    id: `${limitId}:${windowKind}`,
    label: usageWindowLabel(window.windowDurationMins, messages),
    remainingPercent: clampPercent(100 - usedPercent),
    resetAt: window.resetsAt,
    usedPercent,
    windowDurationMins: window.windowDurationMins,
  };
}

function displayLimitName(limitId: string, snapshot: RateLimitSnapshot): string {
  return snapshot.limitName ?? snapshot.limitId ?? limitId;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
