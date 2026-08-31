import { formatMessage } from "../i18n/messages";
import type { TimelineMessages } from "./timelinePresentation";

const PROVIDER_HTTP_PATTERN = /^provider returned HTTP (\d{3}):\s*([\s\S]*)$/u;
const PROVIDER_STREAM_PATTERN =
  /^(provider request failed|provider temporarily unavailable|provider is temporarily overloaded):\s*(?:([a-z][a-z0-9_]*):\s*)?([\s\S]*)$/iu;
const CONTEXT_WINDOW_PATTERN =
  /^model context window exceeded:\s*(?:([a-z][a-z0-9_]*):\s*)?([\s\S]*)$/iu;
const REQUEST_ID_PATTERN =
  /request ID\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/iu;
const EDGE_REQUEST_ID_PATTERN =
  /(?:Cloudflare Ray ID|Ray ID|edge request ID)\s*:?\s*([a-z0-9][a-z0-9._:-]{2,255})/iu;
const HTML_DOCUMENT_PATTERN = /<(?:!doctype\s+html|html|head|body)\b/iu;
const MAX_VISIBLE_FAILURE_CHARACTERS = 2_000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;

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

export function presentTurnFailure(
  message: string,
  messages: TimelineMessages,
  locale: string,
): TurnFailurePresentation {
  const provider = PROVIDER_HTTP_PATTERN.exec(message);
  if (provider !== null) {
    return presentProviderHttpFailure(Number(provider[1]), provider[2] ?? "", messages, locale);
  }

  const stream = PROVIDER_STREAM_PATTERN.exec(message);
  if (stream !== null) {
    return presentProviderStreamFailure(
      stream[1] ?? "",
      stream[2] ?? null,
      stream[3] ?? "",
      messages,
    );
  }

  const context = CONTEXT_WINDOW_PATTERN.exec(message);
  if (context !== null) {
    return {
      detail: messages.failureContextDetail,
      technical: context[1] ?? "context_length_exceeded",
      title: messages.failureContextTitle,
      tone: "error",
    };
  }

  return {
    detail: boundedText(message, messages),
    technical: null,
    title: messages.failureTurnTitle,
    tone: "error",
  };
}

function presentProviderHttpFailure(
  status: number,
  body: string,
  messages: TimelineMessages,
  locale: string,
): TurnFailurePresentation {
  const details = providerErrorDetails(body, messages, locale);
  const technical = providerTechnical(`HTTP ${status}`, details.kind, details.message);

  if (
    status === 403 &&
    (details.kind === "edge_access_blocked" || HTML_DOCUMENT_PATTERN.test(body))
  ) {
    return {
      detail: messages.failureEdgeDetail,
      technical,
      title: messages.failureEdgeTitle,
      tone: "warning",
    };
  }

  if (status === 429 || details.kind === "usage_limit_reached") {
    return {
      detail:
        details.resetLabel === null
          ? messages.failureQuotaDetail
          : formatMessage(messages.failureQuotaResetDetail, { duration: details.resetLabel }),
      technical,
      title: messages.failureQuotaTitle,
      tone: "warning",
    };
  }

  if (isServerOverloaded(details.kind)) {
    return overloadedPresentation(technical, messages);
  }

  if (details.message.toLocaleLowerCase("en-US").includes("no tool output found")) {
    return {
      detail: messages.failureToolHistoryDetail,
      technical,
      title: messages.failureToolHistoryTitle,
      tone: "error",
    };
  }

  if (status >= 500) {
    return {
      detail: messages.failureTemporaryDetail,
      technical,
      title: messages.failureTemporaryTitle,
      tone: "warning",
    };
  }

  return {
    detail: details.message,
    technical,
    title: messages.failureProviderTitle,
    tone: "error",
  };
}

function presentProviderStreamFailure(
  prefix: string,
  kind: string | null,
  body: string,
  messages: TimelineMessages,
): TurnFailurePresentation {
  const technical = providerTechnical(null, kind, body);
  const normalizedPrefix = prefix.toLocaleLowerCase("en-US");
  if (normalizedPrefix.includes("overloaded") || isServerOverloaded(kind)) {
    return overloadedPresentation(technical, messages);
  }
  if (normalizedPrefix.includes("temporarily unavailable") || isTransientServerError(kind)) {
    return {
      detail: messages.failureTemporaryDetail,
      technical,
      title: messages.failureTemporaryTitle,
      tone: "warning",
    };
  }
  return {
    detail: boundedText(body || messages.failureProviderRejected, messages),
    technical,
    title: messages.failureProviderTitle,
    tone: "error",
  };
}

function overloadedPresentation(
  technical: string | null,
  messages: TimelineMessages,
): TurnFailurePresentation {
  return {
    detail: messages.failureOverloadedDetail,
    technical,
    title: messages.failureOverloadedTitle,
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

function providerErrorDetails(
  body: string,
  messages: TimelineMessages,
  locale: string,
): ProviderErrorDetails {
  const parsed = parseErrorEnvelope(body, messages, locale);
  if (parsed !== null) {
    return parsed;
  }

  const kind = /\(provider type:\s*([^)]+)\)\s*$/u.exec(body)?.[1]?.trim() ?? null;
  const compactReset = /reset in approximately\s+(\d+)d\s+(\d+)h/iu.exec(body);
  const resetLabel =
    compactReset === null
      ? null
      : formatDurationParts(Number(compactReset[1]), Number(compactReset[2]), 0, messages, locale);
  const cleaned = body
    .replace(/;\s*reset in approximately[^(]+/iu, "")
    .replace(/\s*\(provider type:[^)]+\)\s*$/iu, "");
  return {
    kind,
    message: boundedText(cleaned || messages.failureProviderRejected, messages),
    resetLabel,
  };
}

function parseErrorEnvelope(
  body: string,
  messages: TimelineMessages,
  locale: string,
): ProviderErrorDetails | null {
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
    typeof messageValue === "string" ? messageValue : messages.failureProviderRejected;
  const typeValue = recordField(error, "type");
  const codeValue = recordField(error, "code");
  const kind =
    typeof typeValue === "string" ? typeValue : typeof codeValue === "string" ? codeValue : null;
  const resetSeconds = recordField(error, "resets_in_seconds");
  const resetLabel =
    typeof resetSeconds === "number" && Number.isFinite(resetSeconds)
      ? formatDuration(Math.max(0, Math.floor(resetSeconds)), messages, locale)
      : null;
  return { kind, message: boundedText(message, messages), resetLabel };
}

function formatDuration(seconds: number, messages: TimelineMessages, locale: string): string {
  const days = Math.floor(seconds / SECONDS_PER_DAY);
  const hours = Math.floor((seconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
  const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  return formatDurationParts(days, hours, minutes, messages, locale);
}

function formatDurationParts(
  days: number,
  hours: number,
  minutes: number,
  messages: TimelineMessages,
  locale: string,
): string {
  if (days > 0) {
    return formatDurationList(
      [
        durationUnit(days, messages.oneDay, messages.manyDays),
        durationUnit(hours, messages.oneHour, messages.manyHours),
      ],
      locale,
    );
  }
  if (hours > 0) {
    return formatDurationList(
      [
        durationUnit(hours, messages.oneHour, messages.manyHours),
        durationUnit(minutes, messages.oneMinute, messages.manyMinutes),
      ],
      locale,
    );
  }
  const visibleMinutes = Math.max(1, minutes);
  return durationUnit(visibleMinutes, messages.oneMinute, messages.manyMinutes);
}

function durationUnit(value: number, singular: string, plural: string): string {
  return formatMessage(value === 1 ? singular : plural, { count: value });
}

function formatDurationList(values: readonly string[], locale: string): string {
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(values);
}

export function sanitizeInternalPaths(text: string): string {
  return text
    .replace(/[a-zA-Z]:\\[^\s:"]+/gu, "<local-path>")
    .replace(/\/(?:Users|home|root|var|usr|tmp)\/[^\s:"]+/gu, "<local-path>");
}

function boundedText(value: string, messages: TimelineMessages): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  const sanitized = sanitizeInternalPaths(normalized);
  const characters = Array.from(sanitized);
  if (characters.length <= MAX_VISIBLE_FAILURE_CHARACTERS) {
    return sanitized || messages.failureNoDetail;
  }
  return `${characters.slice(0, MAX_VISIBLE_FAILURE_CHARACTERS - 1).join("")}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(record: Readonly<Record<string, unknown>>, name: string): unknown {
  return record[name];
}
