import { exceedsUtf8ByteLength, utf8ByteLength } from "../../utf8";
import type { CommandError, CommandLiveOutput, ThreadOutput } from "../types";

export type UnknownRecord = Record<string, unknown>;

export const MAX_STRING_BYTES = 4 * 1_048_576;
export const MAX_COLLECTION_LENGTH = 10_000;
export const MAX_OUTPUT_CHUNK_BYTES = 64 * 1_024;
export const DECIMAL_CURSOR_MAXIMUM_CHARACTERS = 20;
export const THREAD_HISTORY_CURSOR_MAXIMUM_CHARACTERS = 1_024;
export const ACCOUNT_PROFILE_DAILY_USAGE_MAXIMUM_ENTRIES = 800;
export const AUTOMATION_INTERVAL_MINIMUM_MINUTES = 5;
export const AUTOMATION_INTERVAL_MAXIMUM_MINUTES = 10_080;
export const TIMEZONE_OFFSET_MINIMUM_MINUTES = -840;
export const TIMEZONE_OFFSET_MAXIMUM_MINUTES = 840;
export const UI_FONT_SIZE_MINIMUM = 12;
export const UI_FONT_SIZE_MAXIMUM = 24;

export class ContractError extends Error {
  public readonly path: string;

  public constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ContractError";
    this.path = path;
  }
}

export function decodeCommandError(value: unknown): CommandError | null {
  try {
    const object = exactRecord(value, "$", ["code", "message", "retryable"]);
    return {
      code: text(object.code, "$.code", 128),
      message: text(object.message, "$.message"),
      retryable: booleanValue(object.retryable, "$.retryable"),
    };
  } catch {
    return null;
  }
}

export function decodeOperationFailure(value: unknown, path: string) {
  const object = exactRecord(value, path, ["code", "message"]);
  return {
    code: text(object.code, `${path}.code`, 128),
    message: text(object.message, `${path}.message`),
  };
}

export function decodeStreamDeltaPayload(value: unknown, path: string) {
  const object = record(value, path);
  const kind = text(field(object, "kind"), `${path}.kind`, 32);
  switch (kind) {
    case "agentText": {
      const delta = exactRecord(object, path, ["delta", "itemId", "kind"]);
      return {
        kind,
        itemId: identifier(delta.itemId, `${path}.itemId`),
        delta: text(delta.delta, `${path}.delta`, 262_144, true),
      };
    }
    case "reasoningSummary":
    case "reasoningText": {
      const delta = exactRecord(object, path, ["delta", "index", "itemId", "kind"]);
      return {
        kind,
        itemId: identifier(delta.itemId, `${path}.itemId`),
        index: integer(delta.index, `${path}.index`, 0, 1_024),
        delta: text(delta.delta, `${path}.delta`, 262_144, true),
      };
    }
    case "commandOutput": {
      const delta = exactRecord(object, path, ["itemId", "kind", "operation", "stream"]);
      const operationPath = `${path}.operation`;
      const operationRecord = record(delta.operation, operationPath);
      const operationType = text(field(operationRecord, "type"), `${operationPath}.type`, 32);
      const operation =
        operationType === "append"
          ? (() => {
              const append = exactRecord(operationRecord, operationPath, ["delta", "type"]);
              return {
                type: "append" as const,
                delta: text(append.delta, `${operationPath}.delta`, 8 * 1_024, true),
              };
            })()
          : {
              type: literal(operationType, `${operationPath}.type`, [
                "backspace",
                "clearCurrentLine",
                "truncated",
              ] as const),
            };
      exactKeys(
        operationRecord,
        operationPath,
        operation.type === "append" ? ["delta", "type"] : ["type"],
      );
      return {
        kind,
        itemId: identifier(delta.itemId, `${path}.itemId`),
        stream: literal(delta.stream, `${path}.stream`, ["stderr", "stdout"] as const),
        operation,
      };
    }
    default:
      throw new ContractError(`${path}.kind`, `unsupported stream delta ${JSON.stringify(kind)}`);
  }
}

export function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  path: string,
  keys: Keys,
): Record<Keys[number], unknown> {
  const object = record(value, path);
  exactKeys(object, path, keys);
  return object as Record<Keys[number], unknown>;
}

export function field(object: UnknownRecord, key: string): unknown {
  return object[key];
}

export function record(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractError(path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ContractError(path, "expected a plain object");
  }
  return value as UnknownRecord;
}

export function exactKeys(object: UnknownRecord, path: string, expected: readonly string[]): void {
  let actualKeyCount = 0;
  let unexpectedKey = false;
  for (const key in object) {
    if (!Object.hasOwn(object, key)) {
      continue;
    }
    actualKeyCount += 1;
    unexpectedKey ||= !expected.includes(key);
  }
  if (actualKeyCount !== expected.length || unexpectedKey) {
    const actual = Object.keys(object).sort();
    const sortedExpected = [...expected].sort();
    throw new ContractError(
      path,
      `expected keys ${sortedExpected.join(", ")}; received ${actual.join(", ")}`,
    );
  }
}

export function array<T>(
  value: unknown,
  path: string,
  decode: (entry: unknown, path: string) => T,
  maximumLength = MAX_COLLECTION_LENGTH,
): readonly T[] {
  if (!Array.isArray(value)) {
    throw new ContractError(path, "expected an array");
  }
  if (value.length > maximumLength) {
    throw new ContractError(path, `array exceeds ${maximumLength} entries`);
  }
  return value.map((entry, index) => decode(entry, `${path}[${index}]`));
}

export function text(
  value: unknown,
  path: string,
  maximumBytes = MAX_STRING_BYTES,
  allowEmpty = false,
): string {
  if (typeof value !== "string") {
    throw new ContractError(path, "expected a string");
  }
  if ((!allowEmpty && value.length === 0) || exceedsUtf8ByteLength(value, maximumBytes)) {
    throw new ContractError(path, `string must contain at most ${maximumBytes} UTF-8 bytes`);
  }
  return value;
}

export function identifier(value: unknown, path: string): string {
  const decoded = text(value, path, 256);
  if (/\p{Cc}/u.test(decoded)) {
    throw new ContractError(path, "identifier contains control characters");
  }
  return decoded;
}

export function nullableText(
  value: unknown,
  path: string,
  maximumBytes = MAX_STRING_BYTES,
): string | null {
  return value === null ? null : text(value, path, maximumBytes);
}

export function nullableDecimalCursor(value: unknown, path: string, label: string): string | null {
  const nextCursor = nullableText(value, path, DECIMAL_CURSOR_MAXIMUM_CHARACTERS);
  if (nextCursor !== null && !/^\d+$/u.test(nextCursor)) {
    throw new ContractError(path, `expected a numeric ${label} cursor`);
  }
  return nextCursor;
}

export function nullableThreadHistoryCursor(value: unknown, path: string): string | null {
  const nextCursor = nullableText(value, path, THREAD_HISTORY_CURSOR_MAXIMUM_CHARACTERS);
  if (nextCursor !== null && !/^[A-Za-z0-9_-]+$/u.test(nextCursor)) {
    throw new ContractError(path, "expected a Base64URL thread history cursor");
  }
  return nextCursor;
}

export function decodeCommandLiveOutput(value: unknown, path: string): CommandLiveOutput {
  const object = exactRecord(value, path, ["stderr", "stdout", "truncated"]);
  const stderr = text(object.stderr, `${path}.stderr`, 256 * 1_024, true);
  const stdout = text(object.stdout, `${path}.stdout`, 256 * 1_024, true);
  if (utf8ByteLength(stderr) + utf8ByteLength(stdout) > 256 * 1_024) {
    throw new ContractError(path, "combined live command output exceeds 262144 bytes");
  }
  return {
    stderr,
    stdout,
    truncated: booleanValue(object.truncated, `${path}.truncated`),
  };
}

export function nullableThreadOutput(value: unknown, path: string): ThreadOutput | null {
  if (value === null) {
    return null;
  }
  const object = exactRecord(value, path, ["byteLength", "id", "nextCursor", "preview"]);
  const preview = text(object.preview, `${path}.preview`, MAX_OUTPUT_CHUNK_BYTES, true);
  const previewBytes = utf8ByteLength(preview);
  const byteLength = integer(
    object.byteLength,
    `${path}.byteLength`,
    previewBytes,
    Number.MAX_SAFE_INTEGER,
  );
  if (byteLength <= MAX_OUTPUT_CHUNK_BYTES && previewBytes !== byteLength) {
    throw new ContractError(path, "small output resources must include their complete preview");
  }
  const nextCursor = nullableDecimalCursor(object.nextCursor, `${path}.nextCursor`, "output");
  if ((previewBytes === byteLength) !== (nextCursor === null)) {
    throw new ContractError(path, "output preview and continuation cursor are inconsistent");
  }
  return {
    id: identifier(object.id, `${path}.id`),
    preview,
    byteLength,
    nextCursor,
  };
}

export function urlText(value: unknown, path: string, protocols: readonly string[]): string {
  const decoded = text(value, path, 8_192);
  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    throw new ContractError(path, "expected an absolute URL");
  }
  if (!protocols.includes(url.protocol)) {
    throw new ContractError(path, `URL protocol ${url.protocol} is not allowed`);
  }
  return decoded;
}

export function browserUrl(value: unknown, path: string): string {
  const decoded = text(value, path, 16_384);
  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    throw new ContractError(path, "expected an absolute browser URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:" && decoded !== "about:blank") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new ContractError(path, "browser URL is not allowed");
  }
  return decoded;
}

export function browserOrigin(value: unknown, path: string): string {
  const decoded = text(value, path, 2_048);
  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    throw new ContractError(path, "expected an absolute browser origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.origin !== decoded
  ) {
    throw new ContractError(path, "browser origin is not allowed");
  }
  return decoded;
}

export function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ContractError(path, "expected a boolean");
  }
  return value;
}

export function finiteNumber(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ContractError(path, `expected a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

export function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  const decoded = finiteNumber(value, path, minimum, maximum);
  if (!Number.isSafeInteger(decoded)) {
    throw new ContractError(path, "expected a safe integer");
  }
  return decoded;
}

export function nullableFiniteNumber(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number | null {
  return value === null ? null : finiteNumber(value, path, minimum, maximum);
}

export function nullableSafeInteger(value: unknown, path: string, maximum: number): number | null {
  return value === null ? null : integer(value, path, 0, maximum);
}

export function isoDate(value: unknown, path: string): string {
  const decoded = text(value, path, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(decoded)) {
    throw new ContractError(path, "expected an ISO calendar date");
  }
  const timestamp = Date.parse(`${decoded}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== decoded) {
    throw new ContractError(path, "expected a valid ISO calendar date");
  }
  return decoded;
}

export function literal<const T>(value: unknown, path: string, values: readonly T[]): T {
  for (const candidate of values) {
    if (value === candidate) {
      return candidate;
    }
  }
  throw new ContractError(path, `expected one of ${values.map(String).join(", ")}`);
}
