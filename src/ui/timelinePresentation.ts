import type { ActivityStatus, CommandLiveOutput, FileChange, TurnStatus } from "../contracts/types";

export type ThinkingPresentation = "activity" | "none" | "standalone";
export const LONG_COMMAND_DURATION_THRESHOLD_MS = 10_000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const USER_MESSAGE_PROXIMITY_WEIGHTS = {
  current: 25,
  adjacent: 20,
  nearby: 14,
  remote: 10,
  minimum: 7,
} as const;

export function thinkingPresentation(
  status: TurnStatus,
  finalAnswerStarted: boolean,
  latestWorkOwnsHeadline: boolean,
): ThinkingPresentation {
  if (status !== "inProgress" || finalAnswerStarted) {
    return "none";
  }
  return latestWorkOwnsHeadline ? "activity" : "standalone";
}

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

export function formatElapsedSeconds(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  if (totalSeconds < SECONDS_PER_MINUTE) {
    return `${totalSeconds} s`;
  }
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const remainder = totalSeconds % SECONDS_PER_MINUTE;
  if (hours === 0) {
    return `${minutes} min ${remainder} s`;
  }
  return `${hours} h ${minutes} min ${remainder} s`;
}

export function formatCompactElapsedSeconds(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  if (totalSeconds < SECONDS_PER_MINUTE) {
    return `${totalSeconds}s`;
  }
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const remainder = totalSeconds % SECONDS_PER_MINUTE;
  if (hours === 0) {
    return `${minutes}m ${remainder}s`;
  }
  return `${hours}h ${minutes}m ${remainder}s`;
}

export function runningCommandHeadline(duration: string | null, fallback: string): string {
  return duration === null ? fallback : `Comando em execução há ${duration}`;
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
  if (expanded) {
    return activityStateTitle("comando", status);
  }
  switch (status) {
    case "completed":
      return `Comando executado: ${command}`;
    case "declined":
      return `Comando recusado: ${command}`;
    case "failed":
      return `Falha ao executar comando: ${command}`;
    case "inProgress":
      return `Executando comando: ${command}`;
  }
}

export function visibleCommandDurationMs(
  status: ActivityStatus,
  startedAt: number | null,
  durationMs: number | null,
  now: number,
): number | null {
  const elapsed =
    status === "inProgress"
      ? startedAt === null
        ? null
        : Math.max(0, now - startedAt)
      : durationMs;
  return elapsed !== null && elapsed >= LONG_COMMAND_DURATION_THRESHOLD_MS ? elapsed : null;
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

export function commandPollActivityTitle(status: ActivityStatus): string {
  switch (status) {
    case "completed":
      return "Comando verificado";
    case "declined":
      return "Verificação do comando recusada";
    case "failed":
      return "Falha ao verificar comando";
    case "inProgress":
      return "Verificando comando";
  }
}

export function terminalReadActivityTitle(status: ActivityStatus): string {
  switch (status) {
    case "completed":
      return "Terminal do chat lido";
    case "declined":
      return "Leitura do terminal do chat recusada";
    case "failed":
      return "Falha ao ler o terminal do chat";
    case "inProgress":
      return "Lendo terminal do chat";
  }
}

export function fileReadActivityTitle(status: ActivityStatus, count?: number): string {
  const target = fileReadTarget(count);
  switch (status) {
    case "completed":
      return `Executou leitura de ${target}`;
    case "declined":
      return `Leitura de ${target} recusada`;
    case "failed":
      return `Falha ao ler ${target}`;
    case "inProgress":
      return `Lendo ${target}`;
  }
}

export function fileChangeGroupTitle(changeCount: number): string {
  return changeCount === 1 ? "1 arquivo alterado" : `${changeCount} arquivos alterados`;
}

export function fileChangeActionLabel(kind: FileChange["kind"]["type"]): string {
  switch (kind) {
    case "add":
      return "Arquivo criado";
    case "delete":
      return "Arquivo excluído";
    case "update":
      return "Arquivo editado";
  }
}

export function commandOutputText(output: string | null | undefined): string | null {
  if (typeof output !== "string" || output.length === 0) {
    return null;
  }
  const header = /^exit_code:\s*-?\d+\r?\nstdout:\r?\n/u.exec(output);
  if (header === null) {
    return output;
  }
  const body = output.slice(header[0].length);
  const stderrMarker = /\r?\nstderr:\r?\n/gu;
  let marker: RegExpExecArray | null = null;
  for (let match = stderrMarker.exec(body); match !== null; match = stderrMarker.exec(body)) {
    marker = match;
  }
  if (marker === null) {
    const partial = body.trimEnd();
    return partial.length > 0 ? partial : null;
  }
  const stdout = body.slice(0, marker.index).trimEnd();
  const stderr = body.slice(marker.index + marker[0].length).trimEnd();
  const visible = [stdout, stderr].filter(Boolean).join("\n");
  return visible.length > 0 ? visible : null;
}

export function commandLiveOutputText(output: CommandLiveOutput | null): string | null {
  if (output === null) {
    return null;
  }
  const sections: string[] = [];
  if (output.stdout.length > 0) {
    sections.push(output.stderr.length > 0 ? `stdout:\n${output.stdout}` : output.stdout);
  }
  if (output.stderr.length > 0) {
    sections.push(`stderr:\n${output.stderr}`);
  }
  if (output.truncated) {
    sections.push("[Prévia ao vivo limitada; a saída completa estará disponível ao concluir.]");
  }
  return sections.length === 0 ? null : sections.join("\n");
}

export function toolOutputText(output: string | null | undefined): string | null {
  return typeof output === "string" && output.length > 0 ? output : null;
}

export function userMessageMarkerWidth(index: number, interactionIndex: number | null): number {
  if (interactionIndex === null) {
    return USER_MESSAGE_PROXIMITY_WEIGHTS.minimum;
  }
  switch (Math.abs(index - interactionIndex)) {
    case 0:
      return USER_MESSAGE_PROXIMITY_WEIGHTS.current;
    case 1:
      return USER_MESSAGE_PROXIMITY_WEIGHTS.adjacent;
    case 2:
      return USER_MESSAGE_PROXIMITY_WEIGHTS.nearby;
    case 3:
      return USER_MESSAGE_PROXIMITY_WEIGHTS.remote;
    default:
      return USER_MESSAGE_PROXIMITY_WEIGHTS.minimum;
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

function fileReadTarget(count: number | undefined): string {
  if (count === undefined) {
    return "arquivo";
  }
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError(`A quantidade de arquivos lidos deve ser um inteiro positivo: ${count}.`);
  }
  return count === 1 ? "um arquivo" : `${count} arquivos`;
}

function activityFailureTitle(
  label: string,
  status: Exclude<ActivityStatus, "completed" | "inProgress">,
): string {
  return status === "declined" ? `Recusou ${label}` : `Falhou ao executar ${label}`;
}
