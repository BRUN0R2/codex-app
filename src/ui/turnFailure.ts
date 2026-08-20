const PROVIDER_HTTP_PATTERN = /^provider returned HTTP (\d{3}):\s*([\s\S]*)$/u;
const PROVIDER_STREAM_PATTERN =
  /^(provider request failed|provider temporarily unavailable|provider is temporarily overloaded):\s*(?:([a-z][a-z0-9_]*):\s*)?([\s\S]*)$/iu;
const CONTEXT_WINDOW_PATTERN =
  /^model context window exceeded:\s*(?:([a-z][a-z0-9_]*):\s*)?([\s\S]*)$/iu;
const REQUEST_ID_PATTERN =
  /(?:request ID|ID da solicitação)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/iu;
const EDGE_REQUEST_ID_PATTERN =
  /(?:Cloudflare Ray ID|Ray ID|edge request ID)\s*:?\s*([a-z0-9][a-z0-9._:-]{2,255})/iu;
const HTML_DOCUMENT_PATTERN = /<(?:!doctype\s+html|html|head|body)\b/iu;
const MAX_VISIBLE_FAILURE_CHARACTERS = 2_000;

export interface TurnFailurePresentation {
  readonly detail: string;
  readonly technical: string | null;
  readonly title: string;
  readonly tone: "error" | "warning";
}

interface ProviderErrorDetails {
  readonly kind: string | null;
  readonly message: string;
  readonly resetLabel: string | null;
}

export function presentTurnFailure(message: string): TurnFailurePresentation {
  const provider = PROVIDER_HTTP_PATTERN.exec(message);
  if (provider !== null) {
    return presentProviderHttpFailure(Number(provider[1]), provider[2] ?? "");
  }

  const stream = PROVIDER_STREAM_PATTERN.exec(message);
  if (stream !== null) {
    return presentProviderStreamFailure(stream[1] ?? "", stream[2] ?? null, stream[3] ?? "");
  }

  const context = CONTEXT_WINDOW_PATTERN.exec(message);
  if (context !== null) {
    return {
      detail:
        "Não foi possível liberar espaço suficiente na conversa. Compacte o contexto ou inicie uma nova conversa.",
      technical: context[1] ?? "context_length_exceeded",
      title: "Contexto da conversa excedido",
      tone: "error",
    };
  }

  return {
    detail: boundedText(message),
    technical: null,
    title: "O turno falhou",
    tone: "error",
  };
}

function presentProviderHttpFailure(status: number, body: string): TurnFailurePresentation {
  const details = providerErrorDetails(body);
  const technical = providerTechnical(`HTTP ${status}`, details.kind, details.message);

  if (
    status === 403 &&
    (details.kind === "edge_access_blocked" || HTML_DOCUMENT_PATTERN.test(body))
  ) {
    return {
      detail:
        "A camada de segurança da OpenAI bloqueou a conexão antes de a solicitação chegar ao modelo. Tente novamente; se persistir, desative VPN ou proxy e confirme que o ChatGPT abre normalmente nessa rede.",
      technical,
      title: "Conexão bloqueada pela borda da OpenAI",
      tone: "warning",
    };
  }

  if (status === 429 || details.kind === "usage_limit_reached") {
    return {
      detail:
        details.resetLabel === null
          ? "A conta atingiu a cota do Codex. Aguarde a renovação indicada no uso da conta."
          : `A conta atingiu a cota do Codex. Tente novamente em aproximadamente ${details.resetLabel}.`,
      technical,
      title: "Limite de uso atingido",
      tone: "warning",
    };
  }

  if (isServerOverloaded(details.kind)) {
    return overloadedPresentation(technical);
  }

  if (details.message.toLocaleLowerCase("en-US").includes("no tool output found")) {
    return {
      detail:
        "Uma chamada de ferramenta antiga ficou sem resultado. A versão atual corrige esse histórico automaticamente antes do próximo turno.",
      technical,
      title: "Histórico de ferramentas incompleto",
      tone: "error",
    };
  }

  if (status >= 500) {
    return {
      detail:
        "O serviço não conseguiu processar a solicitação neste momento. Tente novamente em alguns instantes.",
      technical,
      title: "Instabilidade temporária no serviço",
      tone: "warning",
    };
  }

  return {
    detail: details.message,
    technical,
    title: "O provider recusou o turno",
    tone: "error",
  };
}

function presentProviderStreamFailure(
  prefix: string,
  kind: string | null,
  body: string,
): TurnFailurePresentation {
  const technical = providerTechnical(null, kind, body);
  const normalizedPrefix = prefix.toLocaleLowerCase("en-US");
  if (normalizedPrefix.includes("overloaded") || isServerOverloaded(kind)) {
    return overloadedPresentation(technical);
  }
  if (normalizedPrefix.includes("temporarily unavailable") || isTransientServerError(kind)) {
    return {
      detail:
        "O serviço encontrou uma instabilidade temporária. Tente novamente em alguns instantes.",
      technical,
      title: "Instabilidade temporária no serviço",
      tone: "warning",
    };
  }
  return {
    detail: boundedText(body || "O provider rejeitou a solicitação."),
    technical,
    title: "O provider recusou o turno",
    tone: "error",
  };
}

function overloadedPresentation(technical: string | null): TurnFailurePresentation {
  return {
    detail: "O serviço está com alta demanda no momento. Tente novamente em alguns instantes.",
    technical,
    title: "Serviço temporariamente ocupado",
    tone: "warning",
  };
}

function providerTechnical(
  primary: string | null,
  kind: string | null,
  message: string,
): string | null {
  const requestId = REQUEST_ID_PATTERN.exec(message)?.[1] ?? null;
  const edgeRequestId = EDGE_REQUEST_ID_PATTERN.exec(message)?.[1] ?? null;
  const parts = [
    primary,
    kind,
    requestId === null ? null : `ID ${requestId}`,
    edgeRequestId === null ? null : `Ray ${edgeRequestId}`,
  ].filter((part): part is string => part !== null && part.length > 0);
  return parts.length === 0 ? null : parts.join(" · ");
}

function isServerOverloaded(kind: string | null): boolean {
  return (
    kind === "server_is_overloaded" || kind === "server_overloaded" || kind === "overloaded_error"
  );
}

function isTransientServerError(kind: string | null): boolean {
  return (
    kind === "server_error" ||
    kind === "internal_server_error" ||
    kind === "service_unavailable" ||
    kind === "temporarily_unavailable" ||
    kind === "upstream_error" ||
    kind === "gateway_timeout"
  );
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

export function sanitizeInternalPaths(text: string): string {
  return text
    .replace(/[a-zA-Z]:\\[^\s:"]+/gu, "<caminho-local>")
    .replace(/\/(?:Users|home|root|var|usr|tmp)\/[^\s:"]+/gu, "<caminho-local>");
}

function boundedText(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  const sanitized = sanitizeInternalPaths(normalized);
  const characters = Array.from(sanitized);
  if (characters.length <= MAX_VISIBLE_FAILURE_CHARACTERS) {
    return sanitized || "O turno falhou sem fornecer um detalhe.";
  }
  return `${characters.slice(0, MAX_VISIBLE_FAILURE_CHARACTERS - 1).join("")}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(record: Readonly<Record<string, unknown>>, name: string): unknown {
  return record[name];
}
