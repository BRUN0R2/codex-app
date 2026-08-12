import { confirm, open } from "@tauri-apps/plugin-dialog";
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
  AppProduct,
  ApprovalDecision,
  Attachment,
  ChatGptMode,
  ChatModelOption,
  CodexModel,
  CodexThread,
  ConfigReadResponse,
  ConfigUpdate,
  ContextUsageItem,
  ConversationMode,
  EngineNotification,
  EngineServerRequest,
  EngineStartResponse,
  ModelReroutedNotification,
  ModelSafetyBufferingUpdatedNotification,
  ModelVerification,
  PlanItem,
  ProjectRecord,
  ReasoningEffort,
  RuntimeDiagnostic,
  RuntimeStatus,
  VisibleThreadItem,
} from "../contracts/types";
import {
  archiveThread as archiveThreadCommand,
  cancelLogin as cancelLoginCommand,
  compactThread as compactThreadCommand,
  deleteThread as deleteThreadCommand,
  describeError,
  forkThread as forkThreadCommand,
  inspectAttachments,
  interruptTurn,
  listChatModels,
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
  steerTurn,
  subscribeToEvents,
  unarchiveThread as unarchiveThreadCommand,
  updateConfig,
} from "../infrastructure/codexClient";
import {
  appendAgentText,
  appendReasoningText,
  readLatestTurnFailure,
  upsertItem,
} from "./conversation";
import {
  appendQueuedMessage,
  deleteMessageQueue,
  type MessageQueueMap,
  type QueuedMessage,
  readQueuedMessages,
  takeQueuedMessage as reduceTakeQueuedMessage,
} from "./messageQueue";
import { resolveNewThreadWorkspace } from "./newThreadTarget";
import {
  loadPinnedThreadIds,
  removePinnedThreadId,
  savePinnedThreadIds,
  togglePinnedThreadId,
} from "./pins";
import {
  activeConversationMode,
  defaultProductFlowState,
  loadProductFlowState,
  type ProductFlowState,
  selectChatGptMode as reduceSelectChatGptMode,
  selectProduct as reduceSelectProduct,
  rememberConversationDestination,
  saveProductFlowState,
} from "./productFlow";
import {
  addProject,
  loadProjects,
  pathsEqual,
  removeProject,
  saveProjects,
  updateProject as updateProjectsList,
} from "./projects";
import {
  readActiveTurnPlan,
  isThreadActive as readThreadActive,
  readVisibleThreadTurns,
  deleteThreadRuntime as reduceDeleteThreadRuntime,
  synchronizeThreadRuntime as reduceSynchronizeThreadRuntime,
  updateThreadRuntime as reduceUpdateThreadRuntime,
  type ThreadRuntimeState,
  type VisibleThreadTurn,
} from "./threadRuntime";
import { applyTurnCompletion } from "./turnCompletion";

const MAX_DIAGNOSTICS = 50;
const MAX_PENDING_APPROVALS = 64;
const BOOT_TIMEOUT_MS = 15_000;

export interface DiagnosticEntry extends RuntimeDiagnostic {
  readonly id: number;
  readonly occurredAt: Date;
}

export interface SendMessageInput {
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly model: string | null;
  readonly effort: ReasoningEffort | null;
  readonly serviceTier: string | null;
}

export interface AppController {
  readonly account: Accessor<AccountReadResponse | undefined>;
  readonly activeTurnId: Accessor<string | null>;
  readonly activePlan: Accessor<PlanItem | null>;
  readonly approvals: Accessor<readonly EngineServerRequest[]>;
  readonly archivedThreads: Accessor<readonly CodexThread[]>;
  readonly archivedThreadsNextCursor: Accessor<string | null>;
  readonly busy: Accessor<boolean>;
  readonly config: Accessor<ConfigReadResponse | null>;
  readonly contextUsage: Accessor<ContextUsageItem | null>;
  readonly currentThread: Accessor<CodexThread | null>;
  readonly currentThreadTitle: Accessor<string>;
  readonly product: Accessor<AppProduct>;
  readonly chatGptMode: Accessor<ChatGptMode>;
  readonly chatModels: Accessor<readonly ChatModelOption[]>;
  readonly conversationMode: Accessor<ConversationMode>;
  readonly diagnostics: Accessor<readonly DiagnosticEntry[]>;
  readonly engine: Accessor<EngineStartResponse | null>;
  readonly error: Accessor<string | null>;
  readonly items: Accessor<readonly VisibleThreadItem[]>;
  readonly lastTurnFailure: Accessor<string | null>;
  readonly loginPending: Accessor<boolean>;
  readonly models: Accessor<readonly CodexModel[]>;
  readonly modelReroute: Accessor<ModelReroutedNotification["params"] | null>;
  readonly modelVerifications: Accessor<readonly ModelVerification[]>;
  readonly openingThreadId: Accessor<string | null>;
  readonly pendingOperations: Accessor<number>;
  readonly pinnedThreadIds: Accessor<readonly string[]>;
  readonly projects: Accessor<readonly ProjectRecord[]>;
  readonly queuedMessages: Accessor<readonly QueuedMessage[]>;
  readonly rateLimits: Accessor<AccountRateLimitsResponse | null>;
  readonly runtimeStatus: Accessor<RuntimeStatus>;
  readonly signedIn: Accessor<boolean>;
  readonly safetyBuffering: Accessor<ModelSafetyBufferingUpdatedNotification["params"] | null>;
  readonly threads: Accessor<readonly CodexThread[]>;
  readonly threadsNextCursor: Accessor<string | null>;
  readonly turnBusy: Accessor<boolean>;
  readonly turns: Accessor<readonly VisibleThreadTurn[]>;
  readonly workspace: Accessor<string | null>;
  readonly archiveThread: (threadId: string) => Promise<boolean>;
  readonly cancelLogin: () => Promise<void>;
  readonly chooseWorkspace: () => Promise<string | null>;
  readonly clearError: () => void;
  readonly compactThread: (threadId: string) => Promise<boolean>;
  readonly deleteThread: (threadId: string) => Promise<boolean>;
  readonly deleteQueuedMessage: (messageId: string) => boolean;
  readonly enqueueMessage: (input: SendMessageInput) => boolean;
  readonly forkThread: (threadId: string) => Promise<boolean>;
  readonly inspectFiles: (paths: readonly string[]) => Promise<readonly Attachment[]>;
  readonly interrupt: () => Promise<boolean>;
  readonly isThreadActive: (threadId: string) => boolean;
  readonly loadMoreThreads: () => Promise<boolean>;
  readonly loadMoreArchivedThreads: () => Promise<boolean>;
  readonly login: () => Promise<boolean>;
  readonly logout: () => Promise<boolean>;
  readonly newThread: (workspace?: string) => boolean;
  readonly openThread: (threadId: string) => Promise<boolean>;
  readonly refreshRateLimits: () => Promise<boolean>;
  readonly removeProject: (path: string) => void;
  readonly renameThread: (threadId: string, name: string) => Promise<boolean>;
  readonly retryInitialization: () => void;
  readonly respondToApproval: (requestId: string, decision: ApprovalDecision) => Promise<boolean>;
  readonly saveClipboardImage: (dataBase64: string) => Promise<Attachment | null>;
  readonly selectProject: (path: string) => boolean;
  readonly selectProduct: (product: AppProduct) => Promise<boolean>;
  readonly selectChatGptMode: (mode: ChatGptMode) => Promise<boolean>;
  readonly sendMessage: (input: SendMessageInput) => Promise<boolean>;
  readonly sendQueuedMessageNow: (messageId?: string) => Promise<boolean>;
  readonly takeQueuedMessage: (messageId: string) => QueuedMessage | null;
  readonly togglePinnedThread: (threadId: string) => void;
  readonly updateProject: (
    path: string,
    updates: Partial<Pick<ProjectRecord, "color" | "icon" | "name">>,
  ) => void;
  readonly updateSetting: (update: ConfigUpdate) => Promise<boolean>;
  readonly unarchiveThread: (threadId: string) => Promise<boolean>;
}

export function createAppController(): AppController {
  let initialProductFlow = defaultProductFlowState();
  let productFlowLoadError: Error | null = null;
  try {
    initialProductFlow = loadProductFlowState();
  } catch (reason) {
    productFlowLoadError = asError(reason);
  }
  const [productFlow, setProductFlow] = createSignal<ProductFlowState>(initialProductFlow);
  const [runtimeStatus, setRuntimeStatus] = createSignal<RuntimeStatus>({
    state: "starting",
    message: null,
  });
  const [engine, setEngine] = createSignal<EngineStartResponse | null>(null);
  const [account, setAccount] = createSignal<AccountReadResponse>();
  const [chatModels, setChatModels] = createSignal<readonly ChatModelOption[]>([]);
  const [models, setModels] = createSignal<readonly CodexModel[]>([]);
  const [config, setConfig] = createSignal<ConfigReadResponse | null>(null);
  const [rateLimits, setRateLimits] = createSignal<AccountRateLimitsResponse | null>(null);
  const [threads, setThreads] = createSignal<readonly CodexThread[]>([]);
  const [threadsNextCursor, setThreadsNextCursor] = createSignal<string | null>(null);
  const [archivedThreads, setArchivedThreads] = createSignal<readonly CodexThread[]>([]);
  const [archivedThreadsNextCursor, setArchivedThreadsNextCursor] = createSignal<string | null>(
    null,
  );
  const [currentThread, setCurrentThread] = createSignal<CodexThread | null>(null);
  let initialPinnedThreadIds: readonly string[] = [];
  let pinLoadError: Error | null = null;
  try {
    initialPinnedThreadIds = loadPinnedThreadIds();
  } catch (reason) {
    pinLoadError = asError(reason);
  }
  const [pinnedThreadIds, setPinnedThreadIds] = createSignal(initialPinnedThreadIds);
  const [threadRuntime, setThreadRuntime] = createSignal<ReadonlyMap<string, ThreadRuntimeState>>(
    new Map(),
  );
  const [messageQueues, setMessageQueues] = createSignal<MessageQueueMap>(new Map());
  const [pendingApprovals, setPendingApprovals] = createSignal<readonly EngineServerRequest[]>([]);
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
  const queuedDispatchTails = new Map<string, Promise<void>>();
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
  setWorkspace(
    initialProductFlow.destinations[activeConversationMode(initialProductFlow)].workspace,
  );

  const product = createMemo(() => productFlow().product);
  const chatGptMode = createMemo(() => productFlow().chatGptMode);
  const conversationMode = createMemo(() => activeConversationMode(productFlow()));
  const visibleThreads = createMemo(() =>
    threads().filter((thread) =>
      product() === "codex" ? thread.mode === "codex" : thread.mode !== "codex",
    ),
  );
  const visibleArchivedThreads = createMemo(() =>
    archivedThreads().filter((thread) =>
      product() === "codex" ? thread.mode === "codex" : thread.mode !== "codex",
    ),
  );
  const signedIn = createMemo(() => account()?.account !== null && account() !== undefined);
  const selectedRuntime = createMemo<ThreadRuntimeState | null>(() => {
    const threadId = currentThread()?.id;
    return threadId === undefined ? null : (threadRuntime().get(threadId) ?? null);
  });
  const activeTurnId = createMemo(() => selectedRuntime()?.activeTurnId ?? null);
  const contextUsage = createMemo(() => selectedRuntime()?.contextUsage ?? null);
  const items = createMemo(() => selectedRuntime()?.items ?? []);
  const turns = createMemo<readonly VisibleThreadTurn[]>(() => {
    const thread = currentThread();
    const runtime = selectedRuntime();
    return thread === null
      ? []
      : readVisibleThreadTurns(thread, runtime?.items ?? [], runtime?.activeTurnId ?? null);
  });
  const activePlan = createMemo(() => readActiveTurnPlan(turns(), activeTurnId()));
  const modelReroute = createMemo(() => selectedRuntime()?.modelReroute ?? null);
  const modelVerifications = createMemo(() => selectedRuntime()?.modelVerifications ?? []);
  const safetyBuffering = createMemo(() => selectedRuntime()?.safetyBuffering ?? null);
  const approvals = createMemo(() => {
    const threadId = currentThread()?.id;
    return threadId === undefined
      ? []
      : pendingApprovals().filter((request) => request.params.threadId === threadId);
  });
  const turnBusy = createMemo(() => activeTurnId() !== null);
  const queuedMessages = createMemo<readonly QueuedMessage[]>(() => {
    const threadId = currentThread()?.id;
    return threadId === undefined ? [] : readQueuedMessages(messageQueues(), threadId);
  });
  const busy = createMemo(() => turnBusy() || pendingOperations() > 0);
  const currentThreadTitle = createMemo(() => {
    const thread = currentThread();
    return thread?.name ?? thread?.preview ?? "Nova tarefa";
  });
  const lastTurnFailure = createMemo(() => {
    const thread = currentThread();
    return thread === null ? null : readLatestTurnFailure(thread);
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
    if (productFlowLoadError !== null) {
      reportError(productFlowLoadError);
    }
    if (projectLoadError !== null) {
      reportError(projectLoadError);
    }
    if (pinLoadError !== null) {
      reportError(pinLoadError);
    }
    void initialize();
  });

  onCleanup(() => {
    disposed = true;
    unsubscribe?.();
    unsubscribe = null;
  });

  async function initialize(): Promise<void> {
    unsubscribe?.();
    unsubscribe = null;
    const subscription = subscribeToEvents({
      onContractError: reportError,
      onDiagnostic: addDiagnostic,
      onNotification: handleNotification,
      onServerRequest: handleServerRequest,
      onStatus: handleRuntimeStatus,
    });
    let releaseEvents: (() => void) | null = null;
    try {
      const release = await withBootTimeout("registrar os eventos do engine", () => subscription);
      if (disposed) {
        return;
      }
      releaseEvents = release;
      unsubscribe = release;
      const started = await withBootTimeout("iniciar o engine", () => startEngine());
      if (disposed) {
        return;
      }
      setEngine(started);
      const currentAccount = await withBootTimeout("ler a conta conectada", () => readAccount());
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
        setEngine(null);
        setAccount(undefined);
        setError(message);
        setRuntimeStatus({ state: "failed", message });
      });
    } finally {
      if (releaseEvents === null) {
        void subscription.then((release) => release()).catch(() => {});
      }
    }
  }

  function handleRuntimeStatus(status: RuntimeStatus): void {
    if (runtimeStatus().state === "failed") {
      return;
    }
    setRuntimeStatus(status);
  }

  function retryInitialization(): void {
    batch(() => {
      setEngine(null);
      setAccount(undefined);
      setError(null);
      setRuntimeStatus({ state: "starting", message: null });
    });
    void initialize();
  }

  async function loadAuthenticatedState(): Promise<void> {
    await Promise.all([loadLocalAuthenticatedState(), loadModelCatalog(), loadChatModelCatalog()]);
    if (!disposed) {
      void refreshRateLimits();
    }
  }

  async function loadLocalAuthenticatedState(): Promise<void> {
    const [configuration, threadPage, archivedPage] = await Promise.all([
      readConfig(),
      listThreads(null),
      listThreads(null, true),
    ]);
    if (disposed) {
      return;
    }
    batch(() => {
      setConfig(configuration);
      setThreads(threadPage.data);
      setThreadsNextCursor(threadPage.nextCursor);
      setArchivedThreads(archivedPage.data);
      setArchivedThreadsNextCursor(archivedPage.nextCursor);
    });
    await restoreActiveDestination(productFlow());
  }

  async function loadModelCatalog(): Promise<void> {
    try {
      const catalog = await listModels();
      if (!disposed) {
        setModels(catalog.data.filter((model) => !model.hidden));
      }
    } catch (reason) {
      if (!disposed) {
        reportError(reason);
      }
    }
  }

  async function loadChatModelCatalog(): Promise<void> {
    try {
      const catalog = await listChatModels();
      if (!disposed) {
        setChatModels(catalog.data);
      }
    } catch (reason) {
      if (!disposed) {
        reportError(reason);
      }
    }
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
        synchronizeThreadRuntime(notification.params.thread);
        if (currentThread()?.id === notification.params.thread.id) {
          setCurrentThread(notification.params.thread);
        }
        return;
      case "thread.archived":
        {
          const selected = currentThread();
          if (selected?.id === notification.params.threadId) {
            rememberDestination(selected.mode, null, workspace());
          }
        }
        {
          const archived = threads().find((thread) => thread.id === notification.params.threadId);
          if (archived !== undefined) {
            setArchivedThreads((current) => mergeThreadPages(current, [archived]));
          }
        }
        setThreads((current) =>
          current.filter((thread) => thread.id !== notification.params.threadId),
        );
        if (currentThread()?.id === notification.params.threadId) {
          clearCurrentThread();
        }
        deleteThreadRuntime(notification.params.threadId);
        deleteQueuedMessages(notification.params.threadId);
        setPendingApprovals((current) =>
          current.filter((request) => request.params.threadId !== notification.params.threadId),
        );
        return;
      case "thread.unarchived":
        setArchivedThreads((current) =>
          current.filter((thread) => thread.id !== notification.params.threadId),
        );
        return;
      case "thread.deleted":
        removeDeletedThread(notification.params.threadId);
        return;
      case "turn.started":
        updateThreadRuntime(notification.params.threadId, (runtime) => ({
          ...runtime,
          activeTurnId: notification.params.turn.id,
          modelReroute: null,
          modelVerifications: [],
          moderationMetadata: null,
          safetyBuffering: null,
        }));
        return;
      case "turn.completed":
        {
          let completedActiveTurn = false;
          batch(() => {
            setThreads((current) =>
              current.map((thread) =>
                thread.id === notification.params.threadId
                  ? applyTurnCompletion(thread, notification.params.turn)
                  : thread,
              ),
            );
            setCurrentThread((current) =>
              current?.id === notification.params.threadId
                ? applyTurnCompletion(current, notification.params.turn)
                : current,
            );
            updateThreadRuntime(notification.params.threadId, (runtime) => {
              completedActiveTurn = runtime.activeTurnId === notification.params.turn.id;
              return {
                ...runtime,
                activeTurnId: completedActiveTurn ? null : runtime.activeTurnId,
                safetyBuffering: completedActiveTurn ? null : runtime.safetyBuffering,
              };
            });
            setPendingApprovals((current) =>
              current.filter((request) => request.params.turnId !== notification.params.turn.id),
            );
            if (
              currentThread()?.id === notification.params.threadId &&
              notification.params.error !== null
            ) {
              setError(notification.params.error.message);
            }
          });
          if (completedActiveTurn && notification.params.turn.status === "completed") {
            queueMicrotask(() => {
              void scheduleQueuedMessage(notification.params.threadId);
            });
          }
        }
        return;
      case "model.rerouted":
        updateThreadRuntime(notification.params.threadId, (runtime) => ({
          ...runtime,
          modelReroute: notification.params,
        }));
        return;
      case "model.verification":
        updateThreadRuntime(notification.params.threadId, (runtime) => ({
          ...runtime,
          modelVerifications: notification.params.verifications,
        }));
        return;
      case "turn.moderationMetadata":
        updateThreadRuntime(notification.params.threadId, (runtime) => ({
          ...runtime,
          moderationMetadata: notification.params.metadata,
        }));
        return;
      case "model.safetyBufferingUpdated":
        updateThreadRuntime(notification.params.threadId, (runtime) => ({
          ...runtime,
          safetyBuffering: notification.params,
        }));
        return;
      case "item.started":
      case "item.completed":
        updateThreadRuntime(notification.params.threadId, (runtime) => {
          const item = notification.params.item;
          if (item.type === "contextUsage") {
            return { ...runtime, contextUsage: item };
          }
          return {
            ...runtime,
            contextUsage: item.type === "contextCompaction" ? null : runtime.contextUsage,
            items: upsertItem(runtime.items, item),
          };
        });
        return;
      case "item.agentTextDelta":
        updateThreadRuntime(notification.params.threadId, (runtime) => ({
          ...runtime,
          items: appendAgentText(
            runtime.items,
            notification.params.itemId,
            notification.params.delta,
          ),
        }));
        return;
      case "item.reasoningSummaryDelta":
        updateThreadRuntime(notification.params.threadId, (runtime) => ({
          ...runtime,
          items: appendReasoningText(
            runtime.items,
            notification.params.itemId,
            notification.params.index,
            notification.params.delta,
            "summary",
          ),
        }));
        return;
      case "item.reasoningTextDelta":
        updateThreadRuntime(notification.params.threadId, (runtime) => ({
          ...runtime,
          items: appendReasoningText(
            runtime.items,
            notification.params.itemId,
            notification.params.index,
            notification.params.delta,
            "content",
          ),
        }));
        return;
      default:
        assertNever(notification);
    }
  }

  function handleServerRequest(request: EngineServerRequest): void {
    setPendingApprovals((current) => {
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
        setChatModels([]);
        setModels([]);
        setRateLimits(null);
        setThreads([]);
        setThreadsNextCursor(null);
        setArchivedThreads([]);
        setArchivedThreadsNextCursor(null);
        setThreadRuntime(new Map());
        setMessageQueues(new Map());
        setPendingApprovals([]);
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
    if (conversationMode() === "chat") {
      setError("O Chat usa conversas sem acesso a projetos locais. Troque para Work ou Codex.");
      return null;
    }
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

  function commitProductFlow(next: ProductFlowState): boolean {
    if (next === productFlow()) {
      return true;
    }
    try {
      saveProductFlowState(next);
      setProductFlow(next);
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  function rememberDestination(
    mode: ConversationMode,
    threadId: string | null,
    targetWorkspace: string | null,
  ): boolean {
    return commitProductFlow(
      rememberConversationDestination(productFlow(), mode, {
        threadId,
        workspace: targetWorkspace,
      }),
    );
  }

  async function selectProduct(nextProduct: AppProduct): Promise<boolean> {
    const current = productFlow();
    if (current.product === nextProduct) {
      return true;
    }
    const withCurrentDestination = rememberConversationDestination(
      current,
      activeConversationMode(current),
      {
        threadId: currentThread()?.id ?? null,
        workspace: workspace(),
      },
    );
    const next = reduceSelectProduct(withCurrentDestination, nextProduct);
    if (!commitProductFlow(next)) {
      return false;
    }
    return restoreActiveDestination(next);
  }

  async function selectChatGptMode(nextMode: ChatGptMode): Promise<boolean> {
    const current = productFlow();
    if (current.product === "chatgpt" && current.chatGptMode === nextMode) {
      return true;
    }
    const withCurrentDestination = rememberConversationDestination(
      current,
      activeConversationMode(current),
      {
        threadId: currentThread()?.id ?? null,
        workspace: workspace(),
      },
    );
    const next = reduceSelectChatGptMode(withCurrentDestination, nextMode);
    if (!commitProductFlow(next)) {
      return false;
    }
    return restoreActiveDestination(next);
  }

  async function restoreActiveDestination(expected: ProductFlowState): Promise<boolean> {
    const mode = activeConversationMode(expected);
    const destination = expected.destinations[mode];
    batch(() => {
      clearCurrentThread();
      setWorkspace(mode === "chat" ? null : destination.workspace);
    });
    if (destination.threadId === null) {
      return true;
    }
    try {
      const response = await withPending(() => resumeThread(destination.threadId as string));
      if (conversationMode() !== mode) {
        return true;
      }
      if (response.thread.mode !== mode) {
        throw new Error("A conversa restaurada pertence a outro modo do aplicativo.");
      }
      if (!selectThreadProject(response.thread)) {
        return false;
      }
      batch(() => {
        synchronizeThreadRuntime(response.thread);
        setCurrentThread(response.thread);
      });
      mergeThread(response.thread);
      rememberDestination(mode, response.thread.id, response.thread.projectPath);
      return true;
    } catch (reason) {
      if (conversationMode() === mode) {
        rememberDestination(mode, null, destination.workspace);
        reportError(reason);
      }
      return false;
    }
  }

  function alignProductFlowToThread(mode: ConversationMode): boolean {
    const current = productFlow();
    if (mode === "codex") {
      return current.product === "codex";
    }
    if (current.product !== "chatgpt") {
      return false;
    }
    if (current.chatGptMode === mode) {
      return true;
    }
    const withCurrentDestination = rememberConversationDestination(
      current,
      activeConversationMode(current),
      {
        threadId: currentThread()?.id ?? null,
        workspace: workspace(),
      },
    );
    return commitProductFlow(reduceSelectChatGptMode(withCurrentDestination, mode));
  }

  function selectProject(path: string): boolean {
    if (conversationMode() === "chat") {
      setError("O Chat não associa conversas a projetos locais.");
      return false;
    }
    const thread = currentThread();
    try {
      const next = addProject(projects(), path);
      saveProjects(next);
      const changesConversation = thread !== null && !pathsEqual(thread.projectPath, path);
      batch(() => {
        setProjects(next);
        setWorkspace(path);
        if (changesConversation) {
          clearCurrentThread();
        }
      });
      return rememberDestination(
        conversationMode(),
        changesConversation ? null : (thread?.id ?? null),
        path,
      );
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

  function togglePinnedThread(threadId: string): void {
    if (!threads().some((thread) => thread.id === threadId)) {
      setError("A tarefa precisa estar disponível antes de ser fixada.");
      return;
    }
    try {
      const next = togglePinnedThreadId(pinnedThreadIds(), threadId);
      savePinnedThreadIds(next);
      setPinnedThreadIds(next);
    } catch (reason) {
      reportError(reason);
    }
  }

  function removePinnedThread(threadId: string): void {
    const next = removePinnedThreadId(pinnedThreadIds(), threadId);
    if (next.length === pinnedThreadIds().length) {
      return;
    }
    try {
      savePinnedThreadIds(next);
      setPinnedThreadIds(next);
    } catch (reason) {
      reportError(reason);
    }
  }

  function newThread(targetWorkspace?: string): boolean {
    const mode = conversationMode();
    const requestedWorkspace = mode === "chat" ? null : resolveNewThreadWorkspace(targetWorkspace);
    if (requestedWorkspace === null) {
      batch(() => {
        setWorkspace(null);
        clearCurrentThread();
      });
      return rememberDestination(mode, null, null);
    }
    if (!selectProject(requestedWorkspace)) {
      return false;
    }
    clearCurrentThread();
    return rememberDestination(mode, null, requestedWorkspace);
  }

  function selectThreadProject(thread: CodexThread): boolean {
    if (thread.projectPath === null) {
      setWorkspace(null);
      return true;
    }
    try {
      const next = addProject(projects(), thread.projectPath);
      saveProjects(next);
      batch(() => {
        setProjects(next);
        setWorkspace(thread.projectPath);
      });
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  async function materializeThread(
    projectPath: string | null,
    mode: ConversationMode,
  ): Promise<CodexThread | null> {
    try {
      const response = await withPending(() => startThread(projectPath, mode));
      if (response.thread.mode !== mode) {
        throw new Error("O engine criou a conversa em um modo diferente do solicitado.");
      }
      if (!pathsEqual(response.thread.projectPath, projectPath)) {
        throw new Error("O engine criou a tarefa com uma associação de projeto diferente.");
      }
      if (
        response.thread.projectPath !== null &&
        !pathsEqual(response.thread.cwd, response.thread.projectPath)
      ) {
        throw new Error("O diretório de execução da tarefa diverge do projeto associado.");
      }
      if (!selectThreadProject(response.thread)) {
        return null;
      }
      batch(() => {
        mergeThread(response.thread);
        setCurrentThread(response.thread);
        synchronizeThreadRuntime(response.thread);
      });
      rememberDestination(mode, response.thread.id, response.thread.projectPath);
      return response.thread;
    } catch (reason) {
      reportError(reason);
      return null;
    }
  }

  async function openThread(threadId: string): Promise<boolean> {
    setOpeningThreadId(threadId);
    try {
      const response = await resumeThread(threadId);
      if (!pathsEqual(response.cwd, response.thread.cwd)) {
        throw new Error("O engine retomou a tarefa em um diretório inconsistente.");
      }
      if (!alignProductFlowToThread(response.thread.mode)) {
        throw new Error("A conversa selecionada pertence a outro produto do aplicativo.");
      }
      if (!selectThreadProject(response.thread)) {
        return false;
      }
      batch(() => {
        synchronizeThreadRuntime(response.thread);
        setCurrentThread(response.thread);
      });
      mergeThread(response.thread);
      rememberDestination(response.thread.mode, response.thread.id, response.thread.projectPath);
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

  async function unarchiveThread(threadId: string): Promise<boolean> {
    try {
      const response = await withPending(() => unarchiveThreadCommand(threadId));
      mergeThread(response.thread);
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  function isThreadActive(threadId: string): boolean {
    const thread = [...threads(), ...archivedThreads()].find((entry) => entry.id === threadId);
    return thread !== undefined && readThreadActive(thread, threadRuntime().get(threadId));
  }

  async function deleteThread(threadId: string): Promise<boolean> {
    const thread = [...threads(), ...archivedThreads()].find((entry) => entry.id === threadId);
    if (thread === undefined) {
      setError("A tarefa que seria excluída não está mais disponível.");
      return false;
    }
    try {
      const title = thread.name ?? thread.preview ?? "Nova tarefa";
      const description = isThreadActive(threadId)
        ? `A tarefa “${title}” está ativa. O turno em andamento será interrompido e todo o histórico será excluído permanentemente.`
        : `A tarefa “${title}” e todo o histórico serão excluídos permanentemente.`;
      const confirmed = await confirm(description, {
        cancelLabel: "Cancelar",
        kind: "warning",
        okLabel: "Excluir",
        title: "Excluir tarefa?",
      });
      if (!confirmed) {
        return false;
      }
      await withPending(() => deleteThreadCommand(threadId));
      removeDeletedThread(threadId);
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  async function compactThread(threadId: string): Promise<boolean> {
    try {
      await withPending(() => compactThreadCommand(threadId));
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  async function forkThread(threadId: string): Promise<boolean> {
    try {
      const response = await withPending(() => forkThreadCommand(threadId));
      if (!selectThreadProject(response.thread)) {
        return false;
      }
      batch(() => {
        mergeThread(response.thread);
        synchronizeThreadRuntime(response.thread);
        setCurrentThread(response.thread);
      });
      rememberDestination(response.thread.mode, response.thread.id, response.thread.projectPath);
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

  async function loadMoreArchivedThreads(): Promise<boolean> {
    const cursor = archivedThreadsNextCursor();
    if (cursor === null) {
      return false;
    }
    try {
      const page = await withPending(() => listThreads(cursor, true));
      batch(() => {
        setArchivedThreads((current) => mergeThreadPages(current, page.data));
        setArchivedThreadsNextCursor(page.nextCursor);
      });
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  async function sendMessage(input: SendMessageInput): Promise<boolean> {
    if (input.text.trim().length === 0 && input.attachments.length === 0) {
      return false;
    }
    const runningTurnId = activeTurnId();
    if (runningTurnId !== null) {
      const thread = currentThread();
      if (thread === null) {
        setError("O turno ativo não está associado a uma tarefa aberta.");
        return false;
      }
      try {
        await steerTurn({
          threadId: thread.id,
          expectedTurnId: runningTurnId,
          clientUserMessageId: crypto.randomUUID(),
          text: input.text,
          attachments: input.attachments.map((attachment) => ({ path: attachment.path })),
        });
        return true;
      } catch (reason) {
        reportError(reason);
        return false;
      }
    }
    let thread = currentThread();
    if (thread === null) {
      const mode = conversationMode();
      thread = await materializeThread(mode === "chat" ? null : workspace(), mode);
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
        serviceTier: input.serviceTier,
      });
      updateThreadRuntime(thread.id, (runtime) => ({
        ...runtime,
        activeTurnId: response.turn.id,
      }));
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  function enqueueMessage(input: SendMessageInput): boolean {
    if (input.text.trim().length === 0 && input.attachments.length === 0) {
      return false;
    }
    const thread = currentThread();
    if (thread === null) {
      setError("Abra uma tarefa antes de adicionar mensagens à fila.");
      return false;
    }
    const message: QueuedMessage = {
      id: crypto.randomUUID(),
      text: input.text,
      attachments: [...input.attachments],
      model: input.model,
      effort: input.effort,
      serviceTier: input.serviceTier,
    };
    try {
      setMessageQueues((current) => appendQueuedMessage(current, thread.id, message));
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  function takeQueuedMessage(messageId: string): QueuedMessage | null {
    const threadId = currentThread()?.id;
    if (threadId === undefined) {
      return null;
    }
    let taken: QueuedMessage | null = null;
    setMessageQueues((current) => {
      const result = reduceTakeQueuedMessage(current, threadId, messageId);
      taken = result.message;
      return result.queues;
    });
    return taken;
  }

  function deleteQueuedMessage(messageId: string): boolean {
    return takeQueuedMessage(messageId) !== null;
  }

  function sendQueuedMessageNow(messageId?: string): Promise<boolean> {
    const threadId = currentThread()?.id;
    return threadId === undefined
      ? Promise.resolve(false)
      : scheduleQueuedMessage(threadId, messageId);
  }

  function scheduleQueuedMessage(threadId: string, messageId?: string): Promise<boolean> {
    const previous = queuedDispatchTails.get(threadId) ?? Promise.resolve();
    const operation = previous.then(() => dispatchQueuedMessage(threadId, messageId));
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    queuedDispatchTails.set(threadId, tail);
    void tail.then(() => {
      if (queuedDispatchTails.get(threadId) === tail) {
        queuedDispatchTails.delete(threadId);
      }
    });
    return operation;
  }

  async function dispatchQueuedMessage(threadId: string, messageId?: string): Promise<boolean> {
    const queue = readQueuedMessages(messageQueues(), threadId);
    const message =
      messageId === undefined ? queue.at(0) : queue.find((entry) => entry.id === messageId);
    if (message === undefined) {
      return false;
    }
    try {
      const runningTurnId = threadRuntime().get(threadId)?.activeTurnId ?? null;
      if (runningTurnId === null) {
        const response = await startTurn({
          threadId,
          clientUserMessageId: message.id,
          text: message.text,
          attachments: message.attachments.map((attachment) => ({ path: attachment.path })),
          model: message.model,
          effort: message.effort,
          serviceTier: message.serviceTier,
        });
        updateThreadRuntime(threadId, (runtime) => ({
          ...runtime,
          activeTurnId: response.turn.id,
        }));
      } else {
        await steerTurn({
          threadId,
          expectedTurnId: runningTurnId,
          clientUserMessageId: message.id,
          text: message.text,
          attachments: message.attachments.map((attachment) => ({ path: attachment.path })),
        });
      }
      setMessageQueues((current) => reduceTakeQueuedMessage(current, threadId, message.id).queues);
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
      setPendingApprovals((current) => current.filter((request) => request.id !== requestId));
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

  function updateThreadRuntime(
    threadId: string,
    update: (current: ThreadRuntimeState) => ThreadRuntimeState,
  ): void {
    setThreadRuntime((current) => reduceUpdateThreadRuntime(current, threadId, update));
  }

  function synchronizeThreadRuntime(thread: CodexThread): void {
    setThreadRuntime((current) => reduceSynchronizeThreadRuntime(current, thread));
  }

  function deleteThreadRuntime(threadId: string): void {
    setThreadRuntime((current) => reduceDeleteThreadRuntime(current, threadId));
  }

  function removeDeletedThread(threadId: string): void {
    const selected = currentThread();
    batch(() => {
      setThreads((current) => current.filter((thread) => thread.id !== threadId));
      setArchivedThreads((current) => current.filter((thread) => thread.id !== threadId));
      if (currentThread()?.id === threadId) {
        clearCurrentThread();
      }
      deleteThreadRuntime(threadId);
      deleteQueuedMessages(threadId);
      setPendingApprovals((current) =>
        current.filter((request) => request.params.threadId !== threadId),
      );
      removePinnedThread(threadId);
    });
    if (selected?.id === threadId) {
      rememberDestination(selected.mode, null, workspace());
    }
  }

  function deleteQueuedMessages(threadId: string): void {
    setMessageQueues((current) => deleteMessageQueue(current, threadId));
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
    setCurrentThread(null);
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

  function updateProject(
    path: string,
    updates: Partial<Pick<ProjectRecord, "color" | "icon" | "name">>,
  ): void {
    setProjects((current) => {
      const next = updateProjectsList(current, path, updates);
      saveProjects(next);
      return next;
    });
  }

  return {
    account,
    activePlan,
    activeTurnId,
    approvals,
    archivedThreads: visibleArchivedThreads,
    archivedThreadsNextCursor,
    busy,
    config,
    contextUsage,
    currentThread,
    currentThreadTitle,
    product,
    chatGptMode,
    chatModels,
    conversationMode,
    diagnostics,
    engine,
    error,
    items,
    lastTurnFailure,
    loginPending,
    models,
    modelReroute,
    modelVerifications,
    openingThreadId,
    pendingOperations,
    pinnedThreadIds,
    projects,
    queuedMessages,
    rateLimits,
    runtimeStatus,
    signedIn,
    safetyBuffering,
    threads: visibleThreads,
    threadsNextCursor,
    turnBusy,
    turns,
    workspace,
    archiveThread,
    cancelLogin,
    chooseWorkspace,
    clearError: () => setError(null),
    compactThread,
    deleteThread,
    deleteQueuedMessage,
    enqueueMessage,
    forkThread,
    inspectFiles,
    interrupt,
    isThreadActive,
    loadMoreThreads,
    loadMoreArchivedThreads,
    login,
    logout,
    newThread,
    openThread,
    refreshRateLimits,
    removeProject: removeProjectFromSidebar,
    renameThread,
    retryInitialization,
    respondToApproval,
    saveClipboardImage: saveClipboard,
    selectProject,
    selectProduct,
    selectChatGptMode,
    sendMessage,
    sendQueuedMessageNow,
    takeQueuedMessage,
    togglePinnedThread,
    updateProject,
    updateSetting,
    unarchiveThread,
  };
}

function withBootTimeout<T>(label: string, operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `O engine não respondeu em ${BOOT_TIMEOUT_MS / 1000} segundos ao ${label}. Tente novamente.`,
        ),
      );
    }, BOOT_TIMEOUT_MS);
  });
  return Promise.race([operation(), timeout]).finally(() => clearTimeout(timer));
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
