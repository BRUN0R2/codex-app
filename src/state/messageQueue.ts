import type { Attachment, ReasoningEffort } from "../contracts/types";
import { PROFILE_STORAGE_KEYS } from "./profileStorage";

const QUEUEING_STORAGE_KEY = PROFILE_STORAGE_KEYS.followUpBehavior;
export const MAX_QUEUED_MESSAGES = 32;

export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly model: string | null;
  readonly effort: ReasoningEffort | null;
  readonly serviceTier: string | null;
}

export type MessageQueueMap = ReadonlyMap<string, readonly QueuedMessage[]>;

export interface TakenQueuedMessage {
  readonly queues: MessageQueueMap;
  readonly message: QueuedMessage | null;
}

export function readQueuedMessages(
  queues: MessageQueueMap,
  threadId: string,
): readonly QueuedMessage[] {
  return queues.get(threadId) ?? [];
}

export function appendQueuedMessage(
  queues: MessageQueueMap,
  threadId: string,
  message: QueuedMessage,
): MessageQueueMap {
  const current = readQueuedMessages(queues, threadId);
  if (current.length >= MAX_QUEUED_MESSAGES) {
    throw new Error(`A fila aceita no máximo ${MAX_QUEUED_MESSAGES} mensagens por tarefa.`);
  }
  if (current.some((entry) => entry.id === message.id)) {
    throw new Error("A mensagem já está na fila desta tarefa.");
  }
  const next = new Map(queues);
  next.set(threadId, [...current, message]);
  return next;
}

export function takeQueuedMessage(
  queues: MessageQueueMap,
  threadId: string,
  messageId: string,
): TakenQueuedMessage {
  const current = readQueuedMessages(queues, threadId);
  const message = current.find((entry) => entry.id === messageId) ?? null;
  if (message === null) {
    return { queues, message: null };
  }
  const remaining = current.filter((entry) => entry.id !== messageId);
  const next = new Map(queues);
  if (remaining.length === 0) {
    next.delete(threadId);
  } else {
    next.set(threadId, remaining);
  }
  return { queues: next, message };
}

export function deleteMessageQueue(queues: MessageQueueMap, threadId: string): MessageQueueMap {
  if (!queues.has(threadId)) {
    return queues;
  }
  const next = new Map(queues);
  next.delete(threadId);
  return next;
}

export function loadQueueingEnabled(): boolean {
  return localStorage.getItem(QUEUEING_STORAGE_KEY) !== "steer";
}

export function saveQueueingEnabled(enabled: boolean): void {
  localStorage.setItem(QUEUEING_STORAGE_KEY, enabled ? "queue" : "steer");
}
