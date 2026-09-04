import {
  NOTIFICATION_QUEUE_CAPACITY,
  TRANSIENT_NOTIFICATION_MAXIMUM_DURATION_SECONDS,
  TRANSIENT_NOTIFICATION_MINIMUM_DURATION_SECONDS,
} from "./notificationPolicy";

export const CONFIGURABLE_NOTIFICATION_EVENT_KINDS = [
  "approvalRequired",
  "lunaReserveAvailable",
  "taskCompleted",
  "taskFailed",
  "usageLimitReset",
  "usageResetAvailable",
] as const;

export type ConfigurableNotificationEventKind =
  (typeof CONFIGURABLE_NOTIFICATION_EVENT_KINDS)[number];

export const NOTIFICATION_EVENT_KINDS = [
  ...CONFIGURABLE_NOTIFICATION_EVENT_KINDS,
  "settingsSaved",
] as const;

export type NotificationEventKind = (typeof NOTIFICATION_EVENT_KINDS)[number];
export type NotificationTone = "attention" | "error" | "success";

export type NotificationTarget =
  | { readonly type: "settings"; readonly page: "usage" }
  | { readonly type: "thread"; readonly threadId: string };

export type NotificationPresentation =
  | { readonly type: "priority" }
  | {
      readonly type: "transient";
      readonly durationSeconds: number;
      readonly position: "bottomLeft" | "bottomRight" | "topLeft" | "topRight";
    };

export interface AppNotification {
  readonly id: string;
  readonly event: NotificationEventKind;
  readonly tone: NotificationTone;
  readonly title: string;
  readonly message: string;
  readonly createdAt: number;
  readonly presentation: NotificationPresentation;
  readonly target: NotificationTarget | null;
}

export interface NotificationOverlayPayload {
  readonly notification: AppNotification | null;
  readonly pendingCount: number;
}

export type NotificationOverlayAction =
  | { readonly type: "activate"; readonly notificationId: string }
  | { readonly type: "dismiss"; readonly notificationId: string }
  | { readonly type: "failure"; readonly message: string };

const MAX_IDENTIFIER_BYTES = 256;
const MAX_NOTIFICATION_TEXT_BYTES = 4_096;

export function decodeNotificationOverlayPayload(value: unknown): NotificationOverlayPayload {
  const object = exactRecord(value, "$", ["notification", "pendingCount"]);
  const notification =
    object.notification === null
      ? null
      : decodeAppNotification(object.notification, "$.notification");
  const pendingCount = integer(
    object.pendingCount,
    "$.pendingCount",
    0,
    NOTIFICATION_QUEUE_CAPACITY,
  );
  if ((notification === null) !== (pendingCount === 0)) {
    throw new Error("$.pendingCount must match whether a notification is active.");
  }
  return { notification, pendingCount };
}

export function decodeNotificationOverlayAction(value: unknown): NotificationOverlayAction {
  const object = record(value, "$");
  const type = literal(field(object, "type"), "$.type", [
    "activate",
    "dismiss",
    "failure",
  ] as const);
  if (type === "failure") {
    const failure = exactRecord(value, "$", ["message", "type"]);
    return {
      type,
      message: boundedText(failure.message, "$.message", MAX_NOTIFICATION_TEXT_BYTES),
    };
  }
  const action = exactRecord(value, "$", ["notificationId", "type"]);
  return {
    type,
    notificationId: boundedText(action.notificationId, "$.notificationId", MAX_IDENTIFIER_BYTES),
  };
}

function decodeAppNotification(value: unknown, path: string): AppNotification {
  const object = exactRecord(value, path, [
    "createdAt",
    "event",
    "id",
    "message",
    "presentation",
    "target",
    "title",
    "tone",
  ]);
  return {
    id: boundedText(object.id, `${path}.id`, MAX_IDENTIFIER_BYTES),
    event: literal(object.event, `${path}.event`, NOTIFICATION_EVENT_KINDS),
    tone: literal(object.tone, `${path}.tone`, ["attention", "error", "success"] as const),
    title: boundedText(object.title, `${path}.title`, MAX_NOTIFICATION_TEXT_BYTES),
    message: boundedText(object.message, `${path}.message`, MAX_NOTIFICATION_TEXT_BYTES),
    createdAt: integer(object.createdAt, `${path}.createdAt`, 0, Number.MAX_SAFE_INTEGER),
    presentation: decodePresentation(object.presentation, `${path}.presentation`),
    target: object.target === null ? null : decodeTarget(object.target, `${path}.target`),
  };
}

function decodePresentation(value: unknown, path: string): NotificationPresentation {
  const object = record(value, path);
  const type = literal(field(object, "type"), `${path}.type`, ["priority", "transient"] as const);
  if (type === "priority") {
    exactKeys(object, path, ["type"]);
    return { type };
  }
  const transient = exactRecord(value, path, ["durationSeconds", "position", "type"]);
  return {
    type,
    durationSeconds: integer(
      transient.durationSeconds,
      `${path}.durationSeconds`,
      TRANSIENT_NOTIFICATION_MINIMUM_DURATION_SECONDS,
      TRANSIENT_NOTIFICATION_MAXIMUM_DURATION_SECONDS,
    ),
    position: literal(transient.position, `${path}.position`, [
      "bottomLeft",
      "bottomRight",
      "topLeft",
      "topRight",
    ] as const),
  };
}

function decodeTarget(value: unknown, path: string): NotificationTarget {
  const object = record(value, path);
  const type = literal(field(object, "type"), `${path}.type`, ["settings", "thread"] as const);
  if (type === "settings") {
    const settings = exactRecord(value, path, ["page", "type"]);
    return { type, page: literal(settings.page, `${path}.page`, ["usage"] as const) };
  }
  const thread = exactRecord(value, path, ["threadId", "type"]);
  return {
    type,
    threadId: boundedText(thread.threadId, `${path}.threadId`, MAX_IDENTIFIER_BYTES),
  };
}

function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  path: string,
  keys: Keys,
): Record<string, unknown> & { readonly [Key in Keys[number]]: unknown } {
  const object = record(value, path);
  exactKeys(object, path, keys);
  return object as Record<string, unknown> & { readonly [Key in Keys[number]]: unknown };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(object: Record<string, unknown>, path: string, keys: readonly string[]): void {
  const expected = [...keys].toSorted();
  const received = Object.keys(object).toSorted();
  if (
    expected.length !== received.length ||
    expected.some((key, index) => key !== received[index])
  ) {
    throw new Error(`${path} contains unexpected or missing fields.`);
  }
}

function field(object: Record<string, unknown>, key: string): unknown {
  return object[key];
}

function boundedText(value: unknown, path: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  if (new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new Error(`${path} exceeds ${maximumBytes} bytes.`);
  }
  return value;
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${path} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function literal<const T extends readonly string[]>(
  value: unknown,
  path: string,
  allowed: T,
): T[number] {
  if (typeof value !== "string" || !allowed.some((candidate) => candidate === value)) {
    throw new Error(`${path} has an unsupported value.`);
  }
  return value as T[number];
}
