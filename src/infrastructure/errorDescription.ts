import { decodeCommandError } from "../contracts/decode";

const MAX_DIAGNOSTIC_DETAIL_CHARACTERS = 4_000;
const MAX_DIAGNOSTIC_CAUSE_DEPTH = 4;

export function describeError(reason: unknown): string {
  return describeErrorAt(reason, new Set<Error>(), 0);
}

function describeErrorAt(reason: unknown, ancestors: Set<Error>, depth: number): string {
  const commandError = decodeCommandError(reason);
  if (commandError !== null) {
    return commandError.message;
  }
  if (reason instanceof Error) {
    const message = reason.message.trim();
    if (
      (message.length === 0 || message === "Unknown error") &&
      reason.cause !== undefined &&
      depth < MAX_DIAGNOSTIC_CAUSE_DEPTH &&
      !ancestors.has(reason)
    ) {
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(reason);
      return describeErrorAt(reason.cause, nextAncestors, depth + 1);
    }
    return message || "An unexpected error occurred.";
  }
  if (typeof reason === "string" && reason.length > 0) {
    return reason;
  }
  return "An unexpected error occurred.";
}

export function describeDiagnosticError(reason: unknown): string {
  const detail = formatDiagnosticReason(reason, new Set<Error>(), 0);
  let codePoints = 0;
  let end = detail.length;
  let index = 0;
  for (const character of detail) {
    codePoints += 1;
    if (codePoints > MAX_DIAGNOSTIC_DETAIL_CHARACTERS) {
      end = index;
      break;
    }
    index += character.length;
  }
  return detail.slice(0, end);
}

function formatDiagnosticReason(reason: unknown, ancestors: Set<Error>, depth: number): string {
  if (!(reason instanceof Error)) {
    return describeError(reason);
  }
  if (ancestors.has(reason)) {
    return "[causa circular omitida]";
  }

  const detail =
    reason.stack?.trim() ||
    `${reason.name || "Error"}: ${reason.message || "Error without a message"}`;
  if (reason.cause === undefined || depth >= MAX_DIAGNOSTIC_CAUSE_DEPTH) {
    return detail;
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(reason);
  return `${detail}\nCausado por:\n${formatDiagnosticReason(reason.cause, nextAncestors, depth + 1)}`;
}
