import type { JsonObject, JsonValue } from "../../shared/codex/types";
import type {
  ActivityStatus,
  CommandSource,
  MessagePhase,
} from "./timelineTypes";

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function parsed<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

export function invalid<T>(itemId: string, reason: string): ParseResult<T> {
  return { ok: false, error: `O item ${itemId} ${reason}.` };
}

export function lifecycleStatus(completed: boolean): ActivityStatus {
  return completed ? "completed" : "inProgress";
}

export function isActivityStatus(
  value: JsonValue | undefined,
  allowDeclined: boolean,
): value is ActivityStatus {
  return (
    value === "completed" ||
    value === "failed" ||
    value === "inProgress" ||
    (allowDeclined && value === "declined")
  );
}

export function isCommandSource(
  value: JsonValue | undefined,
): value is CommandSource {
  return (
    value === "agent" ||
    value === "unifiedExecInteraction" ||
    value === "unifiedExecStartup" ||
    value === "userShell"
  );
}

export function readMessagePhase(value: JsonValue | undefined): MessagePhase {
  return value === "commentary" || value === "final_answer" ? value : null;
}

export function readStringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function readNumber(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readBoolean(value: JsonValue | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function readOptionalString(
  object: JsonObject,
  key: string,
): string | null {
  const value = object[key];
  return typeof value === "string" ? value : null;
}

export function humanizeIdentifier(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[_-]+/g, " ")
    .trim();
  if (words.length === 0) {
    return "Ferramenta";
  }
  return `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}
