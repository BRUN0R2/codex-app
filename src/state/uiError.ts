import type { TranslationMessages } from "../i18n/messages";
import { formatMessage } from "../i18n/messages";

const MAX_UI_ERROR_DETAIL_CHARACTERS = 512;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/gu;

export type UiErrorKey =
  | "unexpected"
  | "accountProfileLoad"
  | "rateLimitsLoad"
  | "usageResetsLoad"
  | "usageResetExpired"
  | "usageResetUnavailable"
  | "usageResetIneligible"
  | "usageResetFailed"
  | "autoTopUpFailed"
  | "applicationPreferencesLoad"
  | "applicationPreferencesSave"
  | "loginFailed"
  | "remoteRevocationFailed"
  | "chatProjectsUnsupported"
  | "chatProjectsAssociation"
  | "projectUnavailable"
  | "taskUnavailable"
  | "taskNameEmpty"
  | "activeTurnWithoutTask"
  | "queueTaskRequired"
  | "automationUnavailable"
  | "automationActiveRun"
  | "turnFailed"
  | "configurationNotLoaded"
  | "attachmentSelectionFailed"
  | "imageUnavailable"
  | "attachmentLimitReached"
  | "composerPreferenceLoad"
  | "composerPreferenceSave";

export interface UiError {
  readonly key: UiErrorKey;
  readonly detail?: string;
}

export function uiError(key: UiErrorKey, detail?: string): UiError {
  const normalizedDetail = normalizeUiErrorDetail(detail);
  return normalizedDetail === undefined ? { key } : { key, detail: normalizedDetail };
}

export function formatUiError(error: UiError, messages: TranslationMessages["errors"]): string {
  const message = localizedUiErrorMessage(error.key, messages);
  if (error.detail === undefined) {
    return message;
  }
  return `${message} ${formatMessage(messages.detail, { detail: error.detail })}`;
}

function localizedUiErrorMessage(key: UiErrorKey, messages: TranslationMessages["errors"]): string {
  switch (key) {
    case "unexpected":
      return messages.unexpected;
    case "accountProfileLoad":
      return messages.accountProfileLoad;
    case "rateLimitsLoad":
      return messages.rateLimitsLoad;
    case "usageResetsLoad":
      return messages.usageResetsLoad;
    case "usageResetExpired":
      return messages.usageResetExpired;
    case "usageResetUnavailable":
      return messages.usageResetUnavailable;
    case "usageResetIneligible":
      return messages.usageResetIneligible;
    case "usageResetFailed":
      return messages.usageResetFailed;
    case "autoTopUpFailed":
      return messages.autoTopUpFailed;
    case "applicationPreferencesLoad":
      return messages.applicationPreferencesLoad;
    case "applicationPreferencesSave":
      return messages.applicationPreferencesSave;
    case "loginFailed":
      return messages.loginFailed;
    case "remoteRevocationFailed":
      return messages.remoteRevocationFailed;
    case "chatProjectsUnsupported":
      return messages.chatProjectsUnsupported;
    case "chatProjectsAssociation":
      return messages.chatProjectsAssociation;
    case "projectUnavailable":
      return messages.projectUnavailable;
    case "taskUnavailable":
      return messages.taskUnavailable;
    case "taskNameEmpty":
      return messages.taskNameEmpty;
    case "activeTurnWithoutTask":
      return messages.activeTurnWithoutTask;
    case "queueTaskRequired":
      return messages.queueTaskRequired;
    case "automationUnavailable":
      return messages.automationUnavailable;
    case "automationActiveRun":
      return messages.automationActiveRun;
    case "turnFailed":
      return messages.turnFailed;
    case "configurationNotLoaded":
      return messages.configurationNotLoaded;
    case "attachmentSelectionFailed":
      return messages.attachmentSelectionFailed;
    case "imageUnavailable":
      return messages.imageUnavailable;
    case "attachmentLimitReached":
      return messages.attachmentLimitReached;
    case "composerPreferenceLoad":
      return messages.composerPreferenceLoad;
    case "composerPreferenceSave":
      return messages.composerPreferenceSave;
    default:
      return assertNever(key);
  }
}

function normalizeUiErrorDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) {
    return undefined;
  }
  const normalized = detail.replace(CONTROL_CHARACTER_PATTERN, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }
  const characters = Array.from(normalized);
  return characters.length > MAX_UI_ERROR_DETAIL_CHARACTERS
    ? `${characters.slice(0, MAX_UI_ERROR_DETAIL_CHARACTERS).join("")}…`
    : normalized;
}

function assertNever(value: never): never {
  throw new Error(`Unknown UI error key: ${String(value)}`);
}
