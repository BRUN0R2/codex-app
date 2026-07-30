import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

import type {
  AccountReadResponse,
  Attachment,
  CancelLoginRequest,
  CancelLoginResponse,
  CodexNotification,
  CodexServerRequest,
  CommandError,
  ConfigBatchWriteRequest,
  ConfigReadRequest,
  ConfigReadResponse,
  ConfigWriteRequest,
  JsonValue,
  LoginChatGptResponse,
  ModelListResponse,
  NativeLogoutResponse,
  RuntimeDiagnostic,
  RuntimeStartResponse,
  RuntimeStatus,
  ServerResponseRequest,
  ThreadArchiveRequest,
  ThreadListRequest,
  ThreadListResponse,
  ThreadResumeRequest,
  ThreadResumeResponse,
  ThreadSetNameRequest,
  ThreadStartRequest,
  ThreadStartResponse,
  TurnInterruptRequest,
  TurnStartRequest,
  TurnStartResponse,
} from "./types";

const NOTIFICATION_EVENT = "engine://notification";
const SERVER_REQUEST_EVENT = "engine://server-request";
const RUNTIME_DIAGNOSTIC_EVENT = "engine://runtime-diagnostic";
const RUNTIME_STATUS_EVENT = "engine://runtime-status";

export interface CodexEventHandlers {
  onNotification: (notification: CodexNotification) => void;
  onServerRequest: (request: CodexServerRequest) => void;
  onRuntimeDiagnostic: (diagnostic: RuntimeDiagnostic) => void;
  onRuntimeStatus: (status: RuntimeStatus) => void;
}

export async function subscribeToCodexEvents(
  handlers: CodexEventHandlers,
): Promise<() => void> {
  const unlisteners: UnlistenFn[] = await Promise.all([
    listen<CodexNotification>(NOTIFICATION_EVENT, (event) => {
      handlers.onNotification(event.payload);
    }),
    listen<CodexServerRequest>(SERVER_REQUEST_EVENT, (event) => {
      handlers.onServerRequest(event.payload);
    }),
    listen<RuntimeDiagnostic>(RUNTIME_DIAGNOSTIC_EVENT, (event) => {
      handlers.onRuntimeDiagnostic(event.payload);
    }),
    listen<RuntimeStatus>(RUNTIME_STATUS_EVENT, (event) => {
      handlers.onRuntimeStatus(event.payload);
    }),
  ]);

  return () => {
    for (const unlisten of unlisteners) {
      unlisten();
    }
  };
}

export function startRuntime(): Promise<RuntimeStartResponse> {
  return invoke("engine_start");
}

export function readAccount(): Promise<AccountReadResponse> {
  return invoke("engine_account_read");
}

export function loginWithChatGpt(): Promise<LoginChatGptResponse> {
  return invoke("engine_login_chatgpt");
}

export function cancelLogin(
  request: CancelLoginRequest,
): Promise<CancelLoginResponse> {
  return invoke("engine_login_cancel", { request });
}

export function logout(): Promise<JsonValue | NativeLogoutResponse> {
  return invoke("engine_logout");
}

export function startThread(
  request: ThreadStartRequest,
): Promise<ThreadStartResponse> {
  return invoke("engine_thread_start", { request });
}

export function listThreads(
  request: ThreadListRequest,
): Promise<ThreadListResponse> {
  return invoke("engine_thread_list", { request });
}

export function resumeThread(
  request: ThreadResumeRequest,
): Promise<ThreadResumeResponse> {
  return invoke("engine_thread_resume", { request });
}

export function setThreadName(request: ThreadSetNameRequest): Promise<JsonValue> {
  return invoke("engine_thread_set_name", { request });
}

export function archiveThread(request: ThreadArchiveRequest): Promise<JsonValue> {
  return invoke("engine_thread_archive", { request });
}

export function startTurn(request: TurnStartRequest): Promise<TurnStartResponse> {
  return invoke("engine_turn_start", { request });
}

export function interruptTurn(
  request: TurnInterruptRequest,
): Promise<JsonValue> {
  return invoke("engine_turn_interrupt", { request });
}

export function readConfig(
  request: ConfigReadRequest,
): Promise<ConfigReadResponse> {
  return invoke("engine_config_read", { request });
}

export function writeConfig(request: ConfigWriteRequest): Promise<JsonValue> {
  return invoke("engine_config_write", { request });
}

export function writeConfigBatch(
  request: ConfigBatchWriteRequest,
): Promise<JsonValue> {
  return invoke("engine_config_batch_write", { request });
}

export function listModels(): Promise<ModelListResponse> {
  return invoke("engine_model_list");
}

export function inspectAttachments(paths: string[]): Promise<Attachment[]> {
  return invoke("attachment_inspect", { paths });
}

export function savePastedImage(dataBase64: string): Promise<Attachment> {
  return invoke("attachment_save_pasted_image", {
    request: { dataBase64 },
  });
}

export function respondToServerRequest(
  request: ServerResponseRequest,
): Promise<void> {
  return invoke("engine_server_request_respond", { request });
}

export function openExternalUrl(url: string): Promise<void> {
  return openUrl(url);
}

export function describeCommandError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error !== null && typeof error === "object") {
    const candidate = error as Partial<CommandError>;
    if (typeof candidate.message === "string") {
      return candidate.message;
    }
  }
  return "Ocorreu um erro inesperado.";
}
