import type { ActivityStatus, TurnStatus } from "../contracts/types";

export function turnDurationLabel(status: TurnStatus, duration: string): string {
  switch (status) {
    case "completed":
      return `Trabalhou por ${duration}`;
    case "failed":
      return `Falhou após ${duration}`;
    case "inProgress":
      return `Processando há ${duration}`;
    case "interrupted":
      return `Interrompido após ${duration}`;
  }
}

export function reasoningTitle(summary: readonly string[], content: readonly string[]): string {
  const source = lastNonEmpty(summary) ?? lastNonEmpty(content);
  if (source === null) {
    return "Pensamento do assistente";
  }
  const firstLine = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (firstLine === undefined) {
    return "Pensamento do assistente";
  }
  if (firstLine.startsWith("**")) {
    const closingMarker = firstLine.indexOf("**", 2);
    if (closingMarker > 2) {
      return firstLine.slice(2, closingMarker).trim();
    }
  }
  return firstLine.replace(/^#{1,6}\s+/u, "").replace(/\s+/gu, " ");
}

export function commandActivityTitle(
  command: string,
  status: ActivityStatus,
  expanded: boolean,
): string {
  if (status === "inProgress") {
    return expanded ? "Executando comando" : `Executando ${command}`;
  }
  if (!expanded) {
    return status === "completed" ? `Executou ${command}` : activityFailureTitle(command, status);
  }
  return activityStateTitle("comando", status);
}

export function toolActivityTitle(
  description: string,
  status: ActivityStatus,
  expanded: boolean,
): string {
  if (status === "inProgress") {
    return expanded ? "Executando ferramenta" : description;
  }
  if (!expanded) {
    return status === "completed"
      ? `Executou ${description}`
      : activityFailureTitle(description, status);
  }
  return activityStateTitle("ferramenta", status);
}

export function fileChangeActivityTitle(
  changes: readonly { readonly kind: { readonly type: "add" | "delete" | "update" } }[],
): string {
  if (changes.length !== 1) {
    return `${changes.length} arquivos alterados`;
  }
  switch (changes[0]?.kind.type) {
    case "add":
      return "Arquivo criado";
    case "delete":
      return "Arquivo excluído";
    case "update":
      return "Arquivo editado";
    default:
      return "Arquivo alterado";
  }
}

export function commandOutputText(output: string | null): string | null {
  if (output === null || output.length === 0) {
    return null;
  }
  const structured =
    /^exit_code:\s*-?\d+\r?\nstdout:\r?\n([\s\S]*?)\r?\nstderr:\r?\n([\s\S]*)$/u.exec(output);
  if (structured === null) {
    return output;
  }
  const stdout = structured[1]?.trimEnd() ?? "";
  const stderr = structured[2]?.trimEnd() ?? "";
  const visible = [stdout, stderr].filter(Boolean).join("\n");
  return visible.length > 0 ? visible : null;
}

export function userMessageMarkerWidth(index: number, interactionIndex: number | null): number {
  if (interactionIndex === null) {
    return 7;
  }
  switch (Math.abs(index - interactionIndex)) {
    case 0:
      return 25;
    case 1:
      return 20;
    case 2:
      return 14;
    case 3:
      return 10;
    default:
      return 7;
  }
}

function lastNonEmpty(values: readonly string[]): string | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function activityStateTitle(kind: "comando" | "ferramenta", status: ActivityStatus): string {
  const feminine = kind === "ferramenta";
  switch (status) {
    case "completed":
      return feminine ? "Ferramenta executada" : "Comando executado";
    case "declined":
      return feminine ? "Ferramenta recusada" : "Comando recusado";
    case "failed":
      return feminine ? "Ferramenta falhou" : "Comando falhou";
    case "inProgress":
      return feminine ? "Executando ferramenta" : "Executando comando";
  }
}

function activityFailureTitle(
  label: string,
  status: Exclude<ActivityStatus, "completed" | "inProgress">,
): string {
  return status === "declined" ? `Recusou ${label}` : `Falhou ao executar ${label}`;
}
