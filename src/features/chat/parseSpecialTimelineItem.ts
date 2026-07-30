import {
  isJsonObject,
  readString,
  type JsonObject,
  type JsonValue,
} from "../../shared/codex/types";
import {
  invalid,
  lifecycleStatus,
  parsed,
  type ParseResult,
} from "./timelineParsing";
import { formatNarrativeText } from "./timelineText";
import type {
  HookPromptEntry,
  HookPromptFragment,
  ImageGenerationEntry,
  ReviewEntry,
  SleepEntry,
  WebSearchAction,
  WebSearchEntry,
} from "./timelineTypes";

export function parseHookPromptItem(
  id: string,
  item: JsonObject,
  completed: boolean,
): ParseResult<HookPromptEntry> {
  if (!Array.isArray(item.fragments)) {
    return invalid(id, "não contém os fragmentos do hook");
  }
  const fragments: HookPromptFragment[] = [];
  for (const candidate of item.fragments) {
    if (!isJsonObject(candidate)) {
      return invalid(id, "contém um fragmento de hook inválido");
    }
    const text = readString(candidate, "text");
    const hookRunId = readString(candidate, "hookRunId");
    if (text === undefined || hookRunId === undefined) {
      return invalid(id, "contém um fragmento de hook incompleto");
    }
    fragments.push({ text: formatNarrativeText(text), hookRunId });
  }
  return parsed({
    type: "hookPrompt",
    id,
    fragments,
    status: lifecycleStatus(completed),
  });
}

export function parseWebSearchItem(
  id: string,
  item: JsonObject,
  completed: boolean,
): ParseResult<WebSearchEntry> {
  const query = readString(item, "query");
  if (query === undefined) {
    return invalid(id, "não contém a consulta da pesquisa");
  }
  const action = parseWebSearchAction(item.action);
  if (action === undefined) {
    return invalid(id, "contém uma ação de pesquisa inválida");
  }
  const results = item.results;
  if (results !== null && !Array.isArray(results)) {
    return invalid(id, "contém resultados de pesquisa inválidos");
  }
  return parsed({
    type: "webSearch",
    id,
    query,
    action,
    resultCount: Array.isArray(results) ? results.length : null,
    status: lifecycleStatus(completed),
  });
}

export function parseSleepItem(
  id: string,
  item: JsonObject,
  completed: boolean,
): ParseResult<SleepEntry> {
  const durationMs = item.durationMs;
  if (
    typeof durationMs !== "number" ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0
  ) {
    return invalid(id, "não contém uma duração de espera válida");
  }
  return parsed({
    type: "sleep",
    id,
    durationMs,
    status: lifecycleStatus(completed),
  });
}

export function parseImageGenerationItem(
  id: string,
  item: JsonObject,
  completed: boolean,
): ParseResult<ImageGenerationEntry> {
  const providerStatus = readString(item, "status");
  const revisedPrompt = item.revisedPrompt;
  const result = item.result;
  const savedPath = item.savedPath;
  if (
    providerStatus === undefined ||
    (revisedPrompt !== null && typeof revisedPrompt !== "string") ||
    typeof result !== "string" ||
    (savedPath !== undefined && typeof savedPath !== "string")
  ) {
    return invalid(id, "contém um resultado de geração de imagem inválido");
  }
  return parsed({
    type: "imageGeneration",
    id,
    revisedPrompt:
      typeof revisedPrompt === "string"
        ? formatNarrativeText(revisedPrompt)
        : null,
    savedPath: typeof savedPath === "string" ? savedPath : null,
    resultAvailable: result.length > 0,
    providerStatus,
    status:
      providerStatus === "failed"
        ? "failed"
        : providerStatus === "in_progress"
          ? "inProgress"
          : lifecycleStatus(completed),
  });
}

export function parseReviewItem(
  id: string,
  item: JsonObject,
  event: ReviewEntry["event"],
): ParseResult<ReviewEntry> {
  const review = readString(item, "review");
  return review === undefined
    ? invalid(id, "não contém o texto da revisão")
    : parsed({
        type: "review",
        id,
        event,
        review: formatNarrativeText(review),
      });
}

function parseWebSearchAction(
  value: JsonValue | undefined,
): WebSearchAction | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isJsonObject(value)) {
    return undefined;
  }
  const type = readString(value, "type");
  switch (type) {
    case "search": {
      const query = readNullableString(value.query);
      const queries = readNullableStringArray(value.queries);
      return query === undefined || queries === undefined
        ? undefined
        : { type, query, queries: queries ?? [] };
    }
    case "openPage": {
      const url = readNullableString(value.url);
      return url === undefined
        ? undefined
        : { type, source: url === null ? null : urlSource(url) };
    }
    case "findInPage": {
      const url = readNullableString(value.url);
      const pattern = readNullableString(value.pattern);
      return url === undefined || pattern === undefined
        ? undefined
        : {
            type,
            source: url === null ? null : urlSource(url),
            pattern,
          };
    }
    case "other":
      return { type };
    default:
      return undefined;
  }
}

function readNullableString(
  value: JsonValue | undefined,
): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function readNullableStringArray(
  value: JsonValue | undefined,
): string[] | null | undefined {
  if (value === null) {
    return null;
  }
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function urlSource(value: string): string {
  try {
    return new URL(value).hostname || "origem não identificada";
  } catch {
    return "origem não identificada";
  }
}
