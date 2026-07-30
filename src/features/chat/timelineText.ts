import type { JsonObject, JsonValue } from "../../shared/codex/types";

const MAX_COMMAND_OUTPUT_CHARACTERS = 128 * 1024;
const MAX_TOOL_DETAIL_CHARACTERS = 32 * 1024;
const MAX_TOOL_DETAIL_DEPTH = 8;
const MAX_TOOL_DETAIL_NODES = 500;
const MAX_TOOL_ARRAY_ITEMS = 80;
const MAX_TOOL_OBJECT_KEYS = 80;
const MAX_TOOL_STRING_CHARACTERS = 4 * 1024;

const BINARY_KEYS = new Set(["audio", "audiourl", "blob", "data", "image", "imageurl"]);
const SENSITIVE_KEYS = new Set([
  "apikey",
  "authorization",
  "cookie",
  "password",
  "refreshtoken",
  "secret",
  "token",
]);

export interface BoundedText {
  text: string;
  omittedCharacters: number;
}

interface DetailBudget {
  remainingNodes: number;
}

export function boundCommandOutput(value: string): BoundedText {
  if (value.length <= MAX_COMMAND_OUTPUT_CHARACTERS) {
    return { text: value, omittedCharacters: 0 };
  }
  return {
    text: value.slice(-MAX_COMMAND_OUTPUT_CHARACTERS),
    omittedCharacters: value.length - MAX_COMMAND_OUTPUT_CHARACTERS,
  };
}

export function appendCommandOutput(
  current: BoundedText,
  delta: string,
): BoundedText {
  if (delta.length >= MAX_COMMAND_OUTPUT_CHARACTERS) {
    return {
      text: delta.slice(-MAX_COMMAND_OUTPUT_CHARACTERS),
      omittedCharacters:
        current.omittedCharacters +
        current.text.length +
        delta.length -
        MAX_COMMAND_OUTPUT_CHARACTERS,
    };
  }
  const retainedCurrentCharacters =
    MAX_COMMAND_OUTPUT_CHARACTERS - delta.length;
  const newlyOmittedCharacters = Math.max(
    0,
    current.text.length - retainedCurrentCharacters,
  );
  return {
    text: `${current.text.slice(-retainedCurrentCharacters)}${delta}`,
    omittedCharacters:
      current.omittedCharacters + newlyOmittedCharacters,
  };
}

export function formatToolDetail(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const sanitized = sanitizeDetail(
    value,
    "",
    0,
    { remainingNodes: MAX_TOOL_DETAIL_NODES },
  );
  const serialized =
    typeof sanitized === "string"
      ? sanitized
      : JSON.stringify(sanitized, null, 2);
  if (serialized.length <= MAX_TOOL_DETAIL_CHARACTERS) {
    return serialized;
  }
  return `${serialized.slice(0, MAX_TOOL_DETAIL_CHARACTERS)}\n\n[${serialized.length - MAX_TOOL_DETAIL_CHARACTERS} caracteres adicionais omitidos da visualização]`;
}

function sanitizeDetail(
  value: JsonValue,
  key: string,
  depth: number,
  budget: DetailBudget,
): JsonValue {
  const normalizedKey = normalizeKey(key);
  if (SENSITIVE_KEYS.has(normalizedKey)) {
    return "[valor sensível omitido da visualização]";
  }
  if (typeof value === "string") {
    if (
      value.startsWith("data:") ||
      (BINARY_KEYS.has(normalizedKey) && value.length > 256)
    ) {
      return `[payload binário de ${value.length} caracteres omitido da visualização]`;
    }
    if (value.length > MAX_TOOL_STRING_CHARACTERS) {
      return `${value.slice(0, MAX_TOOL_STRING_CHARACTERS)}\n[${value.length - MAX_TOOL_STRING_CHARACTERS} caracteres omitidos]`;
    }
    return value;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= MAX_TOOL_DETAIL_DEPTH) {
    return "[estrutura profunda omitida da visualização]";
  }
  if (budget.remainingNodes <= 0) {
    return "[estrutura adicional omitida da visualização]";
  }
  budget.remainingNodes -= 1;

  if (Array.isArray(value)) {
    return sanitizeArray(value, depth, budget);
  }
  return sanitizeObject(value, depth, budget);
}

function sanitizeArray(
  value: JsonValue[],
  depth: number,
  budget: DetailBudget,
): JsonValue[] {
  const result: JsonValue[] = [];
  const visibleCount = Math.min(value.length, MAX_TOOL_ARRAY_ITEMS);
  for (let index = 0; index < visibleCount; index += 1) {
    if (budget.remainingNodes <= 0) {
      result.push(
        `[${value.length - index} itens adicionais omitidos da visualização]`,
      );
      return result;
    }
    result.push(sanitizeDetail(value[index] ?? null, String(index), depth + 1, budget));
  }
  if (value.length > visibleCount) {
    result.push(
      `[${value.length - visibleCount} itens adicionais omitidos da visualização]`,
    );
  }
  return result;
}

function sanitizeObject(
  value: JsonObject,
  depth: number,
  budget: DetailBudget,
): JsonObject {
  const result: JsonObject = {};
  const entries = Object.entries(value);
  const visibleCount = Math.min(entries.length, MAX_TOOL_OBJECT_KEYS);
  for (let index = 0; index < visibleCount; index += 1) {
    const entry = entries[index];
    if (entry === undefined) {
      continue;
    }
    if (budget.remainingNodes <= 0) {
      result.__visualizationNotice =
        `${entries.length - index} campos adicionais omitidos da visualização`;
      return result;
    }
    const [key, candidate] = entry;
    result[key] = sanitizeDetail(candidate, key, depth + 1, budget);
  }
  if (entries.length > visibleCount) {
    result.__visualizationNotice =
      `${entries.length - visibleCount} campos adicionais omitidos da visualização`;
  }
  return result;
}

function normalizeKey(value: string): string {
  return value.replaceAll(/[-_]/g, "").toLocaleLowerCase("en-US");
}
