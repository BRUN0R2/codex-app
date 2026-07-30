import type {
  AccountRateLimitsResponse,
  RateLimitSnapshot,
  RateLimitWindow,
} from "../../shared/codex/rateLimitTypes";

export interface AccountUsageSummary {
  cadence: string;
  remainingPercent: number;
  resetsAt: number | null;
  usedPercent: number;
}

export interface AccountUsageExhaustion {
  resetsAt: number | null;
}

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const MINUTES_PER_MONTH = 30 * MINUTES_PER_DAY;

export function summarizeAccountUsage(
  response: AccountRateLimitsResponse | null,
): AccountUsageSummary | null {
  if (response === null) {
    return null;
  }
  const snapshot = selectCodexSnapshot(response);
  const selected = selectDisplayWindow(snapshot);

  if (selected !== undefined) {
    const usedPercent = clampPercent(selected.usedPercent);
    return {
      cadence: describeCadence(selected.windowDurationMins),
      remainingPercent: clampPercent(100 - usedPercent),
      resetsAt: selected.resetsAt,
      usedPercent,
    };
  }

  if (snapshot.individualLimit === null) {
    return null;
  }
  const remainingPercent = clampPercent(snapshot.individualLimit.remainingPercent);
  return {
    cadence: "Limite mensal da conta",
    remainingPercent,
    resetsAt: snapshot.individualLimit.resetsAt,
    usedPercent: 100 - remainingPercent,
  };
}

export function findAccountUsageExhaustion(
  response: AccountRateLimitsResponse | null,
): AccountUsageExhaustion | null {
  if (response === null) {
    return null;
  }
  const snapshot = selectCodexSnapshot(response);
  const exhaustedWindow = [snapshot.primary, snapshot.secondary]
    .filter((window): window is RateLimitWindow =>
      window !== null && window.usedPercent >= 100,
    )
    .toSorted(compareResetTimestamp)[0];

  if (exhaustedWindow !== undefined) {
    return { resetsAt: exhaustedWindow.resetsAt };
  }
  if (snapshot.individualLimit?.remainingPercent === 0) {
    return { resetsAt: snapshot.individualLimit.resetsAt };
  }
  if (
    snapshot.spendControlReached === true
    || snapshot.rateLimitReachedType !== null
  ) {
    return { resetsAt: selectDisplayWindow(snapshot)?.resetsAt ?? null };
  }
  return null;
}

export function formatUsageResetTime(
  timestampSeconds: number | null,
): string | null {
  if (timestampSeconds === null || timestampSeconds <= 0) {
    return null;
  }
  const date = new Date(timestampSeconds * 1_000);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const day = new Intl.DateTimeFormat("pt-BR", {
    day: "numeric",
    month: "short",
  }).format(date);
  const time = new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  return `${day} às ${time}`;
}

function selectCodexSnapshot(
  response: AccountRateLimitsResponse,
): RateLimitSnapshot {
  return response.rateLimitsByLimitId?.codex ?? response.rateLimits;
}

function selectDisplayWindow(
  snapshot: RateLimitSnapshot,
): RateLimitWindow | undefined {
  const windows = [snapshot.primary, snapshot.secondary].filter(
    (window): window is RateLimitWindow => window !== null,
  );
  return windows.find((window) =>
    isApproximateDuration(window.windowDurationMins, MINUTES_PER_WEEK)
  ) ?? windows.toSorted(compareWindowDuration).at(-1);
}

function compareWindowDuration(
  left: RateLimitWindow,
  right: RateLimitWindow,
): number {
  return (left.windowDurationMins ?? -1) - (right.windowDurationMins ?? -1);
}

function compareResetTimestamp(
  left: RateLimitWindow,
  right: RateLimitWindow,
): number {
  return (left.resetsAt ?? Number.MAX_SAFE_INTEGER)
    - (right.resetsAt ?? Number.MAX_SAFE_INTEGER);
}

function describeCadence(durationMinutes: number | null): string {
  if (durationMinutes === null) {
    return "Limite de uso";
  }
  if (isApproximateDuration(durationMinutes, MINUTES_PER_WEEK)) {
    return "Renova toda semana";
  }
  if (isApproximateDuration(durationMinutes, MINUTES_PER_MONTH)) {
    return "Renova todo mês";
  }
  if (isApproximateDuration(durationMinutes, MINUTES_PER_DAY)) {
    return "Renova diariamente";
  }
  if (durationMinutes % MINUTES_PER_DAY === 0) {
    return `Renova a cada ${durationMinutes / MINUTES_PER_DAY} dias`;
  }
  if (durationMinutes % MINUTES_PER_HOUR === 0) {
    return `Renova a cada ${durationMinutes / MINUTES_PER_HOUR} horas`;
  }
  return `Renova a cada ${durationMinutes} minutos`;
}

function isApproximateDuration(
  durationMinutes: number | null,
  expectedMinutes: number,
): boolean {
  return durationMinutes !== null
    && durationMinutes >= expectedMinutes * 0.95
    && durationMinutes <= expectedMinutes * 1.05;
}

function clampPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)));
}
