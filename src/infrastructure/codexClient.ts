import type { UnlistenFn } from "@tauri-apps/api/event";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
  decodeAccountProfileResponse,
  decodeAccountRateLimitsResponse,
  decodeAccountReadResponse,
  decodeApplicationPreferences,
  decodeAttachment,
  decodeAttachmentImageResponse,
  decodeAttachments,
  decodeAutomation,
  decodeAutomationListResponse,
  decodeAutomationRun,
  decodeAutoTopUpSettingsSnapshot,
  decodeCancelLoginResponse,
  decodeChatModelListResponse,
  decodeConfigUpdate,
  decodeConfigUpdateResponse,
  decodeEngineNotification,
  decodeEngineServerRequest,
  decodeEngineStartResponse,
  decodeLoginResponse,
  decodeLogoutResponse,
  decodeModelListResponse,
  decodeOperationAck,
  decodeOutputReadResponse,
  decodeRuntimeDiagnostic,
  decodeRuntimeStatus,
  decodeThreadForkResponse,
  decodeThreadListResponse,
  decodeThreadReadResponse,
  decodeThreadResumeResponse,
  decodeThreadStartResponse,
  decodeThreadUnarchiveResponse,
  decodeTurnStartResponse,
  decodeUsageResetCreditsResponse,
  decodeUsageResetRedemptionResponse,
} from "../contracts/decode";
import type {
  AccountProfileResponse,
  AccountRateLimitsResponse,
  AccountReadResponse,
  ApplicationPreferences,
  ApprovalDecision,
  Attachment,
  AttachmentImageResponse,
  Automation,
  AutomationInput,
  AutomationListResponse,
  AutomationRun,
  AutoTopUpSettingsSnapshot,
  CancelLoginResponse,
  ChatModelListResponse,
  ConfigUpdate,
  ConfigUpdateResponse,
  ConversationMode,
  EngineNotification,
  EngineServerRequest,
  EngineStartResponse,
  LoginResponse,
  LogoutResponse,
  ModelListResponse,
  OperationAck,
  OutputReadResponse,
  ReasoningEffort,
  RuntimeDiagnostic,
  RuntimeStatus,
  ThreadForkResponse,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  ThreadUnarchiveResponse,
  TurnStartResponse,
  UsageResetCreditsResponse,
  UsageResetRedemptionResponse,
} from "../contracts/types";
import {
  hasBrowserPreviewRuntime,
  invokeRuntime as invoke,
  listenRuntime as listen,
} from "./runtimeBridge";

export { describeDiagnosticError, describeError } from "./errorDescription";

const NOTIFICATION_EVENT = "engine://notification";
const SERVER_REQUEST_EVENT = "engine://server-request";
const RUNTIME_DIAGNOSTIC_EVENT = "engine://runtime-diagnostic";
const RUNTIME_STATUS_EVENT = "engine://runtime-status";

type Decoder<T> = (value: unknown) => T;

export interface EventHandlers {
  readonly onContractError: (error: Error) => void;
  readonly onDiagnostic: (diagnostic: RuntimeDiagnostic) => void;
  readonly onNotification: (notification: EngineNotification) => void;
  readonly onServerRequest: (request: EngineServerRequest) => void;
  readonly onStatus: (status: RuntimeStatus) => void;
}

export async function subscribeToEvents(handlers: EventHandlers): Promise<() => void> {
  const unlisteners: UnlistenFn[] = [];
  try {
    unlisteners.push(
      await listenEngineNotifications(handlers.onNotification, handlers.onContractError),
    );
    unlisteners.push(
      await listen<unknown>(SERVER_REQUEST_EVENT, (event) => {
        decodeEvent(event.payload, decodeEngineServerRequest, handlers.onServerRequest, handlers);
      }),
    );
    unlisteners.push(
      await listen<unknown>(RUNTIME_DIAGNOSTIC_EVENT, (event) => {
        decodeEvent(event.payload, decodeRuntimeDiagnostic, handlers.onDiagnostic, handlers);
      }),
    );
    unlisteners.push(
      await listen<unknown>(RUNTIME_STATUS_EVENT, (event) => {
        decodeEvent(event.payload, decodeRuntimeStatus, handlers.onStatus, handlers);
      }),
    );
  } catch (reason) {
    for (const unlisten of unlisteners) {
      unlisten();
    }
    throw asError(reason, "Engine events could not be registered.");
  }
  return () => {
    for (const unlisten of unlisteners) {
      unlisten();
    }
  };
}

export async function listenEngineNotifications(
  onNotification: (notification: EngineNotification) => void,
  onError: (error: Error) => void,
): Promise<UnlistenFn> {
  try {
    return await listen<unknown>(NOTIFICATION_EVENT, (event) => {
      try {
        onNotification(decodeEngineNotification(event.payload));
      } catch (reason) {
        onError(asError(reason, "An invalid event was received from the engine."));
      }
    });
  } catch (reason) {
    throw asError(reason, "Engine notifications could not be registered.");
  }
}

export function startEngine(): Promise<EngineStartResponse> {
  return invokeDecoded("engine_start", decodeEngineStartResponse);
}

export function reportFrontendDiagnostic(message: string): Promise<OperationAck> {
  return invokeDecoded("engine_runtime_diagnostic_report", decodeOperationAck, {
    request: { message },
  });
}

export function readAccount(): Promise<AccountReadResponse> {
  return invokeDecoded("engine_account_read", decodeAccountReadResponse);
}

export function readAccountProfile(): Promise<AccountProfileResponse> {
  return invokeDecoded("engine_account_profile_read", decodeAccountProfileResponse);
}

export function readRateLimits(): Promise<AccountRateLimitsResponse> {
  return invokeDecoded("engine_account_rate_limits_read", decodeAccountRateLimitsResponse);
}

export function readUsageResets(): Promise<UsageResetCreditsResponse> {
  return invokeDecoded("engine_account_usage_resets_read", decodeUsageResetCreditsResponse);
}

export function redeemUsageReset(
  creditId: string | null,
  redeemRequestId: string,
): Promise<UsageResetRedemptionResponse> {
  return invokeDecoded("engine_account_usage_reset_redeem", decodeUsageResetRedemptionResponse, {
    request: { creditId, redeemRequestId },
  });
}

export function readAutoTopUpSettings(): Promise<AutoTopUpSettingsSnapshot> {
  return invokeDecoded("engine_account_auto_top_up_read", decodeAutoTopUpSettingsSnapshot);
}

export function enableAutoTopUp(
  rechargeThreshold: string,
  rechargeTarget: string,
  rechargeMonthlyLimit: string | null,
): Promise<AutoTopUpSettingsSnapshot> {
  return invokeDecoded("engine_account_auto_top_up_enable", decodeAutoTopUpSettingsSnapshot, {
    request: { rechargeMonthlyLimit, rechargeTarget, rechargeThreshold },
  });
}

export function updateAutoTopUp(
  rechargeThreshold: string,
  rechargeTarget: string,
  rechargeMonthlyLimit: string | null,
): Promise<AutoTopUpSettingsSnapshot> {
  return invokeDecoded("engine_account_auto_top_up_update", decodeAutoTopUpSettingsSnapshot, {
    request: { rechargeMonthlyLimit, rechargeTarget, rechargeThreshold },
  });
}

export function disableAutoTopUp(): Promise<AutoTopUpSettingsSnapshot> {
  return invokeDecoded("engine_account_auto_top_up_disable", decodeAutoTopUpSettingsSnapshot);
}

export function loginWithChatGpt(): Promise<LoginResponse> {
  return invokeDecoded("engine_login_chatgpt", decodeLoginResponse);
}

export function cancelLogin(loginId: string): Promise<CancelLoginResponse> {
  return invokeDecoded("engine_login_cancel", decodeCancelLoginResponse, {
    request: { loginId },
  });
}

export function logout(): Promise<LogoutResponse> {
  return invokeDecoded("engine_logout", decodeLogoutResponse);
}

export function startThread(
  projectPath: string | null,
  mode: ConversationMode,
): Promise<ThreadStartResponse> {
  return invokeDecoded("engine_thread_start", decodeThreadStartResponse, {
    request: { mode, projectPath },
  });
}

export function listThreads(cursor: string | null, archived = false): Promise<ThreadListResponse> {
  return invokeDecoded("engine_thread_list", decodeThreadListResponse, {
    request: { cursor, archived },
  });
}

export function resumeThread(threadId: string): Promise<ThreadResumeResponse> {
  return invokeDecoded("engine_thread_resume", decodeThreadResumeResponse, {
    request: { threadId },
  });
}

export function readThread(threadId: string, cursor: string | null): Promise<ThreadReadResponse> {
  return invokeDecoded("engine_thread_read", decodeThreadReadResponse, {
    request: { cursor, threadId },
  });
}

export function readOutput(outputId: string, cursor: string | null): Promise<OutputReadResponse> {
  return invokeDecoded("engine_output_read", decodeOutputReadResponse, {
    request: { cursor, outputId },
  });
}

export function setThreadName(threadId: string, name: string): Promise<OperationAck> {
  return invokeDecoded("engine_thread_set_name", decodeOperationAck, {
    request: { threadId, name },
  });
}

export function archiveThread(threadId: string): Promise<OperationAck> {
  return invokeDecoded("engine_thread_archive", decodeOperationAck, {
    request: { threadId },
  });
}

export function unarchiveThread(threadId: string): Promise<ThreadUnarchiveResponse> {
  return invokeDecoded("engine_thread_unarchive", decodeThreadUnarchiveResponse, {
    request: { threadId },
  });
}

export function deleteThread(threadId: string): Promise<OperationAck> {
  return invokeDecoded("engine_thread_delete", decodeOperationAck, {
    request: { threadId },
  });
}

export function forkThread(threadId: string): Promise<ThreadForkResponse> {
  return invokeDecoded("engine_thread_fork", decodeThreadForkResponse, {
    request: { threadId },
  });
}

export interface StartTurnRequest {
  readonly threadId: string;
  readonly clientUserMessageId: string;
  readonly text: string;
  readonly attachments: readonly { readonly path: string }[];
  readonly model: string | null;
  readonly effort: ReasoningEffort | null;
  readonly serviceTier: string | null;
}

export function startTurn(request: StartTurnRequest): Promise<TurnStartResponse> {
  const payload: {
    attachments: StartTurnRequest["attachments"];
    clientUserMessageId: string;
    effort?: ReasoningEffort;
    model?: string;
    serviceTier: { readonly type: "default" } | { readonly type: "tier"; readonly id: string };
    text: string;
    threadId: string;
    timezone: string;
    timezoneOffsetMin: number;
  } = {
    threadId: request.threadId,
    clientUserMessageId: request.clientUserMessageId,
    text: request.text,
    attachments: request.attachments,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffsetMin: new Date().getTimezoneOffset(),
    serviceTier:
      request.serviceTier === null
        ? { type: "default" }
        : { type: "tier", id: request.serviceTier },
  };
  if (request.model !== null) {
    payload.model = request.model;
  }
  if (request.effort !== null) {
    payload.effort = request.effort;
  }
  return invokeDecoded("engine_turn_start", decodeTurnStartResponse, { request: payload });
}

export interface SteerTurnRequest {
  readonly threadId: string;
  readonly expectedTurnId: string;
  readonly clientUserMessageId: string;
  readonly text: string;
  readonly attachments: readonly { readonly path: string }[];
}

export function steerTurn(request: SteerTurnRequest): Promise<OperationAck> {
  return invokeDecoded("engine_turn_steer", decodeOperationAck, { request });
}

export function interruptTurn(threadId: string, turnId: string): Promise<OperationAck> {
  return invokeDecoded("engine_turn_interrupt", decodeOperationAck, {
    request: { threadId, turnId },
  });
}

function automationPayload(input: AutomationInput) {
  return {
    ...input,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffsetMin: new Date().getTimezoneOffset(),
  };
}

export function listAutomations(): Promise<AutomationListResponse> {
  return invokeDecoded("engine_automation_list", decodeAutomationListResponse);
}

export function createAutomation(input: AutomationInput): Promise<Automation> {
  return invokeDecoded("engine_automation_create", decodeAutomation, {
    request: automationPayload(input),
  });
}

export function updateAutomation(
  automationId: string,
  expectedVersion: number,
  input: AutomationInput,
): Promise<Automation> {
  return invokeDecoded("engine_automation_update", decodeAutomation, {
    request: {
      id: automationId,
      expectedVersion,
      ...automationPayload(input),
    },
  });
}

export function deleteAutomation(automationId: string): Promise<OperationAck> {
  return invokeDecoded("engine_automation_delete", decodeOperationAck, {
    request: { automationId },
  });
}

export function runAutomationNow(automationId: string): Promise<AutomationRun> {
  return invokeDecoded("engine_automation_run_now", decodeAutomationRun, {
    request: { automationId },
  });
}

export function markAutomationRunReviewed(runId: string): Promise<OperationAck> {
  return invokeDecoded("engine_automation_run_mark_reviewed", decodeOperationAck, {
    request: { runId },
  });
}

export function readApplicationPreferences(): Promise<ApplicationPreferences> {
  return invokeDecoded("application_preferences_read", decodeApplicationPreferences);
}

export function updateApplicationPreferences(
  preferences: ApplicationPreferences,
): Promise<ApplicationPreferences> {
  return invokeDecoded("application_preferences_update", decodeApplicationPreferences, {
    preferences,
  });
}

export function updateConfig(
  expectedVersion: number,
  update: ConfigUpdate,
): Promise<ConfigUpdateResponse> {
  const validatedUpdate = decodeConfigUpdate(update);
  return invokeDecoded("engine_config_update", decodeConfigUpdateResponse, {
    request: { expectedVersion, update: validatedUpdate },
  });
}

export function listModels(): Promise<ModelListResponse> {
  return invokeDecoded("engine_model_list", decodeModelListResponse);
}

export function listChatModels(): Promise<ChatModelListResponse> {
  return invokeDecoded("engine_chat_model_list", decodeChatModelListResponse);
}

export function inspectAttachments(paths: readonly string[]): Promise<readonly Attachment[]> {
  return invokeDecoded("attachment_inspect", decodeAttachments, { request: { paths } });
}

export function savePastedImage(dataBase64: string): Promise<Attachment> {
  return invokeDecoded("attachment_save_pasted_image", decodeAttachment, {
    request: { dataBase64 },
  });
}

export function readAttachmentImage(path: string): Promise<AttachmentImageResponse> {
  return invokeDecoded("attachment_read_image", decodeAttachmentImageResponse, {
    request: { path },
  });
}

export function respondToServerRequest(
  id: string,
  decision: ApprovalDecision,
): Promise<OperationAck> {
  return invokeDecoded("engine_server_request_respond", decodeOperationAck, {
    request: { id, response: { decision } },
  });
}

export function openExternalUrl(url: string): Promise<void> {
  if (hasBrowserPreviewRuntime()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return Promise.resolve();
  }
  return openUrl(url);
}

export function openDesktopDialog(options: {
  readonly directory: boolean;
  readonly multiple: boolean;
}): Promise<string | string[] | null> {
  if (hasBrowserPreviewRuntime()) {
    return invoke<string | string[] | null>("plugin:dialog|open", { options });
  }
  return open(options);
}

export async function confirmDesktopDialog(
  message: string,
  options: {
    readonly cancelLabel: string;
    readonly kind: "error" | "info" | "warning";
    readonly okLabel: string;
    readonly title: string;
  },
): Promise<boolean> {
  if (!hasBrowserPreviewRuntime()) {
    return confirm(message, options);
  }
  const result = await invoke<string>("plugin:dialog|message", {
    buttons: { cancel: options.cancelLabel, ok: options.okLabel },
    kind: options.kind,
    message,
    title: options.title,
  });
  return result === options.okLabel;
}

export function openWorkspaceDirectory(path: string): Promise<OperationAck> {
  return invokeDecoded("application_workspace_open", decodeOperationAck, {
    request: { path },
  });
}

async function invokeDecoded<T>(
  command: string,
  decoder: Decoder<T>,
  argumentsValue?: Record<string, unknown>,
): Promise<T> {
  const response = await invoke<unknown>(command, argumentsValue);
  return decoder(response);
}

function decodeEvent<T>(
  payload: unknown,
  decoder: Decoder<T>,
  handler: (value: T) => void,
  handlers: EventHandlers,
): void {
  try {
    handler(decoder(payload));
  } catch (reason) {
    handlers.onContractError(asError(reason, "An invalid event was received from the engine."));
  }
}

function asError(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback);
}
