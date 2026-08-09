export function formatShortDate(resetAt: number): string {
  if (!Number.isFinite(resetAt)) {
    return "em breve";
  }
  return new Intl.DateTimeFormat("pt-BR", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(new Date(resetAt));
}
