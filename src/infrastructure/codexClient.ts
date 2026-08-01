import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
  decodeAccountRateLimitsResponse,
  decodeAccountReadResponse,
  decodeAttachment,
  decodeAttachments,
  decodeCancelLoginResponse,
  decodeCommandError,
  decodeConfigReadResponse,
  decodeConfigUpdateResponse,
  decodeEngineNotification,
  decodeEngineServerRequest,
  decodeEngineStartResponse,
  decodeLoginResponse,
  decodeLogoutResponse,
  decodeModelListResponse,
  decodeOperationAck,
  decodeRuntimeDiagnostic,
  decodeRuntimeStatus,
  decodeThreadListResponse,
  decodeThreadReadResponse,
  decodeThreadResumeResponse,
  decodeThreadStartResponse,
  decodeTurnStartResponse,
} from "../contracts/decode";
import type {
  AccountRateLimitsResponse,
  AccountReadResponse,
  ApprovalDecision,
  Attachment,
  CancelLoginResponse,
  ConfigReadResponse,
  ConfigUpdate,
  ConfigUpdateResponse,
  EngineNotification,
  EngineServerRequest,
  EngineStartResponse,
  LoginResponse,
  LogoutResponse,
  ModelListResponse,
  OperationAck,
  ReasoningEffort,
  RuntimeDiagnostic,
  RuntimeStatus,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  TurnStartResponse,
} from "../contracts/types";

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
      await listen<unknown>(NOTIFICATION_EVENT, (event) => {
        decodeEvent(event.payload, decodeEngineNotification, handlers.onNotification, handlers);
      }),
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
    throw asError(reason, "Não foi possível registrar os eventos do engine.");
  }
  return () => {
    for (const unlisten of unlisteners) {
      unlisten();
    }
  };
}

export function startEngine(): Promise<EngineStartResponse> {
  return invokeDecoded("engine_start", decodeEngineStartResponse);
}

export function readAccount(): Promise<AccountReadResponse> {
  return invokeDecoded("engine_account_read", decodeAccountReadResponse);
}

export function readRateLimits(): Promise<AccountRateLimitsResponse> {
  return invokeDecoded("engine_account_rate_limits_read", decodeAccountRateLimitsResponse);
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

export function startThread(cwd: string): Promise<ThreadStartResponse> {
  return invokeDecoded("engine_thread_start", decodeThreadStartResponse, {
    request: { cwd },
  });
}

export function listThreads(cursor: string | null): Promise<ThreadListResponse> {
  return invokeDecoded("engine_thread_list", decodeThreadListResponse, {
    request: { cursor },
  });
}

export function resumeThread(threadId: string): Promise<ThreadResumeResponse> {
  return invokeDecoded("engine_thread_resume", decodeThreadResumeResponse, {
    request: { threadId },
  });
}

export function readThread(threadId: string): Promise<ThreadReadResponse> {
  return invokeDecoded("engine_thread_read", decodeThreadReadResponse, {
    request: { threadId },
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

export interface StartTurnRequest {
  readonly threadId: string;
  readonly clientUserMessageId: string;
  readonly text: string;
  readonly attachments: readonly { readonly path: string }[];
  readonly model: string | null;
  readonly effort: ReasoningEffort | null;
}

export function startTurn(request: StartTurnRequest): Promise<TurnStartResponse> {
  const payload: {
    attachments: StartTurnRequest["attachments"];
    clientUserMessageId: string;
    effort?: ReasoningEffort;
    model?: string;
    text: string;
    threadId: string;
  } = {
    threadId: request.threadId,
    clientUserMessageId: request.clientUserMessageId,
    text: request.text,
    attachments: request.attachments,
  };
  if (request.model !== null) {
    payload.model = request.model;
  }
  if (request.effort !== null) {
    payload.effort = request.effort;
  }
  return invokeDecoded("engine_turn_start", decodeTurnStartResponse, { request: payload });
}

export function interruptTurn(threadId: string, turnId: string): Promise<OperationAck> {
  return invokeDecoded("engine_turn_interrupt", decodeOperationAck, {
    request: { threadId, turnId },
  });
}

export function readConfig(): Promise<ConfigReadResponse> {
  return invokeDecoded("engine_config_read", decodeConfigReadResponse);
}

export function updateConfig(
  expectedVersion: number,
  update: ConfigUpdate,
): Promise<ConfigUpdateResponse> {
  return invokeDecoded("engine_config_update", decodeConfigUpdateResponse, {
    request: { expectedVersion, update },
  });
}

export function listModels(): Promise<ModelListResponse> {
  return invokeDecoded("engine_model_list", decodeModelListResponse);
}

export function inspectAttachments(paths: readonly string[]): Promise<readonly Attachment[]> {
  return invokeDecoded("attachment_inspect", decodeAttachments, { paths });
}

export function savePastedImage(dataBase64: string): Promise<Attachment> {
  return invokeDecoded("attachment_save_pasted_image", decodeAttachment, {
    request: { dataBase64 },
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
  return openUrl(url);
}

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
    handlers.onContractError(asError(reason, "Evento inválido recebido do engine."));
  }
}

function asError(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback);
}
