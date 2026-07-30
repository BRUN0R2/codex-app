import {
  isJsonObject,
  type ConfigWarningNotification,
  type JsonObject,
  type JsonValue,
  type TextPosition,
  type TextRange,
} from "../../shared/codex/types";

export function parseConfigWarning(
  value: JsonValue | undefined,
): ConfigWarningNotification {
  if (!isJsonObject(value)) {
    throw incompatibleNotification();
  }

  const summary = value.summary;
  const details = value.details;
  if (
    typeof summary !== "string"
    || (details !== null && typeof details !== "string")
  ) {
    throw incompatibleNotification();
  }

  const path = parseOptionalString(value, "path");
  const range = parseOptionalRange(value.range);
  return {
    summary,
    details,
    ...(path === undefined ? {} : { path }),
    ...(range === undefined ? {} : { range }),
  };
}

function parseOptionalString(
  object: JsonObject,
  key: string,
): string | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw incompatibleNotification();
  }
  return value;
}

function parseOptionalRange(value: JsonValue | undefined): TextRange | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    throw incompatibleNotification();
  }
  return {
    start: parsePosition(value.start),
    end: parsePosition(value.end),
  };
}

function parsePosition(value: JsonValue | undefined): TextPosition {
  if (!isJsonObject(value)) {
    throw incompatibleNotification();
  }
  const line = value.line;
  const column = value.column;
  if (!isOneBasedIndex(line) || !isOneBasedIndex(column)) {
    throw incompatibleNotification();
  }
  return { line, column };
}

function isOneBasedIndex(value: JsonValue | undefined): value is number {
  return (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
  );
}

function incompatibleNotification(): Error {
  return new Error("Notificação incompatível do Codex em configWarning.");
}
