import type { Attachment, ReasoningEffort } from "../contracts/types";
import { utf8ByteLength } from "../utf8";
import { PROFILE_STORAGE_KEYS } from "./profileStorage";

const QUEUEING_STORAGE_KEY = PROFILE_STORAGE_KEYS.followUpBehavior;
const MESSAGE_QUEUE_STORAGE_PREFIX = PROFILE_STORAGE_KEYS.messageQueuePrefix;
const MAX_IDENTIFIER_CHARACTERS = 256;
const MAX_PATH_CHARACTERS = 4_096;
const MAX_NAME_CHARACTERS = 512;
const MAX_MEDIA_TYPE_CHARACTERS = 256;
const MAX_TEXT_BYTES = 1_048_576;
const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "high",
  "low",
  "max",
  "medium",
  "minimal",
  "none",
  "ultra",
  "xhigh",
]);

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

export interface LoadedMessageQueues {
  readonly queues: MessageQueueMap;
  readonly warnings: readonly string[];
}

interface StoredMessageQueue {
  readonly version: 1;
  readonly threadId: string;
  readonly messages: readonly QueuedMessage[];
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

export function loadMessageQueues(): LoadedMessageQueues {
  const queues = new Map<string, readonly QueuedMessage[]>();
  const warnings: string[] = [];
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(MESSAGE_QUEUE_STORAGE_PREFIX)) {
      keys.push(key);
    }
  }
  for (const key of keys) {
    const raw = localStorage.getItem(key);
    if (raw === null) {
      continue;
    }
    try {
      const stored = decodeStoredMessageQueue(JSON.parse(raw));
      if (key !== messageQueueStorageKey(stored.threadId)) {
        throw new Error("a chave não corresponde ao identificador da tarefa");
      }
      if (queues.has(stored.threadId)) {
        throw new Error("a tarefa aparece mais de uma vez");
      }
      queues.set(stored.threadId, stored.messages);
    } catch (reason) {
      warnings.push(`Uma fila persistida foi ignorada: ${describe(reason)}.`);
    }
  }
  return { queues, warnings };
}

export function saveMessageQueue(threadId: string, messages: readonly QueuedMessage[]): void {
  const validatedThreadId = validateIdentifier(threadId, "identificador da tarefa");
  const key = messageQueueStorageKey(validatedThreadId);
  if (messages.length === 0) {
    localStorage.removeItem(key);
    return;
  }
  const stored = decodeStoredMessageQueue({
    version: 1,
    threadId: validatedThreadId,
    messages,
  });
  localStorage.setItem(key, JSON.stringify(stored));
}

export function clearPersistedMessageQueues(): void {
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(MESSAGE_QUEUE_STORAGE_PREFIX)) {
      keys.push(key);
    }
  }
  for (const key of keys) {
    localStorage.removeItem(key);
  }
}

export function loadQueueingEnabled(): boolean {
  const value = localStorage.getItem(QUEUEING_STORAGE_KEY);
  if (value === null || value === "queue") {
    return true;
  }
  if (value === "steer") {
    return false;
  }
  throw new Error("O comportamento salvo para mensagens de acompanhamento é inválido.");
}

export function saveQueueingEnabled(enabled: boolean): void {
  localStorage.setItem(QUEUEING_STORAGE_KEY, enabled ? "queue" : "steer");
}

function decodeStoredMessageQueue(value: unknown): StoredMessageQueue {
  const object = exactObject(value, ["messages", "threadId", "version"], "fila persistida");
  if (object.version !== 1 || !Array.isArray(object.messages)) {
    throw new Error("a versão da fila persistida não é suportada");
  }
  const threadId = validateIdentifier(object.threadId, "identificador da tarefa");
  const seen = new Set<string>();
  const messages = object.messages.map((entry, index) => {
    const message = decodeQueuedMessage(entry, index);
    if (seen.has(message.id)) {
      throw new Error(`a mensagem ${index + 1} está duplicada`);
    }
    seen.add(message.id);
    return message;
  });
  if (messages.length === 0) {
    throw new Error("a fila persistida está vazia");
  }
  return { version: 1, threadId, messages };
}

function decodeQueuedMessage(value: unknown, index: number): QueuedMessage {
  const label = `mensagem ${index + 1}`;
  const object = exactObject(
    value,
    ["attachments", "effort", "id", "model", "serviceTier", "text"],
    label,
  );
  if (typeof object.text !== "string" || utf8ByteLength(object.text) > MAX_TEXT_BYTES) {
    throw new Error(`${label} possui texto inválido`);
  }
  if (!Array.isArray(object.attachments)) {
    throw new Error(`${label} possui anexos inválidos`);
  }
  const effort = object.effort;
  if (
    effort !== null &&
    (typeof effort !== "string" || !REASONING_EFFORTS.has(effort as ReasoningEffort))
  ) {
    throw new Error(`${label} possui esforço de raciocínio inválido`);
  }
  return {
    id: validateIdentifier(object.id, `identificador da ${label}`),
    text: object.text,
    attachments: object.attachments.map((attachment, attachmentIndex) =>
      decodeAttachment(attachment, `${label}, anexo ${attachmentIndex + 1}`),
    ),
    model: validateNullableText(object.model, `${label}, modelo`, MAX_IDENTIFIER_CHARACTERS),
    effort: effort as ReasoningEffort | null,
    serviceTier: validateNullableText(
      object.serviceTier,
      `${label}, nível de serviço`,
      MAX_IDENTIFIER_CHARACTERS,
    ),
  };
}

function decodeAttachment(value: unknown, label: string): Attachment {
  const object = exactObject(value, ["id", "kind", "mediaType", "name", "path", "size"], label);
  if (object.kind !== "file" && object.kind !== "image") {
    throw new Error(`${label} possui tipo inválido`);
  }
  if (typeof object.size !== "number" || !Number.isSafeInteger(object.size) || object.size < 0) {
    throw new Error(`${label} possui tamanho inválido`);
  }
  return {
    id: validateIdentifier(object.id, `${label}, identificador`),
    name: validateText(object.name, `${label}, nome`, MAX_NAME_CHARACTERS),
    path: validateText(object.path, `${label}, caminho`, MAX_PATH_CHARACTERS),
    kind: object.kind,
    size: object.size,
    mediaType: validateNullableText(
      object.mediaType,
      `${label}, tipo de mídia`,
      MAX_MEDIA_TYPE_CHARACTERS,
    ),
  };
}

function exactObject<const Keys extends readonly string[]>(
  value: unknown,
  expectedKeys: Keys,
  label: string,
): { [Key in Keys[number]]: unknown } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} não é um objeto`);
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`${label} possui campos incompatíveis`);
  }
  return object as { [Key in Keys[number]]: unknown };
}

function validateIdentifier(value: unknown, label: string): string {
  return validateText(value, label, MAX_IDENTIFIER_CHARACTERS);
}

function validateText(value: unknown, label: string, maximumCharacters: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumCharacters ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`${label} é inválido`);
  }
  return value;
}

function validateNullableText(
  value: unknown,
  label: string,
  maximumCharacters: number,
): string | null {
  return value === null ? null : validateText(value, label, maximumCharacters);
}

function messageQueueStorageKey(threadId: string): string {
  return `${MESSAGE_QUEUE_STORAGE_PREFIX}${encodeURIComponent(threadId)}`;
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : "erro desconhecido";
}
