import { open } from "@tauri-apps/plugin-dialog";
import {
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
} from "solid-js";

import {
  describeCommandError,
  inspectAttachments,
  interruptTurn,
  listModels,
  loginWithChatGpt,
  logout,
  openExternalUrl,
  readAccount,
  readConfig,
  respondToServerRequest,
  savePastedImage,
  startRuntime,
  startThread,
  startTurn,
  subscribeToCodexEvents,
  writeConfig,
  writeConfigBatch,
} from "../../shared/codex/client";
import {
  isJsonObject,
  readString,
  type AccountReadResponse,
  type Attachment,
  type CodexModel,
  type CodexNotification,
  type CodexServerRequest,
  type ConfigReadResponse,
  type ConfigEditRequest,
  type JsonObject,
  type JsonValue,
  type ModelListResponse,
  type RuntimeDiagnostic,
  type RuntimeStartResponse,
  type RuntimeStatus,
} from "../../shared/codex/types";

const WORKSPACE_STORAGE_KEY = "codex-app.workspace";

export interface MessageEntry {
  type: "message";
  id: string;
  role: "assistant" | "user";
  text: string;
  attachments: Attachment[];
  phase: string | null;
  status: "complete" | "failed" | "streaming";
}

export interface ActivityEntry {
  type: "activity";
  id: string;
  label: string;
  detail: string;
  status: string;
}

export type TimelineEntry = ActivityEntry | MessageEntry;
export type ApprovalDecision = "accept" | "acceptForSession" | "cancel" | "decline";

export interface CodexSession {
  account: Accessor<AccountReadResponse | undefined>;
  activeTurnId: Accessor<string | null>;
  approvalQueue: Accessor<CodexServerRequest[]>;
  busy: Accessor<boolean>;
  config: Accessor<ConfigReadResponse | null>;
  diagnostics: Accessor<RuntimeDiagnostic[]>;
  error: Accessor<string | null>;
  loginPending: Accessor<boolean>;
  models: Accessor<CodexModel[]>;
  runtime: Accessor<RuntimeStartResponse | null>;
  runtimeStatus: Accessor<RuntimeStatus>;
  signedIn: Accessor<boolean>;
  threadId: Accessor<string | null>;
  timeline: Accessor<TimelineEntry[]>;
  workspace: Accessor<string | null>;
  chooseWorkspace: () => Promise<void>;
  clearError: () => void;
  inspectFiles: (paths: string[]) => Promise<Attachment[]>;
  interrupt: () => Promise<void>;
  interruptPendingRequest: (request: CodexServerRequest) => Promise<void>;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  newThread: () => void;
  refreshConfig: () => Promise<void>;
  respondToApproval: (
    request: CodexServerRequest,
    decision: ApprovalDecision,
  ) => Promise<void>;
  saveClipboardImage: (dataBase64: string) => Promise<Attachment>;
  sendMessage: (text: string, attachments: Attachment[]) => Promise<boolean>;
  writeSetting: (
    keyPath: string,
    value: JsonValue,
    mergeStrategy: "replace" | "upsert",
  ) => Promise<void>;
  writeSettings: (edits: ConfigEditRequest[]) => Promise<void>;
}

export function createCodexSession(): CodexSession {
  const [runtime, setRuntime] = createSignal<RuntimeStartResponse | null>(null);
  const [runtimeStatus, setRuntimeStatus] = createSignal<RuntimeStatus>({
    state: "starting",
    message: null,
  });
  const [account, setAccount] = createSignal<AccountReadResponse>();
  const [loginPending, setLoginPending] = createSignal(false);
  const [workspace, setWorkspace] = createSignal(loadStoredWorkspace());
  const [threadId, setThreadId] = createSignal<string | null>(null);
  const [activeTurnId, setActiveTurnId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [timeline, setTimeline] = createSignal<TimelineEntry[]>([]);
  const [approvalQueue, setApprovalQueue] = createSignal<CodexServerRequest[]>([]);
  const [config, setConfig] = createSignal<ConfigReadResponse | null>(null);
  const [models, setModels] = createSignal<CodexModel[]>([]);
  const [diagnostics, setDiagnostics] = createSignal<RuntimeDiagnostic[]>([]);
  const [error, setError] = createSignal<string | null>(null);

  const signedIn = createMemo(() => {
    const snapshot = account();
    return snapshot !== undefined &&
      (snapshot.account !== null || !snapshot.requiresOpenaiAuth);
  });

  let disposeEvents: () => void = () => undefined;
  let disposed = false;

  onMount(() => {
    void (async () => {
      try {
        const dispose = await subscribeToCodexEvents({
          onNotification: handleNotification,
          onServerRequest: handleServerRequest,
          onRuntimeDiagnostic: handleDiagnostic,
          onRuntimeStatus: setRuntimeStatus,
        });
        if (disposed) {
          dispose();
          return;
        }
        disposeEvents = dispose;
        await bootstrap();
      } catch (reason) {
        const message = describeCommandError(reason);
        setRuntimeStatus({ state: "failed", message });
        setError(message);
      }
    })();
  });

  onCleanup(() => {
    disposed = true;
    disposeEvents();
  });

  async function bootstrap() {
    const started = await startRuntime();
    setRuntime(started);
    setRuntimeStatus({ state: "ready", message: null });
    await refreshAccount();

    const [configResult, modelsResult] = await Promise.allSettled([
      refreshConfig(),
      listModels(),
    ]);
    if (modelsResult.status === "fulfilled") {
      setModels(extractModels(modelsResult.value));
    }
    if (configResult.status === "rejected") {
      addDiagnostic("stderr", describeCommandError(configResult.reason));
    }
  }

  async function refreshAccount() {
    setAccount(await readAccount());
  }

  async function login() {
    setLoginPending(true);
    setError(null);
    try {
      const response = await loginWithChatGpt();
      await openExternalUrl(response.authUrl);
    } catch (reason) {
      setLoginPending(false);
      setError(describeCommandError(reason));
    }
  }

  async function logoutAccount() {
    setError(null);
    try {
      await logout();
      setThreadId(null);
      setTimeline([]);
      await refreshAccount();
    } catch (reason) {
      setError(describeCommandError(reason));
    }
  }

  async function chooseWorkspace() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Selecione a pasta do projeto",
    });
    if (typeof selected !== "string") {
      return;
    }
    setWorkspace(selected);
    localStorage.setItem(WORKSPACE_STORAGE_KEY, selected);
    setThreadId(null);
    setTimeline([]);
    await refreshConfig();
  }

  function newThread() {
    if (busy()) {
      return;
    }
    setThreadId(null);
    setActiveTurnId(null);
    setTimeline([]);
    setApprovalQueue([]);
    setError(null);
  }

  async function sendMessage(
    rawText: string,
    attachments: Attachment[],
  ): Promise<boolean> {
    const text = rawText.trim();
    if (busy() || (text.length === 0 && attachments.length === 0)) {
      return false;
    }
    const cwd = workspace();
    if (cwd === null) {
      setError("Selecione uma pasta de projeto antes de iniciar a conversa.");
      return false;
    }

    const clientUserMessageId = crypto.randomUUID();
    upsertEntry({
      type: "message",
      id: clientUserMessageId,
      role: "user",
      text,
      attachments,
      phase: null,
      status: "streaming",
    });
    setBusy(true);
    setError(null);

    try {
      let currentThreadId = threadId();
      if (currentThreadId === null) {
        const response = await startThread({ cwd });
        currentThreadId = response.thread.id;
        setThreadId(currentThreadId);
      }

      const response = await startTurn({
        threadId: currentThreadId,
        clientUserMessageId,
        text,
        attachments: attachments.map(({ path }) => ({ path })),
      });
      setActiveTurnId(response.turn.id);
      updateEntry(clientUserMessageId, (entry) =>
        entry.type === "message" ? { ...entry, status: "complete" } : entry,
      );
      return true;
    } catch (reason) {
      setBusy(false);
      updateEntry(clientUserMessageId, (entry) =>
        entry.type === "message" ? { ...entry, status: "failed" } : entry,
      );
      setError(describeCommandError(reason));
      return false;
    }
  }

  async function interrupt() {
    const currentThreadId = threadId();
    const currentTurnId = activeTurnId();
    if (currentThreadId === null || currentTurnId === null) {
      return;
    }
    try {
      await interruptTurn({
        threadId: currentThreadId,
        turnId: currentTurnId,
      });
    } catch (reason) {
      setError(describeCommandError(reason));
    }
  }

  async function refreshConfig() {
    const response = await readConfig({
      includeLayers: true,
      cwd: workspace(),
    });
    setConfig(response);
  }

  async function writeSetting(
    keyPath: string,
    value: JsonValue,
    mergeStrategy: "replace" | "upsert",
  ) {
    await writeConfig({ keyPath, value, mergeStrategy });
    await refreshConfig();
  }

  async function writeSettings(edits: ConfigEditRequest[]) {
    await writeConfigBatch({ edits });
    await refreshConfig();
  }

  async function respondToApproval(
    request: CodexServerRequest,
    decision: ApprovalDecision,
  ) {
    try {
      await respondToServerRequest({
        id: request.id,
        response: { decision },
      });
      removeServerRequest(request.id);
    } catch (reason) {
      setError(describeCommandError(reason));
    }
  }

  async function interruptPendingRequest(request: CodexServerRequest) {
    const params = asObject(request.params);
    const requestedThreadId = readString(params, "threadId") ?? threadId();
    const requestedTurnId = readString(params, "turnId") ?? activeTurnId();
    if (requestedThreadId !== null && requestedTurnId !== null) {
      try {
        await interruptTurn({
          threadId: requestedThreadId,
          turnId: requestedTurnId,
        });
      } catch (reason) {
        setError(describeCommandError(reason));
      }
    }
    removeServerRequest(request.id);
  }

  function handleNotification(notification: CodexNotification) {
    const params = asObject(notification.params);
    switch (notification.method) {
      case "account/login/completed": {
        setLoginPending(false);
        if (params?.success === false) {
          setError(readString(params, "error") ?? "Não foi possível concluir o login.");
        } else {
          void refreshAccount();
        }
        break;
      }
      case "account/updated":
        void refreshAccount();
        break;
      case "thread/started": {
        const item = asObject(params?.thread);
        const id = readString(item, "id");
        if (id !== undefined && threadId() === null) {
          setThreadId(id);
        }
        break;
      }
      case "turn/started": {
        const turn = asObject(params?.turn);
        setActiveTurnId(readString(turn, "id") ?? null);
        setBusy(true);
        break;
      }
      case "turn/completed": {
        const turn = asObject(params?.turn);
        const turnError = asObject(turn?.error);
        const message = readString(turnError, "message");
        if (message !== undefined) {
          setError(message);
        }
        setActiveTurnId(null);
        setBusy(false);
        break;
      }
      case "item/started":
      case "item/completed":
        handleItem(params, notification.method === "item/completed");
        break;
      case "item/agentMessage/delta":
        appendAgentDelta(params);
        break;
      case "error": {
        const eventError = asObject(params?.error);
        setError(readString(eventError, "message") ?? "O turno falhou.");
        break;
      }
      case "serverRequest/resolved": {
        const requestId = params?.requestId;
        if (requestId !== undefined) {
          removeServerRequest(requestId);
        }
        break;
      }
      default:
        break;
    }
  }

  function handleServerRequest(request: CodexServerRequest) {
    setApprovalQueue((queue) => [...queue, request]);
  }

  function handleDiagnostic(diagnostic: RuntimeDiagnostic) {
    addDiagnostic(diagnostic.stream, diagnostic.message);
  }

  function addDiagnostic(stream: RuntimeDiagnostic["stream"], message: string) {
    setDiagnostics((current) => [...current.slice(-19), { stream, message }]);
  }

  function handleItem(params: JsonObject | undefined, completed: boolean) {
    const item = asObject(params?.item);
    if (item === undefined) {
      return;
    }
    const itemType = readString(item, "type");
    const id = readString(item, "id");
    if (itemType === undefined || id === undefined) {
      return;
    }

    if (itemType === "agentMessage") {
      const text = readString(item, "text") ?? "";
      upsertEntry({
        type: "message",
        id,
        role: "assistant",
        text,
        attachments: [],
        phase: readString(item, "phase") ?? null,
        status: completed ? "complete" : "streaming",
      });
      return;
    }
    if (itemType === "userMessage") {
      const parsed = parseUserMessage(id, item);
      const optimistic = timeline().find(
        (entry) => entry.type === "message" && entry.role === "user" && entry.status === "streaming",
      );
      if (optimistic?.type === "message" && optimistic.id !== id) {
        replaceEntryId(optimistic.id, parsed);
      } else {
        upsertEntry(parsed);
      }
      return;
    }

    const status = readString(item, "status") ?? (completed ? "completed" : "inProgress");
    const detail = activityDetail(itemType, item);
    upsertEntry({
      type: "activity",
      id,
      label: activityLabel(itemType),
      detail,
      status,
    });
  }

  function appendAgentDelta(params: JsonObject | undefined) {
    const id = readString(params, "itemId");
    const delta = readString(params, "delta");
    if (id === undefined || delta === undefined) {
      return;
    }
    const exists = timeline().some((entry) => entry.id === id);
    if (!exists) {
      upsertEntry({
        type: "message",
        id,
        role: "assistant",
        text: delta,
        attachments: [],
        phase: null,
        status: "streaming",
      });
      return;
    }
    updateEntry(id, (entry) =>
      entry.type === "message"
        ? { ...entry, text: `${entry.text}${delta}`, status: "streaming" }
        : entry,
    );
  }

  function upsertEntry(entry: TimelineEntry) {
    setTimeline((current) => {
      const index = current.findIndex(({ id }) => id === entry.id);
      if (index < 0) {
        return [...current, entry];
      }
      const existing = current[index];
      const next = [...current];
      if (
        existing?.type === "message" &&
        entry.type === "message" &&
        existing.attachments.length > 0 &&
        entry.attachments.length === 0
      ) {
        next[index] = { ...entry, attachments: existing.attachments };
      } else {
        next[index] = entry;
      }
      return next;
    });
  }

  function updateEntry(id: string, update: (entry: TimelineEntry) => TimelineEntry) {
    setTimeline((current) =>
      current.map((entry) => (entry.id === id ? update(entry) : entry)),
    );
  }

  function replaceEntryId(previousId: string, replacement: TimelineEntry) {
    setTimeline((current) =>
      current.map((entry) => (entry.id === previousId ? replacement : entry)),
    );
  }

  function removeServerRequest(id: JsonValue) {
    const serializedId = JSON.stringify(id);
    setApprovalQueue((queue) =>
      queue.filter((request) => JSON.stringify(request.id) !== serializedId),
    );
  }

  return {
    account,
    activeTurnId,
    approvalQueue,
    busy,
    config,
    diagnostics,
    error,
    loginPending,
    models,
    runtime,
    runtimeStatus,
    signedIn,
    threadId,
    timeline,
    workspace,
    chooseWorkspace,
    clearError: () => setError(null),
    inspectFiles: inspectAttachments,
    interrupt,
    interruptPendingRequest,
    login,
    logout: logoutAccount,
    newThread,
    refreshConfig,
    respondToApproval,
    saveClipboardImage: savePastedImage,
    sendMessage,
    writeSetting,
    writeSettings,
  };
}

function loadStoredWorkspace(): string | null {
  return localStorage.getItem(WORKSPACE_STORAGE_KEY);
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function extractModels(response: ModelListResponse): CodexModel[] {
  return response.data ?? response.models ?? [];
}

function parseUserMessage(id: string, item: JsonObject): MessageEntry {
  const content = item.content;
  const text: string[] = [];
  const attachments: Attachment[] = [];
  if (Array.isArray(content)) {
    content.forEach((value, index) => {
      const input = asObject(value);
      const inputType = readString(input, "type");
      if (inputType === "text") {
        text.push(readString(input, "text") ?? "");
      } else if (inputType === "localImage") {
        const path = readString(input, "path") ?? "";
        attachments.push({
          id: `${id}-${index}`,
          name: fileName(path),
          path,
          kind: "image",
          size: 0,
          mediaType: null,
        });
      } else if (inputType === "mention") {
        const path = readString(input, "path") ?? "";
        attachments.push({
          id: `${id}-${index}`,
          name: readString(input, "name") ?? fileName(path),
          path,
          kind: "file",
          size: 0,
          mediaType: null,
        });
      }
    });
  }
  return {
    type: "message",
    id,
    role: "user",
    text: text.join("\n"),
    attachments,
    phase: null,
    status: "complete",
  };
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function activityLabel(type: string): string {
  switch (type) {
    case "commandExecution":
      return "Comando";
    case "fileChange":
      return "Alteração de arquivos";
    case "reasoning":
      return "Raciocínio";
    case "plan":
      return "Plano";
    case "mcpToolCall":
      return "Ferramenta MCP";
    case "webSearch":
      return "Pesquisa na web";
    default:
      return type;
  }
}

function activityDetail(type: string, item: JsonObject): string {
  if (type === "commandExecution") {
    const command = item.command;
    return Array.isArray(command)
      ? command.filter((part): part is string => typeof part === "string").join(" ")
      : typeof command === "string"
        ? command
        : "Executando comando";
  }
  if (type === "fileChange") {
    const changes = item.changes;
    return Array.isArray(changes)
      ? `${changes.length} arquivo${changes.length === 1 ? "" : "s"}`
      : "Preparando alterações";
  }
  return readString(item, "text") ?? readString(item, "query") ?? "Em andamento";
}
