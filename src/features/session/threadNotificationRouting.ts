import {
  readString,
  type JsonObject,
} from "../../shared/codex/types";

export function readRequiredNotificationThreadId(
  method: string,
  params: JsonObject | undefined,
): string {
  const threadId = readString(params, "threadId");
  if (threadId === undefined) {
    throw new Error(
      `Notificação incompatível do Codex em ${method}: threadId ausente.`,
    );
  }
  return threadId;
}

export function isActiveThreadTarget(
  targetThreadId: string,
  activeThreadId: string | null,
): boolean {
  return targetThreadId === activeThreadId;
}

export function isRequestVisibleForThread(
  requestThreadId: string | null,
  activeThreadId: string | null,
): boolean {
  return requestThreadId === null || requestThreadId === activeThreadId;
}
