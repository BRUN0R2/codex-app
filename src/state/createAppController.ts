import { open } from "@tauri-apps/plugin-dialog";
import {
  type Accessor,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import type {
  AccountRateLimitsResponse,
  AccountReadResponse,
  ApprovalDecision,
  Attachment,
  CodexModel,
  CodexThread,
  ConfigReadResponse,
  ConfigUpdate,
  EngineNotification,
  EngineServerRequest,
  EngineStartResponse,
  ProjectRecord,
  ReasoningEffort,
  RuntimeDiagnostic,
  RuntimeStatus,
  ThreadItem,
} from "../contracts/types";
import {
  archiveThread as archiveThreadCommand,
  cancelLogin as cancelLoginCommand,
  describeError,
  inspectAttachments,
  interruptTurn,
  listModels,
  listThreads,
  loginWithChatGpt,
  logout as logoutCommand,
  openExternalUrl,
  readAccount,
  readConfig,
  readRateLimits,
  respondToServerRequest,
  resumeThread,
  savePastedImage,
  setThreadName,
  startEngine,
  startThread,
  startTurn,
  subscribeToEvents,
  updateConfig,
} from "../infrastructure/codexClient";
import {
  appendAgentText,
  appendReasoningText,
  flattenThreadItems,
  upsertItem,
} from "./conversation";
import { addProject, loadProjects, pathsEqual, removeProject, saveProjects } from "./projects";

const MAX_DIAGNOSTICS = 50;
const MAX_PENDING_APPROVALS = 16;

export interface DiagnosticEntry extends RuntimeDiagnostic {
  readonly id: number;
  readonly occurredAt: Date;
}

export interface SendMessageInput {
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly model: string | null;
  readonly effort: ReasoningEffort | null;
}

export interface AppController {
  readonly account: Accessor<AccountReadResponse | undefined>;
  readonly activeTurnId: Accessor<string | null>;
  readonly approvals: Accessor<readonly EngineServerRequest[]>;
  readonly busy: Accessor<boolean>;
  readonly config: Accessor<ConfigReadResponse | null>;
  readonly currentThread: Accessor<CodexThread | null>;
  readonly currentThreadTitle: Accessor<string>;
  readonly diagnostics: Accessor<readonly DiagnosticEntry[]>;
  readonly engine: Accessor<EngineStartResponse | null>;
  readonly error: Accessor<string | null>;
  readonly items: Accessor<readonly ThreadItem[]>;
  readonly loginPending: Accessor<boolean>;
  readonly models: Accessor<readonly CodexModel[]>;
  readonly openingThreadId: Accessor<string | null>;
  readonly pendingOperations: Accessor<number>;
  readonly projects: Accessor<readonly ProjectRecord[]>;
  readonly rateLimits: Accessor<AccountRateLimitsResponse | null>;
  readonly runtimeStatus: Accessor<RuntimeStatus>;
  readonly signedIn: Accessor<boolean>;
  readonly threads: Accessor<readonly CodexThread[]>;
  readonly threadsNextCursor: Accessor<string | null>;
  readonly turnBusy: Accessor<boolean>;
  readonly workspace: Accessor<string | null>;
  readonly archiveThread: (threadId: string) => Promise<boolean>;
  readonly cancelLogin: () => Promise<void>;
  readonly chooseWorkspace: () => Promise<string | null>;
  readonly clearError: () => void;
  readonly inspectFiles: (paths: readonly string[]) => Promise<readonly Attachment[]>;
  readonly interrupt: () => Promise<boolean>;
  readonly loadMoreThreads: () => Promise<boolean>;
  readonly login: () => Promise<boolean>;
  readonly logout: () => Promise<boolean>;
  readonly newThread: (workspace?: string) => Promise<CodexThread | null>;
  readonly openThread: (threadId: string) => Promise<boolean>;
  readonly refreshRateLimits: () => Promise<boolean>;
  readonly removeProject: (path: string) => void;
  readonly renameThread: (threadId: string, name: string) => Promise<boolean>;
  readonly respondToApproval: (requestId: string, decision: ApprovalDecision) => Promise<boolean>;
  readonly saveClipboardImage: (dataBase64: string) => Promise<Attachment | null>;
  readonly selectProject: (path: string) => boolean;
  readonly sendMessage: (input: SendMessageInput) => Promise<boolean>;
  readonly updateSetting: (update: ConfigUpdate) => Promise<boolean>;
}

export function createAppController(): AppController {
  const [runtimeStatus, setRuntimeStatus] = createSignal<RuntimeStatus>({
    state: "starting",
    message: null,
  });
  const [engine, setEngine] = createSignal<EngineStartResponse | null>(null);
  const [account, setAccount] = createSignal<AccountReadResponse>();
  const [models, setModels] = createSignal<readonly CodexModel[]>([]);
  const [config, setConfig] = createSignal<ConfigReadResponse | null>(null);
  const [rateLimits, setRateLimits] = createSignal<AccountRateLimitsResponse | null>(null);
  const [threads, setThreads] = createSignal<readonly CodexThread[]>([]);
  const [threadsNextCursor, setThreadsNextCursor] = createSignal<string | null>(null);
  const [currentThread, setCurrentThread] = createSignal<CodexThread | null>(null);
  const [items, setItems] = createSignal<readonly ThreadItem[]>([]);
  const [activeTurnId, setActiveTurnId] = createSignal<string | null>(null);
  const [approvals, setApprovals] = createSignal<readonly EngineServerRequest[]>([]);
  const [diagnostics, setDiagnostics] = createSignal<readonly DiagnosticEntry[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [pendingOperations, setPendingOperations] = createSignal(0);
  const [openingThreadId, setOpeningThreadId] = createSignal<string | null>(null);
  const [loginPending, setLoginPending] = createSignal(false);
  const [workspace, setWorkspace] = createSignal<string | null>(null);
  let loginId: string | null = null;
  let diagnosticSequence = 0;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let configQueue: Promise<void> = Promise.resolve();
  let authenticationSync: {
    readonly expectedSignedIn: boolean;
    readonly promise: Promise<void>;
  } | null = null;

  let initialProjects: readonly ProjectRecord[] = [];
  let projectLoadError: Error | null = null;
  try {
    initialProjects = loadProjects();
  } catch (reason) {
    projectLoadError = asError(reason);
  }
  const [projects, setProjects] = createSignal(initialProjects);

  const signedIn = createMemo(() => account()?.account !== null && account() !== undefined);
  const turnBusy = createMemo(() => activeTurnId() !== null);
  const busy = createMemo(() => turnBusy() || pendingOperations() > 0);
  const currentThreadTitle = createMemo(() => {
    const thread = currentThread();
    return thread?.name ?? thread?.preview ?? "Nova tarefa";
  });

  createEffect(() => {
    const preferences = config()?.config.desktop;
    if (preferences === undefined) {
      return;
    }
    document.documentElement.style.setProperty("--ui-font-size", `${preferences.uiFontSize}px`);
    document.documentElement.setAttribute("data-motion", preferences.motion);
    document.documentElement.setAttribute(
      "data-pointer",
      preferences.pointerCursor ? "pointer" : "default",
    );
    document.documentElement.setAttribute("data-diff", preferences.diffDisplay);
  });

  onMount(() => {
    if (projectLoadError !== null) {
      reportError(projectLoadError);
    }
    void initialize();
  });

  onCleanup(() => {
    disposed = true;
    unsubscribe?.();
    unsubscribe = null;
  });

  async function initialize(): Promise<void> {
    try {
      const release = await subscribeToEvents({
        onContractError: reportError,
        onDiagnostic: addDiagnostic,
        onNotification: handleNotification,
        onServerRequest: handleServerRequest,
        onStatus: setRuntimeStatus,
      });
      if (disposed) {
        release();
        return;
      }
      unsubscribe = release;
      const started = await startEngine();
      if (disposed) {
        return;
      }
      setEngine(started);
      const currentAccount = await readAccount();
      if (disposed) {
        return;
      }
      setAccount(currentAccount);
      surfaceRefreshFailure(currentAccount);
      if (currentAccount.account !== null) {
        await loadAuthenticatedState();
      }
    } catch (reason) {
      const message = describeError(reason);
      batch(() => {
        setError(message);
        setRuntimeStatus({ state: "failed", message });
      });
    }
  }

  async function loadAuthenticatedState(): Promise<void> {
    const [configuration, catalog, threadPage] = await Promise.all([
      readConfig(),
      listModels(),
      listThreads(null),
    ]);
    batch(() => {
      setConfig(configuration);
      setModels(catalog.data.filter((model) => !model.hidden));
      setThreads(threadPage.data);
      setThreadsNextCursor(threadPage.nextCursor);
    });
    void refreshRateLimits();
  }

  function handleNotification(notification: EngineNotification): void {
    switch (notification.method) {
      case "auth.loginCompleted":
        if (notification.params.loginId !== loginId) {
          throw new Error("O engine concluiu um login diferente do fluxo ativo.");
        }
        loginId = null;
        setLoginPending(false);
        if (!notification.params.success) {
          setError(notification.params.error ?? "O login do ChatGPT não foi concluído.");
          return;
        }
        void synchronizeAuthentication(true);
        return;
      case "auth.sessionChanged":
        void synchronizeAuthentication(notification.params.signedIn);
        return;
      case "thread.created":
      case "thread.updated":
        mergeThread(notification.params.thread);
        if (currentThread()?.id === notification.params.thread.id) {
          batch(() => {
            setCurrentThread(notification.params.thread);
            setItems(flattenThreadItems(notification.params.thread));
          });
        }
        return;
      case "thread.archived":
        setThreads((current) =>
          current.filter((thread) => thread.id !== notification.params.threadId),
        );
        if (currentThread()?.id === notification.params.threadId) {
          clearCurrentThread();
        }
        return;
      case "turn.started":
        if (currentThread()?.id === notification.params.threadId) {
          setActiveTurnId(notification.params.turn.id);
        }
        return;
      case "turn.completed":
        if (currentThread()?.id === notification.params.threadId) {
          if (activeTurnId() === notification.params.turn.id) {
            setActiveTurnId(null);
          }
          if (notification.params.error !== null) {
            setError(notification.params.error.message);
          }
        }
        setApprovals((current) =>
          current.filter((request) => request.params.turnId !== notification.params.turn.id),
        );
        return;
      case "item.started":
      case "item.completed":
        if (currentThread()?.id === notification.params.threadId) {
          setItems((current) => upsertItem(current, notification.params.item));
        }
        return;
      case "item.agentTextDelta":
        if (currentThread()?.id === notification.params.threadId) {
          setItems((current) =>
            appendAgentText(current, notification.params.itemId, notification.params.delta),
          );
        }
        return;
      case "item.reasoningSummaryDelta":
        if (currentThread()?.id === notification.params.threadId) {
          setItems((current) =>
            appendReasoningText(
              current,
              notification.params.itemId,
              notification.params.index,
              notification.params.delta,
              "summary",
            ),
          );
        }
        return;
      case "item.reasoningTextDelta":
        if (currentThread()?.id === notification.params.threadId) {
          setItems((current) =>
            appendReasoningText(
              current,
              notification.params.itemId,
              notification.params.index,
              notification.params.delta,
              "content",
            ),
          );
        }
        return;
      default:
        assertNever(notification);
    }
  }

  function handleServerRequest(request: EngineServerRequest): void {
    setApprovals((current) => {
      if (current.some((entry) => entry.id === request.id)) {
        throw new Error(`A aprovação ${request.id} foi recebida duas vezes.`);
      }
      if (current.length >= MAX_PENDING_APPROVALS) {
        throw new Error(`O limite de ${MAX_PENDING_APPROVALS} aprovações pendentes foi excedido.`);
      }
      return [...current, request];
    });
  }

  function synchronizeAuthentication(expectedSignedIn: boolean): Promise<void> {
    const activeSync = authenticationSync;
    if (activeSync?.expectedSignedIn === expectedSignedIn) {
      return activeSync.promise;
    }

    const predecessor = activeSync?.promise.catch(() => undefined) ?? Promise.resolve();
    const promise = predecessor
      .then(async () => {
        const currentAccount = await readAccount();
        setAccount(currentAccount);
        surfaceRefreshFailure(currentAccount);
        if ((currentAccount.account !== null) !== expectedSignedIn) {
          throw new Error(
            "O estado de autenticação lido diverge da transição emitida pelo engine.",
          );
        }
        if (expectedSignedIn && config() === null) {
          await loadAuthenticatedState();
        }
      })
      .catch(reportError)
      .finally(() => {
        if (authenticationSync?.promise === promise) {
          authenticationSync = null;
        }
      });
    authenticationSync = { expectedSignedIn, promise };
    return promise;
  }

  async function login(): Promise<boolean> {
    if (loginPending()) {
      return false;
    }
    setLoginPending(true);
    setError(null);
    try {
      const response = await loginWithChatGpt();
      loginId = response.loginId;
      try {
        await openExternalUrl(response.authUrl);
      } catch (openError) {
        const cancelResponse = await cancelLoginCommand(response.loginId);
        loginId = null;
        setLoginPending(false);
        throw new Error(
          `Não foi possível abrir o navegador; login ${cancelResponse.status}: ${describeError(openError)}`,
        );
      }
      return true;
    } catch (reason) {
      loginId = null;
      setLoginPending(false);
      reportError(reason);
      return false;
    }
  }

  async function cancelLogin(): Promise<void> {
    const currentLoginId = loginId;
    if (currentLoginId === null) {
      setLoginPending(false);
      return;
    }
    try {
      const response = await cancelLoginCommand(currentLoginId);
      if (response.status !== "canceled") {
        throw new Error("O fluxo de login já não estava ativo.");
      }
    } catch (reason) {
      reportError(reason);
    } finally {
      loginId = null;
      setLoginPending(false);
    }
  }

  async function logout(): Promise<boolean> {
    try {
      const response = await withPending(() => logoutCommand());
      batch(() => {
        setAccount({
          account: null,
          requiresOpenaiAuth: true,
          refresh: { status: "notRequired", error: null },
        });
        setConfig(null);
        setModels([]);
        setRateLimits(null);
        setThreads([]);
        setThreadsNextCursor(null);
        clearCurrentThread();
      });
      if (response.remoteRevocation === "failed") {
        setError(
          response.remoteRevocationError ??
            "A sessão local foi removida, mas a revogação remota falhou.",
        );
      }
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  async function chooseWorkspace(): Promise<string | null> {
    try {
      const selection = await open({ directory: true, multiple: false });
      if (selection === null) {
        return null;
      }
      if (Array.isArray(selection)) {
        throw new Error("O seletor retornou múltiplos diretórios para uma seleção única.");
      }
      return selectProject(selection) ? selection : null;
    } catch (reason) {
      reportError(reason);
      return null;
    }
  }

  function selectProject(path: string): boolean {
    const thread = currentThread();
    if (turnBusy() && thread !== null && !pathsEqual(thread.cwd, path)) {
      setError("Interrompa o turno atual antes de trocar de projeto.");
      return false;
    }
    try {
      const next = addProject(projects(), path);
      saveProjects(next);
      const changesConversation = thread !== null && !pathsEqual(thread.cwd, path);
      batch(() => {
        setProjects(next);
        setWorkspace(path);
        if (changesConversation) {
          clearCurrentThread();
        }
      });
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  function removeProjectFromSidebar(path: string): void {
    try {
      const next = removeProject(projects(), path);
      saveProjects(next);
      setProjects(next);
    } catch (reason) {
      reportError(reason);
    }
  }

  async function newThread(targetWorkspace?: string): Promise<CodexThread | null> {
    if (turnBusy()) {
      setError("Interrompa o turno atual antes de criar outra tarefa.");
      return null;
    }
    let cwd = targetWorkspace ?? workspace();
    if (cwd === null) {
      cwd = await chooseWorkspace();
    }
    if (cwd === null) {
      return null;
    }
    try {
      const response = await withPending(() => startThread(cwd));
      if (!pathsEqual(response.thread.cwd, cwd)) {
        throw new Error("O engine criou a tarefa em um projeto diferente do solicitado.");
      }
      if (!selectProject(response.thread.cwd)) {
        return null;
      }
      batch(() => {
        mergeThread(response.thread);
        setCurrentThread(response.thread);
        setItems([]);
        setActiveTurnId(null);
        setApprovals([]);
      });
      return response.thread;
    } catch (reason) {
      reportError(reason);
      return null;
    }
  }

  async function openThread(threadId: string): Promise<boolean> {
    if (turnBusy() && currentThread()?.id !== threadId) {
      setError("Interrompa o turno atual antes de abrir outra tarefa.");
      return false;
    }
    setOpeningThreadId(threadId);
    try {
      const response = await resumeThread(threadId);
      if (!selectProject(response.cwd)) {
        return false;
      }
      batch(() => {
        setCurrentThread(response.thread);
        setItems(flattenThreadItems(response.thread));
        setActiveTurnId(activeTurnFromThread(response.thread));
        setApprovals((current) =>
          current.filter((request) => request.params.threadId === response.thread.id),
        );
      });
      mergeThread(response.thread);
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    } finally {
      setOpeningThreadId(null);
    }
  }

  async function renameThread(threadId: string, name: string): Promise<boolean> {
    if (name.trim().length === 0) {
      setError("O nome da tarefa não pode ficar vazio.");
      return false;
    }
    try {
      await withPending(() => setThreadName(threadId, name.trim()));
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  async function archiveThread(threadId: string): Promise<boolean> {
    try {
      await withPending(() => archiveThreadCommand(threadId));
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  async function loadMoreThreads(): Promise<boolean> {
    const cursor = threadsNextCursor();
    if (cursor === null) {
      return false;
    }
    try {
      const page = await withPending(() => listThreads(cursor));
      batch(() => {
        setThreads((current) => mergeThreadPages(current, page.data));
        setThreadsNextCursor(page.nextCursor);
      });
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  async function sendMessage(input: SendMessageInput): Promise<boolean> {
    if (turnBusy()) {
      setError("Aguarde ou interrompa o turno atual.");
      return false;
    }
    if (input.text.trim().length === 0 && input.attachments.length === 0) {
      return false;
    }
    let thread = currentThread();
    if (thread === null) {
      thread = await newThread();
    }
    if (thread === null) {
      return false;
    }
    try {
      const response = await startTurn({
        threadId: thread.id,
        clientUserMessageId: crypto.randomUUID(),
        text: input.text,
        attachments: input.attachments.map((attachment) => ({ path: attachment.path })),
        model: input.model,
        effort: input.effort,
      });
      setActiveTurnId(response.turn.id);
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  async function interrupt(): Promise<boolean> {
    const thread = currentThread();
    const turnId = activeTurnId();
    if (thread === null || turnId === null) {
      return false;
    }
    try {
      await interruptTurn(thread.id, turnId);
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  async function respondToApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<boolean> {
    try {
      await respondToServerRequest(requestId, decision);
      setApprovals((current) => current.filter((request) => request.id !== requestId));
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  async function updateSetting(update: ConfigUpdate): Promise<boolean> {
    let succeeded = false;
    const operation = configQueue.then(async () => {
      const current = config();
      if (current === null) {
        throw new Error("A configuração ainda não foi carregada.");
      }
      const response = await updateConfig(current.version, update);
      setConfig(response);
      succeeded = true;
    });
    configQueue = operation.catch(() => undefined);
    setPendingOperations((count) => count + 1);
    try {
      await operation;
      return succeeded;
    } catch (reason) {
      reportError(reason);
      return false;
    } finally {
      setPendingOperations((count) => Math.max(0, count - 1));
    }
  }

  async function refreshRateLimits(): Promise<boolean> {
    try {
      const response = await readRateLimits();
      setRateLimits(response);
      return true;
    } catch (reason) {
      addDiagnostic({ stream: "runtime", message: describeError(reason) });
      return false;
    }
  }

  async function saveClipboard(dataBase64: string): Promise<Attachment | null> {
    try {
      return await savePastedImage(dataBase64);
    } catch (reason) {
      reportError(reason);
      return null;
    }
  }

  async function inspectFiles(paths: readonly string[]): Promise<readonly Attachment[]> {
    try {
      return await inspectAttachments(paths);
    } catch (reason) {
      reportError(reason);
      return [];
    }
  }

  function mergeThread(thread: CodexThread): void {
    setThreads((current) => {
      const index = current.findIndex((entry) => entry.id === thread.id);
      if (index === -1) {
        return [thread, ...current];
      }
      return current.map((entry, entryIndex) => (entryIndex === index ? thread : entry));
    });
  }

  function clearCurrentThread(): void {
    batch(() => {
      setCurrentThread(null);
      setItems([]);
      setActiveTurnId(null);
      setApprovals([]);
    });
  }

  function surfaceRefreshFailure(value: AccountReadResponse): void {
    if (value.refresh.status === "failed") {
      setError(value.refresh.error ?? "A renovação da sessão ChatGPT falhou.");
    }
  }

  function addDiagnostic(diagnostic: RuntimeDiagnostic): void {
    diagnosticSequence += 1;
    const entry: DiagnosticEntry = {
      ...diagnostic,
      id: diagnosticSequence,
      occurredAt: new Date(),
    };
    setDiagnostics((current) => [...current.slice(-(MAX_DIAGNOSTICS - 1)), entry]);
  }

  function reportError(reason: unknown): void {
    const message = describeError(reason);
    setError(message);
    addDiagnostic({ stream: "runtime", message });
  }

  async function withPending<T>(operation: () => Promise<T>): Promise<T> {
    setPendingOperations((count) => count + 1);
    try {
      return await operation();
    } finally {
      setPendingOperations((count) => Math.max(0, count - 1));
    }
  }

  return {
    account,
    activeTurnId,
    approvals,
    busy,
    config,
    currentThread,
    currentThreadTitle,
    diagnostics,
    engine,
    error,
    items,
    loginPending,
    models,
    openingThreadId,
    pendingOperations,
    projects,
    rateLimits,
    runtimeStatus,
    signedIn,
    threads,
    threadsNextCursor,
    turnBusy,
    workspace,
    archiveThread,
    cancelLogin,
    chooseWorkspace,
    clearError: () => setError(null),
    inspectFiles,
    interrupt,
    loadMoreThreads,
    login,
    logout,
    newThread,
    openThread,
    refreshRateLimits,
    removeProject: removeProjectFromSidebar,
    renameThread,
    respondToApproval,
    saveClipboardImage: saveClipboard,
    selectProject,
    sendMessage,
    updateSetting,
  };
}

function activeTurnFromThread(thread: CodexThread): string | null {
  const active = [...thread.turns].reverse().find((turn) => turn.status === "inProgress");
  return active?.id ?? null;
}

function mergeThreadPages(
  current: readonly CodexThread[],
  incoming: readonly CodexThread[],
): readonly CodexThread[] {
  const byId = new Map(current.map((thread) => [thread.id, thread]));
  for (const thread of incoming) {
    byId.set(thread.id, thread);
  }
  return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt);
}

function assertNever(value: never): never {
  throw new Error(`Estado de notificação não tratado: ${JSON.stringify(value)}`);
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(describeError(reason));
}
