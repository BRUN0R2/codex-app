import type { AccountProfileDailyUsage } from "../contracts/types";

export type ProfileActivityView = "cumulative" | "daily" | "weekly";
export type ProfileActivityLevel = 0 | 1 | 2 | 3 | 4;

export interface ProfileActivityCell {
  readonly date: string;
  readonly future: boolean;
  readonly level: ProfileActivityLevel;
  readonly tokens: number;
  readonly weekIndex: number;
}

export interface ProfileActivityMonthLabel {
  readonly column: number;
  readonly date: string;
  readonly label: string;
}

export interface ProfileActivityProjection {
  readonly cells: readonly ProfileActivityCell[];
  readonly cumulativeTotals: readonly number[];
  readonly dailyValues: readonly number[];
  readonly monthLabels: readonly ProfileActivityMonthLabel[];
  readonly weeklyTotals: readonly number[];
}

const DAY_MILLISECONDS = 86_400_000;
const DAYS_PER_WEEK = 7;
const WEEK_COUNT = 52;
const CELL_COUNT = WEEK_COUNT * DAYS_PER_WEEK;
const LEVEL_HIGH_RATIO = 3 / 4;
const LEVEL_MEDIUM_RATIO = 1 / 2;
const LEVEL_LOW_RATIO = 1 / 4;
const MONTH_LABEL_MINIMUM_DAY = 7;
const MONTH_GAP_COLUMNS = 4;

export function projectProfileActivity(
  usage: readonly AccountProfileDailyUsage[],
  todayIso: string,
  view: ProfileActivityView,
  locale: string,
): ProfileActivityProjection {
  const today = parseIsoDate(todayIso);
  const start = chartStart(today);
  const end = start + CELL_COUNT * DAY_MILLISECONDS;
  const tokensByDate = new Map<string, number>();
  for (const bucket of usage) {
    const timestamp = parseIsoDate(bucket.date);
    if (timestamp < start || timestamp >= end || timestamp > today) {
      continue;
    }
    const current = tokensByDate.get(bucket.date) ?? 0;
    tokensByDate.set(bucket.date, current + Math.max(0, bucket.tokens));
  }

  const dailyValues = Array.from({ length: CELL_COUNT }, (_, index) => {
    const date = toIsoDate(start + index * DAY_MILLISECONDS);
    return tokensByDate.get(date) ?? 0;
  });
  const weeklyTotals = Array.from({ length: WEEK_COUNT }, (_, weekIndex) =>
    dailyValues
      .slice(weekIndex * DAYS_PER_WEEK, (weekIndex + 1) * DAYS_PER_WEEK)
      .reduce((total, value) => total + value, 0),
  );
  const cumulativeTotals = weeklyTotals.reduce<number[]>((totals, value) => {
    totals.push((totals.at(-1) ?? 0) + value);
    return totals;
  }, []);
  const levels =
    view === "daily"
      ? dailyLevels(dailyValues)
      : barLevels(view === "weekly" ? weeklyTotals : cumulativeTotals);
  const cells = dailyValues.map((dailyTokens, index) => {
    const timestamp = start + index * DAY_MILLISECONDS;
    const weekIndex = Math.floor(index / DAYS_PER_WEEK);
    return {
      date: toIsoDate(timestamp),
      future: timestamp > today,
      level: levels[index] ?? 0,
      tokens:
        view === "daily"
          ? dailyTokens
          : view === "weekly"
            ? (weeklyTotals[weekIndex] ?? 0)
            : (cumulativeTotals[weekIndex] ?? 0),
      weekIndex,
    } satisfies ProfileActivityCell;
  });

  return {
    cells,
    cumulativeTotals,
    dailyValues,
    monthLabels: profileActivityMonthLabels(start, locale),
    weeklyTotals,
  };
}

export function profileTodayIso(now: Date = new Date()): string {
  return toIsoDate(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function dailyLevels(values: readonly number[]): readonly ProfileActivityLevel[] {
  const maximum = Math.max(0, ...values);
  return values.map((value): ProfileActivityLevel => {
    if (value <= 0 || maximum <= 0) {
      return 0;
    }
    const ratio = value / maximum;
    if (ratio > LEVEL_HIGH_RATIO) {
      return 4;
    }
    if (ratio > LEVEL_MEDIUM_RATIO) {
      return 3;
    }
    if (ratio > LEVEL_LOW_RATIO) {
      return 2;
    }
    return 1;
  });
}

function barLevels(totals: readonly number[]): readonly ProfileActivityLevel[] {
  const maximum = Math.max(0, ...totals);
  return totals.flatMap((value) => {
    const height = value <= 0 || maximum <= 0 ? 0 : Math.ceil((value * DAYS_PER_WEEK) / maximum);
    return Array.from(
      { length: DAYS_PER_WEEK },
      (_, row): ProfileActivityLevel => (DAYS_PER_WEEK - row <= height ? 4 : 0),
    );
  });
}

function profileActivityMonthLabels(
  start: number,
  locale: string,
): readonly ProfileActivityMonthLabel[] {
  const formatter = new Intl.DateTimeFormat(locale, {
    month: "short",
    timeZone: "UTC",
  });
  const labels: ProfileActivityMonthLabel[] = [];
  let nextColumn = 0;
  for (let column = 0; column < WEEK_COUNT; column += 1) {
    const timestamp = start + column * DAYS_PER_WEEK * DAY_MILLISECONDS;
    const date = new Date(timestamp);
    if (date.getUTCDate() > MONTH_LABEL_MINIMUM_DAY || column < nextColumn) {
      continue;
    }
    labels.push({
      column,
      date: toIsoDate(timestamp),
      label: formatter.format(date).replace(/\.$/u, ""),
    });
    nextColumn = column + MONTH_GAP_COLUMNS;
  }
  return labels;
}

function chartStart(today: number): number {
  const currentWeekStart = today - new Date(today).getUTCDay() * DAY_MILLISECONDS;
  return currentWeekStart - (WEEK_COUNT - 1) * DAYS_PER_WEEK * DAY_MILLISECONDS;
}

function parseIsoDate(value: string): number {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || toIsoDate(timestamp) !== value) {
    throw new Error(`Invalid ISO date in profile activity: ${JSON.stringify(value)}.`);
  }
  return timestamp;
}

function toIsoDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}
