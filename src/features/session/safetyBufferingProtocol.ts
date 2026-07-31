import {
  isJsonObject,
  type JsonValue,
  type ModelSafetyBufferingUpdatedNotification,
} from "../../shared/codex/types";

const MAX_ID_CHARACTERS = 256;
const MAX_MODEL_CHARACTERS = 256;
const MAX_CONTEXT_ENTRIES = 32;
const MAX_CONTEXT_ENTRY_CHARACTERS = 2_048;

export function parseModelSafetyBufferingUpdatedNotification(
  value: JsonValue | undefined,
): ModelSafetyBufferingUpdatedNotification {
  if (!isJsonObject(value)) {
    throw incompatibleNotification();
  }

  const showBufferingUi = value.showBufferingUi;
  if (typeof showBufferingUi !== "boolean") {
    throw incompatibleNotification();
  }

  return {
    threadId: parseIdentifier(value.threadId),
    turnId: parseIdentifier(value.turnId),
    model: parseModel(value.model),
    useCases: parseContextList(value.useCases),
    reasons: parseContextList(value.reasons),
    showBufferingUi,
    fasterModel:
      value.fasterModel === null ? null : parseModel(value.fasterModel),
  };
}

function parseIdentifier(value: JsonValue | undefined): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_ID_CHARACTERS
  ) {
    throw incompatibleNotification();
  }
  return value;
}

function parseModel(value: JsonValue | undefined): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_MODEL_CHARACTERS
  ) {
    throw incompatibleNotification();
  }
  return value;
}

function parseContextList(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value) || value.length > MAX_CONTEXT_ENTRIES) {
    throw incompatibleNotification();
  }
  return value.map((entry) => {
    if (
      typeof entry !== "string"
      || entry.length > MAX_CONTEXT_ENTRY_CHARACTERS
    ) {
      throw incompatibleNotification();
    }
    return entry;
  });
}

function incompatibleNotification(): Error {
  return new Error(
    "Notificação incompatível do Codex em model/safetyBuffering/updated.",
  );
}
