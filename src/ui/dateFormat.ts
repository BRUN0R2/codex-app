export function formatShortDate(resetAt: number, locale: string, soonLabel: string): string {
  if (!Number.isFinite(resetAt)) {
    return soonLabel;
  }
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(new Date(resetAt));
}

export function formatShortDateWithTimeZone(
  timestamp: number,
  locale: string,
  soonLabel: string,
): string {
  if (!Number.isFinite(timestamp)) {
    return soonLabel;
  }
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "numeric",
    timeZoneName: "short",
  }).format(new Date(timestamp));
}
