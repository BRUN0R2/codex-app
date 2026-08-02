const PROVIDER_HTTP_PATTERN = /^provider returned HTTP (\d{3}):\s*([\s\S]*)$/u;
const MAX_VISIBLE_FAILURE_CHARACTERS = 2_000;

export interface TurnFailurePresentation {
  readonly detail: string;
  readonly technical: string | null;
  readonly title: string;
}

interface ProviderErrorDetails {
  readonly kind: string | null;
  readonly message: string;
  readonly resetLabel: string | null;
}

export function presentTurnFailure(message: string): TurnFailurePresentation {
  const provider = PROVIDER_HTTP_PATTERN.exec(message);
  if (provider === null) {
    return {
      detail: boundedText(message),
      technical: null,
      title: "O turno falhou",
    };
  }

  const status = Number(provider[1]);
  const details = providerErrorDetails(provider[2] ?? "");
  const technical = [`HTTP ${status}`, details.kind].filter(Boolean).join(" · ");

  if (status === 429 || details.kind === "usage_limit_reached") {
    return {
      detail:
        details.resetLabel === null
          ? "A conta atingiu a cota do Codex. Aguarde a renovação indicada no uso da conta."
          : `A conta atingiu a cota do Codex. Tente novamente em aproximadamente ${details.resetLabel}.`,
      technical,
      title: "Limite de uso atingido",
    };
  }

  if (details.message.toLocaleLowerCase("en-US").includes("no tool output found")) {
    return {
      detail:
        "Uma chamada de ferramenta antiga ficou sem resultado. A versão atual corrige esse histórico automaticamente antes do próximo turno.",
      technical,
      title: "Histórico de ferramentas incompleto",
    };
  }

  return {
    detail: details.message,
    technical,
    title: status >= 500 ? "O provider está indisponível" : "O provider recusou o turno",
  };
}

function providerErrorDetails(body: string): ProviderErrorDetails {
  const parsed = parseErrorEnvelope(body);
  if (parsed !== null) {
    return parsed;
  }

  const kind = /\(provider type:\s*([^)]+)\)\s*$/u.exec(body)?.[1]?.trim() ?? null;
  const compactReset = /reset in approximately\s+(\d+)d\s+(\d+)h/iu.exec(body);
  const resetLabel =
    compactReset === null
      ? null
      : formatDurationParts(Number(compactReset[1]), Number(compactReset[2]), 0);
  const cleaned = body
    .replace(/;\s*reset in approximately[^(]+/iu, "")
    .replace(/\s*\(provider type:[^)]+\)\s*$/iu, "");
  return {
    kind,
    message: boundedText(cleaned || "O provider rejeitou a solicitação."),
    resetLabel,
  };
}

function parseErrorEnvelope(body: string): ProviderErrorDetails | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(decoded)) {
    return null;
  }
  const nestedError = recordField(decoded, "error");
  const error = isRecord(nestedError) ? nestedError : decoded;
  const messageValue = recordField(error, "message");
  const message =
    typeof messageValue === "string" ? messageValue : "O provider rejeitou a solicitação.";
  const typeValue = recordField(error, "type");
  const codeValue = recordField(error, "code");
  const kind =
    typeof typeValue === "string" ? typeValue : typeof codeValue === "string" ? codeValue : null;
  const resetSeconds = recordField(error, "resets_in_seconds");
  const resetLabel =
    typeof resetSeconds === "number" && Number.isFinite(resetSeconds)
      ? formatDuration(Math.max(0, Math.floor(resetSeconds)))
      : null;
  return { kind, message: boundedText(message), resetLabel };
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return formatDurationParts(days, hours, minutes);
}

function formatDurationParts(days: number, hours: number, minutes: number): string {
  if (days > 0) {
    return `${days} ${days === 1 ? "dia" : "dias"} e ${hours} ${hours === 1 ? "hora" : "horas"}`;
  }
  if (hours > 0) {
    return `${hours} ${hours === 1 ? "hora" : "horas"} e ${minutes} ${minutes === 1 ? "minuto" : "minutos"}`;
  }
  const visibleMinutes = Math.max(1, minutes);
  return `${visibleMinutes} ${visibleMinutes === 1 ? "minuto" : "minutos"}`;
}

function boundedText(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  const characters = Array.from(normalized);
  if (characters.length <= MAX_VISIBLE_FAILURE_CHARACTERS) {
    return normalized || "O turno falhou sem fornecer um detalhe.";
  }
  return `${characters.slice(0, MAX_VISIBLE_FAILURE_CHARACTERS - 1).join("")}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(record: Readonly<Record<string, unknown>>, name: string): unknown {
  return record[name];
}
