import {
  isJsonObject,
  type DeprecationNoticeNotification,
  type GuardianWarningNotification,
  type JsonValue,
  type ModelVerification,
  type ModelVerificationNotification,
  type WarningNotification,
} from "../../shared/codex/types";

const MAX_THREAD_ID_CHARACTERS = 256;
const MAX_MODEL_VERIFICATIONS = 16;

export function parseDeprecationNotice(
  value: JsonValue | undefined,
): DeprecationNoticeNotification {
  if (!isJsonObject(value)) {
    throw incompatibleNotification("deprecationNotice");
  }
  const summary = value.summary;
  const details = value.details;
  if (
    typeof summary !== "string"
    || (details !== null && typeof details !== "string")
  ) {
    throw incompatibleNotification("deprecationNotice");
  }
  return { summary, details };
}

export function parseWarningNotification(
  value: JsonValue | undefined,
): WarningNotification {
  if (!isJsonObject(value)) {
    throw incompatibleNotification("warning");
  }
  const message = value.message;
  if (typeof message !== "string") {
    throw incompatibleNotification("warning");
  }
  return {
    threadId:
      value.threadId === null
        ? null
        : parseThreadId(value.threadId, "warning"),
    message,
  };
}

export function parseGuardianWarningNotification(
  value: JsonValue | undefined,
): GuardianWarningNotification {
  if (!isJsonObject(value)) {
    throw incompatibleNotification("guardianWarning");
  }
  const message = value.message;
  if (typeof message !== "string") {
    throw incompatibleNotification("guardianWarning");
  }
  return {
    threadId: parseThreadId(value.threadId, "guardianWarning"),
    message,
  };
}

export function parseModelVerificationNotification(
  value: JsonValue | undefined,
): ModelVerificationNotification {
  if (!isJsonObject(value) || !Array.isArray(value.verifications)) {
    throw incompatibleNotification("model/verification");
  }
  if (value.verifications.length > MAX_MODEL_VERIFICATIONS) {
    throw incompatibleNotification("model/verification");
  }
  return {
    threadId: parseThreadId(value.threadId, "model/verification"),
    turnId: parseThreadId(value.turnId, "model/verification"),
    verifications: value.verifications.map(parseModelVerification),
  };
}

function parseModelVerification(value: JsonValue): ModelVerification {
  if (value !== "trustedAccessForCyber") {
    throw incompatibleNotification("model/verification");
  }
  return value;
}

function parseThreadId(value: JsonValue | undefined, method: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_THREAD_ID_CHARACTERS
  ) {
    throw incompatibleNotification(method);
  }
  return value;
}

function incompatibleNotification(method: string): Error {
  return new Error(`Notificação incompatível do Codex em ${method}.`);
}
