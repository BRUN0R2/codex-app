import type {
  AccountRateLimitsResponse,
  RateLimitSnapshot,
  RateLimitWindow,
} from "../contracts/types";

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
): readonly UsageLimitGroup[] {
  if (response === null || response === undefined) {
    return [];
  }

  const groups = [
    presentSnapshot("codex", response.rateLimits),
    ...Object.entries(response.rateLimitsByLimitId)
      .filter(([limitId]) => limitId !== "codex")
      .sort(([leftId, left], [rightId, right]) =>
        displayLimitName(leftId, left).localeCompare(displayLimitName(rightId, right), "pt-BR"),
      )
      .map(([limitId, snapshot]) => presentSnapshot(limitId, snapshot)),
  ].filter((group): group is UsageLimitGroup => group !== null);

  return groups;
}

export function usageWindowLabel(windowDurationMins: number | null): string {
  if (windowDurationMins === null) {
    return "Limite de uso";
  }
  if (windowDurationMins === MINUTES_PER_DAY) {
    return "Limite de uso diário";
  }
  if (windowDurationMins === MINUTES_PER_WEEK) {
    return "Limite de uso semanal";
  }
  if (
    windowDurationMins >= MINIMUM_MONTH_WINDOW_MINUTES &&
    windowDurationMins <= MAXIMUM_MONTH_WINDOW_MINUTES
  ) {
    return "Limite de uso mensal";
  }
  if (windowDurationMins === MINUTES_PER_YEAR || windowDurationMins === MINUTES_PER_LEAP_YEAR) {
    return "Limite de uso anual";
  }
  if (windowDurationMins % MINUTES_PER_WEEK === 0) {
    return `Limite de uso de ${windowDurationMins / MINUTES_PER_WEEK} semanas`;
  }
  if (windowDurationMins % MINUTES_PER_DAY === 0) {
    return `Limite de uso de ${windowDurationMins / MINUTES_PER_DAY} dias`;
  }
  if (windowDurationMins % MINUTES_PER_HOUR === 0) {
    const hours = windowDurationMins / MINUTES_PER_HOUR;
    return `Limite de uso de ${hours} ${hours === 1 ? "hora" : "horas"}`;
  }
  return `Limite de uso de ${windowDurationMins} ${
    windowDurationMins === 1 ? "minuto" : "minutos"
  }`;
}

export function usagePercentLabel(percent: number): string {
  return `${Math.round(clampPercent(percent))}%`;
}

function presentSnapshot(limitId: string, snapshot: RateLimitSnapshot): UsageLimitGroup | null {
  const limits = [
    snapshot.primary === null ? null : presentWindow(limitId, "primary", snapshot.primary),
    snapshot.secondary === null ? null : presentWindow(limitId, "secondary", snapshot.secondary),
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
): UsageLimitEntry {
  const usedPercent = clampPercent(window.usedPercent);
  return {
    id: `${limitId}:${windowKind}`,
    label: usageWindowLabel(window.windowDurationMins),
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
