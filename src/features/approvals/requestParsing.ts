import {
  type JsonObject,
  type JsonValue,
} from "../../shared/codex/types";
import type { ServerRequestId } from "./serverRequestTypes";

export type DecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface ItemRequestFields {
  itemId: string;
  startedAtMs: number;
  threadId: string;
  turnId: string;
}

export function decoded<T>(value: T): DecodeResult<T> {
  return { ok: true, value };
}

export function rejected<T>(error: string): DecodeResult<T> {
  return { ok: false, error };
}

export function decodeItemFields(
  params: JsonObject,
): DecodeResult<ItemRequestFields> {
  if (
    typeof params.threadId !== "string" ||
    typeof params.turnId !== "string" ||
    typeof params.itemId !== "string" ||
    !isFiniteInteger(params.startedAtMs)
  ) {
    return rejected(
      "a solicitação não contém thread, turno, item e horário válidos",
    );
  }
  return decoded({
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    startedAtMs: params.startedAtMs,
  });
}

export function decodeRequestId(value: unknown): ServerRequestId | null {
  if (typeof value === "string") {
    return value;
  }
  return isFiniteInteger(value) ? value : null;
}

export function nullableString(value: JsonValue | undefined): boolean {
  return value === undefined || value === null || typeof value === "string";
}

export function requiredNullableString(value: JsonValue | undefined): boolean {
  return value === null || typeof value === "string";
}

export function optionalString(
  object: JsonObject,
  key: string,
): string | null {
  const value = object[key];
  return typeof value === "string" ? value : null;
}

export function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
