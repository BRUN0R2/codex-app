import { decodeCommandError } from "../contracts/decode";

const MAX_DIAGNOSTIC_DETAIL_CHARACTERS = 4_000;
const MAX_DIAGNOSTIC_CAUSE_DEPTH = 4;

export function describeError(reason: unknown): string {
  const commandError = decodeCommandError(reason);
  if (commandError !== null) {
    return commandError.message;
  }
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === "string" && reason.length > 0) {
    return reason;
  }
  return "Ocorreu um erro inesperado.";
}

export function describeDiagnosticError(reason: unknown): string {
  return formatDiagnosticReason(reason, new Set<Error>(), 0).slice(
    0,
    MAX_DIAGNOSTIC_DETAIL_CHARACTERS,
  );
}

function formatDiagnosticReason(reason: unknown, ancestors: Set<Error>, depth: number): string {
  if (!(reason instanceof Error)) {
    return describeError(reason);
  }
  if (ancestors.has(reason)) {
    return "[causa circular omitida]";
  }

  const detail =
    reason.stack?.trim() || `${reason.name || "Error"}: ${reason.message || "Erro sem mensagem"}`;
  if (reason.cause === undefined || depth >= MAX_DIAGNOSTIC_CAUSE_DEPTH) {
    return detail;
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(reason);
  return `${detail}\nCausado por:\n${formatDiagnosticReason(reason.cause, nextAncestors, depth + 1)}`;
}
