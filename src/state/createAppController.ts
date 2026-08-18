import { confirm, open } from "@tauri-apps/plugin-dialog";
import { batch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import type {
  AccountProfileResponse,
  AccountRateLimitsResponse,
  AccountReadResponse,
  AppProduct,
  ApprovalDecision,
  Attachment,
  Automation,
  AutomationInput,
  AutomationRun,
  ChatGptMode,
  ChatModelOption,
  CodexModel,
  CodexThread,
  ConfigReadResponse,
  ConfigUpdate,
  ConversationMode,
  EngineNotification,
  EngineServerRequest,
  EngineStartResponse,
  ProjectRecord,
  RuntimeDiagnostic,
  RuntimeStatus,
  ThreadSummary,
} from "../contracts/types";
import {
  archiveThread as archiveThreadCommand,
  cancelLogin as cancelLoginCommand,
  compactThread as compactThreadCommand,
  createAutomation as createAutomationCommand,
  deleteAutomation as deleteAutomationCommand,
  deleteThread as deleteThreadCommand,
  describeDiagnosticError,
  describeError,
  forkThread as forkThreadCommand,
  inspectAttachments,
  interruptTurn,
  listAutomations,
  listChatModels,
  listModels,
  listThreads,
  loginWithChatGpt,
  logout as logoutCommand,
  markAutomationRunReviewed as markAutomationRunReviewedCommand,
  openExternalUrl,
  readAccount,
  readAccountProfile,
  readRateLimits,
  readThread,
  reportFrontendDiagnostic,
  respondToServerRequest,
  resumeThread,
  runAutomationNow as runAutomationNowCommand,
  savePastedImage,
  setThreadName,
  startEngine,
  startThread,
  startTurn,
  steerTurn,
  subscribeToEvents,
  unarchiveThread as unarchiveThreadCommand,
  updateAutomation as updateAutomationCommand,
  updateConfig,
} from "../infrastructure/codexClient";
import { createAccountProfileRefreshCoordinator } from "./accountProfileRefresh";
import type { AppController, DiagnosticEntry, SendMessageInput } from "./appController";
import {
  unreadAutomationRuns as readUnreadAutomationRuns,
  removeAutomation,
  removeAutomationRuns,
  replaceAutomationRuns,
  replaceAutomations,
  upsertAutomation,
  upsertAutomationRun,
} from "./automations";
import { readLatestTurnFailure, upsertItem } from "./conversation";
import {
  type InitializationStage,
  InitializationTimeoutError,
  initializationRetryDelay,
  isRetryableInitializationFailure,
} from "./initializationRetry";
import {
  appendQueuedMessage,
  clearPersistedMessageQueues,
  deleteMessageQueue,
  loadMessageQueues,
  type MessageQueueMap,
  type QueuedMessage,
  readQueuedMessages,
  takeQueuedMessage as reduceTakeQueuedMessage,
  saveMessageQueue,
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
  loadPinnedProjectPaths,
  removePinnedProjectPath,
  savePinnedProjectPaths,
  togglePinnedProjectPath,
} from "./projectPins";
import {
  defaultProjectSidebarState,
  loadProjectSidebarState,
  type ProjectSidebarState,
  projectExpanded as readProjectExpanded,
  projectThreadListExpanded as readProjectThreadListExpanded,
  removeProjectSidebarState,
  saveProjectSidebarState,
  toggleProjectSectionExpanded,
  toggleProjectExpanded as toggleStoredProjectExpanded,
  toggleProjectThreadListExpanded as toggleStoredProjectThreadListExpanded,
} from "./projectSidebarState";
import {
  addProject,
  loadProjects,
  pathsEqual,
  removeProject,
  saveProjects,
  updateProject as updateProjectsList,
} from "./projects";
import {
  createBrowserRateLimitRefreshHost,
  createRateLimitRefreshCoordinator,
} from "./rateLimitRefresh";
import {
  createBrowserStreamDeltaScheduler,
  createStreamDeltaBatcher,
  type StreamDelta,
} from "./streamDeltas";
import { applyThreadSummary, prependThreadHistory } from "./threadHistory";
import { cachedThreadMatchesSummary, ThreadPageCache } from "./threadPageCache";
import {
  applyThreadRuntimeStreamDeltas,
  mergeRuntimeThreadItems,
  readActiveTurnPlan,
  readPersistedVisibleTurns,
  isThreadActive as readThreadActive,
  deleteThreadRuntime as reduceDeleteThreadRuntime,
  synchronizeThreadRuntime as reduceSynchronizeThreadRuntime,
  updateThreadRuntime as reduceUpdateThreadRuntime,
  type ThreadRuntimeState,
} from "./threadRuntime";
import {
  applySummaryTurnCompletion,
  applySummaryTurnStarted,
  applyTurnCompletion,
  applyTurnItem,
  applyTurnStarted,
} from "./turnCompletion";
import type { VisibleThreadTurn, VisibleTurnSequence } from "./visibleTurnSequence";

const MAX_DIAGNOSTICS = 50;
const EVENT_SUBSCRIPTION_TIMEOUT_MS = 15_000;
const ENGINE_START_TIMEOUT_MS = 120_000;
const ACCOUNT_READ_TIMEOUT_MS = 45_000;
const THREAD_PAGE_CACHE_CAPACITY = 8;

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
  const [rateLimitsError, setRateLimitsError] = createSignal<string | null>(null);
  const [rateLimitsLoading, setRateLimitsLoading] = createSignal(false);
  const [threads, setThreads] = createSignal<readonly ThreadSummary[]>([]);
  const [threadsNextCursor, setThreadsNextCursor] = createSignal<string | null>(null);
  const [archivedThreads, setArchivedThreads] = createSignal<readonly ThreadSummary[]>([]);
  const [archivedThreadsLoaded, setArchivedThreadsLoaded] = createSignal(false);
  const [archivedThreadsLoading, setArchivedThreadsLoading] = createSignal(false);
  const [archivedThreadsNextCursor, setArchivedThreadsNextCursor] = createSignal<string | null>(
    null,
  );
  const [automations, setAutomations] = createSignal<readonly Automation[]>([]);
  const [automationRuns, setAutomationRuns] = createSignal<readonly AutomationRun[]>([]);
  const [automationsLoading, setAutomationsLoading] = createSignal(false);
  const [currentThread, setCurrentThread] = createSignal<CodexThread | null>(null);
  const [historyCursor, setHistoryCursor] = createSignal<string | null>(null);
  const [historyLoading, setHistoryLoading] = createSignal(false);
  const threadPages = new ThreadPageCache(THREAD_PAGE_CACHE_CAPACITY);
  let initialPinnedThreadIds: readonly string[] = [];
  let pinLoadError: Error | null = null;
  try {
    initialPinnedThreadIds = loadPinnedThreadIds();
  } catch (reason) {
    pinLoadError = asError(reason);
  }
  const [pinnedThreadIds, setPinnedThreadIds] = createSignal(initialPinnedThreadIds);
  let initialPinnedProjectPaths: readonly string[] = [];
  let projectPinLoadError: Error | null = null;
  try {
    initialPinnedProjectPaths = loadPinnedProjectPaths();
  } catch (reason) {
    projectPinLoadError = asError(reason);
  }
  const [pinnedProjectPaths, setPinnedProjectPaths] = createSignal(initialPinnedProjectPaths);
  const [threadRuntime, setThreadRuntime] = createSignal<ReadonlyMap<string, ThreadRuntimeState>>(
    new Map(),
  );
  const streamDeltas = createStreamDeltaBatcher({
    apply: (deltas) =>
      setThreadRuntime((current) => applyThreadRuntimeStreamDeltas(current, deltas)),
    reportError,
    scheduler: createBrowserStreamDeltaScheduler(),
  });
  let initialMessageQueues: MessageQueueMap = new Map();
  let messageQueueLoadWarnings: readonly string[] = [];
  try {
    const loaded = loadMessageQueues();
    initialMessageQueues = loaded.queues;
    messageQueueLoadWarnings = loaded.warnings;
  } catch (reason) {
    messageQueueLoadWarnings = [asError(reason).message];
  }
  const [messageQueues, setMessageQueues] = createSignal<MessageQueueMap>(initialMessageQueues);
  const [pendingApprovals, setPendingApprovals] = createSignal<readonly EngineServerRequest[]>([]);
  const [diagnostics, setDiagnostics] = createSignal<readonly DiagnosticEntry[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [pendingOperations, setPendingOperations] = createSignal(0);
  let pendingThreadSelectionId: string | null = null;
  let threadSelectionRevision = 0;
  const [loginPending, setLoginPending] = createSignal(false);
  const [workspace, setWorkspace] = createSignal<string | null>(null);
  let loginId: string | null = null;
  let diagnosticSequence = 0;
  let pendingRateLimitReads = 0;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let initializationRevision = 0;
  let initializationRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let configQueue: Promise<void> = Promise.resolve();
  const queuedDispatchTails = new Map<string, Promise<void>>();
  let authenticationSync: {
    readonly expectedSignedIn: boolean;
    readonly promise: Promise<void>;
  } | null = null;
  let authenticatedStateLoaded = false;
  let authenticatedStateRequest: Promise<void> | null = null;
  let persistedQueuesResumed = false;
  let modelCatalogLoaded = false;
  let chatModelCatalogLoaded = false;
  let modelCatalogRequest: Promise<boolean> | null = null;
  let chatModelCatalogRequest: Promise<boolean> | null = null;
  let modelCatalogSessionRevision = 0;
  let initialProjects: readonly ProjectRecord[] = [];
  let projectLoadError: Error | null = null;
  try {
    initialProjects = loadProjects();
  } catch (reason) {
    projectLoadError = asError(reason);
  }
  const [projects, setProjects] = createSignal(initialProjects);
  let initialProjectSidebarState = defaultProjectSidebarState();
  let projectSidebarStateLoadError: Error | null = null;
  try {
    initialProjectSidebarState = loadProjectSidebarState();
  } catch (reason) {
    projectSidebarStateLoadError = asError(reason);
  }
  const [projectSidebarState, setProjectSidebarState] = createSignal<ProjectSidebarState>(
    initialProjectSidebarState,
  );
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
  const hasOlderHistory = createMemo(() => historyCursor() !== null);
  const rateLimitRefresh = createRateLimitRefreshCoordinator({
    getSessionKey: () => (signedIn() ? "chatgpt" : null),
    read: readRateLimitsWithStatus,
    apply: (value) => {
      setRateLimits(value);
      setRateLimitsError(null);
    },
    reportError: (reason) => {
      setRateLimitsError(describeError(reason));
      addDiagnostic({ stream: "runtime", message: describeError(reason) });
    },
    host: createBrowserRateLimitRefreshHost(),
  });

  async function readRateLimitsWithStatus(): Promise<AccountRateLimitsResponse> {
    pendingRateLimitReads += 1;
    batch(() => {
      setRateLimitsLoading(true);
      setRateLimitsError(null);
    });
    try {
      return await readRateLimits();
    } finally {
      pendingRateLimitReads = Math.max(0, pendingRateLimitReads - 1);
      setRateLimitsLoading(pendingRateLimitReads > 0);
    }
  }

  const accountProfileRefresh = createAccountProfileRefreshCoordinator({
    getSessionKey: () => (signedIn() ? "chatgpt" : null),
    read: readAccountProfile,
    apply: (profile: AccountProfileResponse) => {
      setAccount((current) => {
        if (current?.account === null || current?.account === undefined) {
          return current;
        }
        return {
          ...current,
          account: {
            ...current.account,
            name: profile.name ?? current.account.name,
            picture: profile.picture ?? current.account.picture,
          },
        };
      });
    },
    reportError: (reason) => {
      addDiagnostic({ stream: "runtime", message: describeError(reason) });
    },
  });
  const selectedRuntime = createMemo<ThreadRuntimeState | null>(() => {
    const threadId = currentThread()?.id;
    return threadId === undefined ? null : (threadRuntime().get(threadId) ?? null);
  });
  const activeTurnId = createMemo(() => selectedRuntime()?.activeTurnId ?? null);
  const contextUsage = createMemo(() => selectedRuntime()?.contextUsage ?? null);
  const persistedTurns = createMemo<readonly VisibleThreadTurn[]>(() => {
    const thread = currentThread();
    return thread === null ? [] : readPersistedVisibleTurns(thread);
  });
  const turns = createMemo<VisibleTurnSequence>(() => {
    const thread = currentThread();
    const runtime = selectedRuntime();
    return thread === null
      ? []
      : mergeRuntimeThreadItems(
          thread,
          persistedTurns(),
          runtime?.itemOverlays ?? [],
          runtime?.activeTurnId ?? null,
        );
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
  const unreadAutomationRuns = createMemo(() => readUnreadAutomationRuns(automationRuns()));
  const projectSectionExpanded = createMemo(() => projectSidebarState().projectsExpanded);
  const currentThreadTitle = createMemo(() => {
    const thread = currentThread();
    return thread?.name ?? thread?.preview ?? "Nova tarefa";
  });
  const lastTurnFailure = createMemo(() => {
    const thread = currentThread();
    return thread === null ? null : readLatestTurnFailure(thread);
  });

  createEffect(() => {
    const thread = currentThread();
    const nextCursor = historyCursor();
    if (thread !== null) {
      threadPages.write({ thread, nextCursor });
    }
  });

  createEffect(() => {
    const mode = conversationMode();
    if (signedIn()) {
      void ensureModelsForMode(mode);
    }
  });

  onMount(() => {
    rateLimitRefresh.start();
    if (productFlowLoadError !== null) {
      reportError(productFlowLoadError);
    }
    if (projectLoadError !== null) {
      reportError(projectLoadError);
    }
    if (projectSidebarStateLoadError !== null) {
      reportError(projectSidebarStateLoadError);
    }
    if (pinLoadError !== null) {
      reportError(pinLoadError);
    }
    if (projectPinLoadError !== null) {
      reportError(projectPinLoadError);
    }
    for (const warning of messageQueueLoadWarnings) {
      reportError(new Error(warning));
    }
    beginInitialization();
  });

  onCleanup(() => {
    disposed = true;
    initializationRevision += 1;
    if (initializationRetryTimer !== null) {
      clearTimeout(initializationRetryTimer);
      initializationRetryTimer = null;
    }
    accountProfileRefresh.dispose();
    rateLimitRefresh.dispose();
    streamDeltas.dispose();
    unsubscribe?.();
    unsubscribe = null;
  });

  function beginInitialization(): void {
    if (disposed) {
      return;
    }
    if (initializationRetryTimer !== null) {
      clearTimeout(initializationRetryTimer);
      initializationRetryTimer = null;
    }
    const revision = ++initializationRevision;
    void initialize(revision, 0);
  }

  async function initialize(revision: number, attempt: number): Promise<void> {
    if (!isCurrentInitialization(revision)) {
      return;
    }
    unsubscribe?.();
    unsubscribe = null;
    let stage: InitializationStage = "events";
    const subscription = subscribeToEvents({
      onContractError: reportError,
      onDiagnostic: addDiagnostic,
      onNotification: handleNotification,
      onServerRequest: handleServerRequest,
      onStatus: handleRuntimeStatus,
    });
    let releaseEvents: (() => void) | null = null;
    try {
      const release = await withBootTimeout(
        "registrar os eventos do engine",
        EVENT_SUBSCRIPTION_TIMEOUT_MS,
        () => subscription,
      );
      if (!isCurrentInitialization(revision)) {
        release();
        releaseEvents = release;
        return;
      }
      releaseEvents = release;
      unsubscribe = release;
      stage = "engine";
      const started = await withBootTimeout("iniciar o engine", ENGINE_START_TIMEOUT_MS, () =>
        startEngine(),
      );
      if (!isCurrentInitialization(revision)) {
        return;
      }
      batch(() => {
        setEngine(started);
        setConfig(started.config);
        setRuntimeStatus({ state: "ready", message: null });
      });
      stage = "account";
      const currentAccount = await withBootTimeout(
        "ler a conta conectada",
        ACCOUNT_READ_TIMEOUT_MS,
        () => readAccount(),
      );
      if (!isCurrentInitialization(revision)) {
        return;
      }
      accountProfileRefresh.invalidateSession();
      rateLimitRefresh.invalidateSession();
      if (accountSessionKey(account()) !== accountSessionKey(currentAccount)) {
        invalidateAuthenticatedStateLoad();
        invalidateModelCatalogs();
      }
      setAccount(currentAccount);
      surfaceRefreshFailure(currentAccount);
      if (currentAccount.account !== null) {
        void accountProfileRefresh.refreshIfStale();
        stage = "authenticatedState";
        await loadAuthenticatedState();
      }
    } catch (reason) {
      if (!isCurrentInitialization(revision)) {
        return;
      }
      const message = describeError(reason);
      invalidateAuthenticatedStateLoad();
      invalidateModelCatalogs();
      accountProfileRefresh.invalidateSession();
      rateLimitRefresh.invalidateSession();
      if (isRetryableInitializationFailure(reason, stage)) {
        const delay = initializationRetryDelay(attempt);
        batch(() => {
          setEngine(null);
          setAccount(undefined);
          setConfig(null);
          setRateLimits(null);
          setRateLimitsError(null);
          setError(null);
          setRuntimeStatus({
            state: "starting",
            message: `${message} Nova tentativa automática em ${delay / 1000}s.`,
          });
        });
        initializationRetryTimer = setTimeout(() => {
          if (!isCurrentInitialization(revision)) {
            return;
          }
          initializationRetryTimer = null;
          void initialize(revision, attempt + 1);
        }, delay);
      } else {
        batch(() => {
          setEngine(null);
          setAccount(undefined);
          setConfig(null);
          setRateLimits(null);
          setRateLimitsError(null);
          setError(message);
          setRuntimeStatus({ state: "failed", message });
        });
      }
    } finally {
      if (releaseEvents === null) {
        void subscription.then((release) => release()).catch(reportError);
      }
    }
  }

  function isCurrentInitialization(revision: number): boolean {
    return !disposed && initializationRevision === revision;
  }

  function handleRuntimeStatus(status: RuntimeStatus): void {
    if (runtimeStatus().state === "failed") {
      return;
    }
    setRuntimeStatus(status);
  }

  function retryInitialization(): void {
    invalidateAuthenticatedStateLoad();
    invalidateModelCatalogs();
    batch(() => {
      accountProfileRefresh.invalidateSession();
      rateLimitRefresh.invalidateSession();
      setEngine(null);
      setAccount(undefined);
      setConfig(null);
      setRateLimits(null);
      setRateLimitsError(null);
      setError(null);
      setRuntimeStatus({ state: "starting", message: null });
    });
    beginInitialization();
  }

  function loadAuthenticatedState(): Promise<void> {
    if (authenticatedStateLoaded) {
      return Promise.resolve();
    }
    if (authenticatedStateRequest !== null) {
      return authenticatedStateRequest;
    }
    const sessionKey = accountSessionKey(account());
    if (sessionKey === null) {
      return Promise.resolve();
    }
    const request = loadLocalAuthenticatedState(sessionKey)
      .then((loaded) => {
        if (loaded) {
          authenticatedStateLoaded = true;
          void rateLimitRefresh.refreshIfStale();
        }
      })
      .finally(() => {
        if (authenticatedStateRequest === request) {
          authenticatedStateRequest = null;
        }
      });
    authenticatedStateRequest = request;
    return request;
  }

  async function loadLocalAuthenticatedState(expectedSessionKey: string): Promise<boolean> {
    setAutomationsLoading(true);
    try {
      const [threadPage, automationSnapshot] = await Promise.all([
        listThreads(null),
        listAutomations(),
      ]);
      if (disposed || accountSessionKey(account()) !== expectedSessionKey) {
        return false;
      }
      batch(() => {
        setThreads(threadPage.data);
        setThreadsNextCursor(threadPage.nextCursor);
        setAutomations(replaceAutomations(automationSnapshot.data));
        setAutomationRuns(replaceAutomationRuns(automationSnapshot.runs));
      });
      await restoreActiveDestination(productFlow());
      const loaded = !disposed && accountSessionKey(account()) === expectedSessionKey;
      if (loaded) {
        resumePersistedMessageQueues(threadPage.data);
      }
      return loaded;
    } finally {
      if (!disposed) {
        setAutomationsLoading(false);
      }
    }
  }

  async function refreshAutomations(): Promise<boolean> {
    if (!signedIn() || automationsLoading()) {
      return false;
    }
    setAutomationsLoading(true);
    try {
      const snapshot = await withPending(() => listAutomations());
      batch(() => {
        setAutomations(replaceAutomations(snapshot.data));
        setAutomationRuns((current) => replaceAutomationRuns([...snapshot.runs, ...current]));
      });
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    } finally {
      setAutomationsLoading(false);
    }
  }

  async function createAutomation(input: AutomationInput): Promise<boolean> {
    try {
      const created = await withPending(() => createAutomationCommand(input));
      setAutomations((current) => upsertAutomation(current, created));
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  async function updateAutomation(
    automationId: string,
    expectedVersion: number,
    input: AutomationInput,
  ): Promise<boolean> {
    try {
      const updated = await withPending(() =>
        updateAutomationCommand(automationId, expectedVersion, input),
      );
      setAutomations((current) => upsertAutomation(current, updated));
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  async function deleteAutomation(automationId: string): Promise<boolean> {
    const automation = automations().find((entry) => entry.id === automationId);
    if (automation === undefined) {
      setError("A automação que seria excluída não está mais disponível.");
      return false;
    }
    const hasActiveRun = automationRuns().some(
      (run) =>
        run.automationId === automationId && (run.status === "queued" || run.status === "running"),
    );
    if (hasActiveRun) {
      setError("Aguarde a execução ativa terminar antes de excluir esta automação.");
      return false;
    }
    try {
      const confirmed = await confirm(
        `A automação “${automation.name}” e seu histórico de execuções serão excluídos permanentemente. As conversas já criadas serão preservadas.`,
        {
          cancelLabel: "Cancelar",
          kind: "warning",
          okLabel: "Excluir",
          title: "Excluir automação?",
        },
      );
      if (!confirmed) {
        return false;
      }
      await withPending(() => deleteAutomationCommand(automationId));
      batch(() => {
        setAutomations((current) => removeAutomation(current, automationId));
        setAutomationRuns((current) => removeAutomationRuns(current, automationId));
      });
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  async function runAutomationNow(automationId: string): Promise<boolean> {
    try {
      const run = await withPending(() => runAutomationNowCommand(automationId));
      setAutomationRuns((current) => upsertAutomationRun(current, run));
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  async function markAutomationRunReviewed(runId: string): Promise<boolean> {
    try {
      await withPending(() => markAutomationRunReviewedCommand(runId));
      const run = automationRuns().find((entry) => entry.id === runId);
      if (run !== undefined) {
        setAutomationRuns((current) => upsertAutomationRun(current, { ...run, reviewed: true }));
      }
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  function ensureModelsForMode(mode: ConversationMode): Promise<boolean> {
    return mode === "chat" ? loadChatModelCatalog() : loadModelCatalog();
  }

  function loadModelCatalog(): Promise<boolean> {
    if (modelCatalogLoaded) {
      return Promise.resolve(true);
    }
    if (modelCatalogRequest !== null) {
      return modelCatalogRequest;
    }
    const revision = modelCatalogSessionRevision;
    const request = listModels()
      .then((catalog) => {
        if (disposed || revision !== modelCatalogSessionRevision || !signedIn()) {
          return false;
        }
        modelCatalogLoaded = true;
        setModels(catalog.data.filter((model) => !model.hidden));
        return true;
      })
      .catch((reason: unknown) => {
        if (!disposed && revision === modelCatalogSessionRevision) {
          reportError(reason);
        }
        return false;
      })
      .finally(() => {
        if (modelCatalogRequest === request) {
          modelCatalogRequest = null;
        }
      });
    modelCatalogRequest = request;
    return request;
  }

  function loadChatModelCatalog(): Promise<boolean> {
    if (chatModelCatalogLoaded) {
      return Promise.resolve(true);
    }
    if (chatModelCatalogRequest !== null) {
      return chatModelCatalogRequest;
    }
    const revision = modelCatalogSessionRevision;
    const request = listChatModels()
      .then((catalog) => {
        if (disposed || revision !== modelCatalogSessionRevision || !signedIn()) {
          return false;
        }
        chatModelCatalogLoaded = true;
        setChatModels(catalog.data);
        return true;
      })
      .catch((reason: unknown) => {
        if (!disposed && revision === modelCatalogSessionRevision) {
          reportError(reason);
        }
        return false;
      })
      .finally(() => {
        if (chatModelCatalogRequest === request) {
          chatModelCatalogRequest = null;
        }
      });
    chatModelCatalogRequest = request;
    return request;
  }

  function invalidateModelCatalogs(): void {
    modelCatalogSessionRevision += 1;
    modelCatalogLoaded = false;
    chatModelCatalogLoaded = false;
    modelCatalogRequest = null;
    chatModelCatalogRequest = null;
    batch(() => {
      setModels([]);
      setChatModels([]);
    });
  }

  function invalidateAuthenticatedStateLoad(): void {
    authenticatedStateLoaded = false;
    authenticatedStateRequest = null;
    persistedQueuesResumed = false;
    batch(() => {
      setAutomations([]);
      setAutomationRuns([]);
      setAutomationsLoading(false);
    });
  }

  function handleNotification(notification: EngineNotification): void {
    if (isStreamNotification(notification)) {
      for (const delta of streamDeltasFromNotification(notification)) {
        streamDeltas.enqueue(delta);
      }
      return;
    }
    batch(() => {
      streamDeltas.flush();
      handleSemanticNotification(notification);
    });
  }

  function handleSemanticNotification(
    notification: Exclude<EngineNotification, StreamNotification>,
  ): void {
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
      case "automation.changed":
        if (signedIn()) {
          setAutomations((current) => upsertAutomation(current, notification.params.automation));
        }
        return;
      case "automation.deleted":
        if (signedIn()) {
          batch(() => {
            setAutomations((current) =>
              removeAutomation(current, notification.params.automationId),
            );
            setAutomationRuns((current) =>
              removeAutomationRuns(current, notification.params.automationId),
            );
          });
        }
        return;
      case "automation.runUpdated":
        if (signedIn()) {
          setAutomationRuns((current) => upsertAutomationRun(current, notification.params.run));
        }
        return;
      case "thread.created":
      case "thread.updated":
        mergeThread(notification.params.thread);
        updateCachedThread(notification.params.thread.id, (thread) =>
          applyThreadSummary(thread, notification.params.thread),
        );
        setCurrentThread((current) =>
          current?.id === notification.params.thread.id
            ? applyThreadSummary(current, notification.params.thread)
            : current,
        );
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
          if (archived !== undefined && archivedThreadsLoaded()) {
            setArchivedThreads((current) => mergeThreadPages(current, [archived]));
          }
        }
        setThreads((current) =>
          current.filter((thread) => thread.id !== notification.params.threadId),
        );
        if (currentThread()?.id === notification.params.threadId) {
          clearCurrentThread();
        }
        threadPages.delete(notification.params.threadId);
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
        streamDeltas.releaseThread(notification.params.threadId);
        updateCachedThread(notification.params.threadId, (thread) =>
          applyTurnStarted(thread, notification.params.turn),
        );
        setThreads((current) =>
          current.map((thread) =>
            thread.id === notification.params.threadId
              ? applySummaryTurnStarted(thread, notification.params.turn)
              : thread,
          ),
        );
        setCurrentThread((current) =>
          current?.id === notification.params.threadId
            ? applyTurnStarted(current, notification.params.turn)
            : current,
        );
        updateThreadRuntime(notification.params.threadId, (runtime) => ({
          ...runtime,
          activeTurnId: notification.params.turn.id,
          modelReroute: null,
          modelVerifications: [],
          safetyBuffering: null,
        }));
        void rateLimitRefresh.refreshIfStale();
        return;
      case "turn.completed":
        {
          streamDeltas.releaseThread(notification.params.threadId);
          let completedActiveTurn = false;
          batch(() => {
            updateCachedThread(notification.params.threadId, (thread) =>
              applyTurnCompletion(thread, notification.params.turn),
            );
            setThreads((current) =>
              current.map((thread) =>
                thread.id === notification.params.threadId
                  ? applySummaryTurnCompletion(thread, notification.params.turn)
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
                itemOverlays: completedActiveTurn ? [] : runtime.itemOverlays,
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
          void rateLimitRefresh.refreshIfStale();
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
      case "model.safetyBufferingUpdated":
        updateThreadRuntime(notification.params.threadId, (runtime) => ({
          ...runtime,
          safetyBuffering: notification.params,
        }));
        return;
      case "item.started":
      case "item.completed":
        if (notification.method === "item.completed") {
          streamDeltas.releaseItem(notification.params.threadId, notification.params.item.id);
          updateCachedThread(notification.params.threadId, (thread) =>
            applyTurnItem(thread, notification.params.turnId, notification.params.item),
          );
          setCurrentThread((current) =>
            current?.id === notification.params.threadId
              ? applyTurnItem(current, notification.params.turnId, notification.params.item)
              : current,
          );
        }
        updateThreadRuntime(notification.params.threadId, (runtime) => {
          const item = notification.params.item;
          if (item.type === "contextUsage") {
            return { ...runtime, contextUsage: item };
          }
          return {
            ...runtime,
            contextUsage: item.type === "contextCompaction" ? null : runtime.contextUsage,
            itemOverlays: upsertItem(runtime.itemOverlays, item),
          };
        });
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
      return [...current, request];
    });
  }

  function synchronizeAuthentication(expectedSignedIn: boolean): Promise<void> {
    const activeSync = authenticationSync;
    if (activeSync?.expectedSignedIn === expectedSignedIn) {
      return activeSync.promise;
    }

    const predecessor = activeSync?.promise ?? Promise.resolve();
    const promise = predecessor
      .then(async () => {
        const currentAccount = await readAccount();
        accountProfileRefresh.invalidateSession();
        rateLimitRefresh.invalidateSession();
        if (accountSessionKey(account()) !== accountSessionKey(currentAccount)) {
          invalidateAuthenticatedStateLoad();
          invalidateModelCatalogs();
        }
        setAccount(currentAccount);
        surfaceRefreshFailure(currentAccount);
        if ((currentAccount.account !== null) !== expectedSignedIn) {
          throw new Error(
            "O estado de autenticação lido diverge da transição emitida pelo engine.",
          );
        }
        if (expectedSignedIn) {
          void accountProfileRefresh.refreshIfStale();
        }
        if (expectedSignedIn && !authenticatedStateLoaded) {
          await loadAuthenticatedState();
        } else if (expectedSignedIn) {
          void rateLimitRefresh.refreshIfStale();
        } else {
          setRateLimits(null);
          setRateLimitsError(null);
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
      accountProfileRefresh.invalidateSession();
      rateLimitRefresh.invalidateSession();
      invalidateAuthenticatedStateLoad();
      invalidateModelCatalogs();
      try {
        clearPersistedMessageQueues();
      } catch (reason) {
        reportError(reason);
      }
      batch(() => {
        setAccount({
          account: null,
          requiresOpenaiAuth: true,
          refresh: { status: "notRequired", error: null },
        });
        setRateLimits(null);
        setRateLimitsError(null);
        setThreads([]);
        setThreadsNextCursor(null);
        setArchivedThreads([]);
        setArchivedThreadsLoaded(false);
        setArchivedThreadsLoading(false);
        setArchivedThreadsNextCursor(null);
        setThreadRuntime(new Map());
        setMessageQueues(new Map());
        setPendingApprovals([]);
        clearCurrentThread();
        threadPages.clear();
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
    const threadId = destination.threadId;
    if (threadId === null) {
      return true;
    }
    const selectionRevision = beginThreadSelection(threadId);
    try {
      const cached = readCurrentCachedThreadPage(threadId);
      if (cached !== null) {
        if (cached.thread.mode !== mode) {
          throw new Error("A conversa armazenada pertence a outro modo do aplicativo.");
        }
        if (!selectThreadProject(cached.thread)) {
          return false;
        }
        activateThreadPage(cached.thread, cached.nextCursor);
        rememberDestination(mode, cached.thread.id, cached.thread.projectPath);
        return true;
      }
      const response = await withPending(() => resumeThread(threadId));
      if (!isCurrentThreadSelection(selectionRevision) || conversationMode() !== mode) {
        return false;
      }
      if (response.thread.mode !== mode) {
        throw new Error("A conversa restaurada pertence a outro modo do aplicativo.");
      }
      if (!selectThreadProject(response.thread)) {
        return false;
      }
      activateThreadPage(response.thread, response.nextCursor);
      mergeThread(response.thread);
      rememberDestination(mode, response.thread.id, response.thread.projectPath);
      return true;
    } catch (reason) {
      if (!isCurrentThreadSelection(selectionRevision)) {
        return false;
      }
      rememberDestination(mode, null, destination.workspace);
      reportError(reason);
      return false;
    } finally {
      finishThreadSelection(selectionRevision);
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
      return;
    }

    removePinnedProject(path);

    const nextProjectSidebarState = removeProjectSidebarState(projectSidebarState(), path);
    if (nextProjectSidebarState === projectSidebarState()) {
      return;
    }
    try {
      saveProjectSidebarState(nextProjectSidebarState);
      setProjectSidebarState(nextProjectSidebarState);
    } catch (reason) {
      reportError(reason);
    }
  }

  function commitProjectSidebarState(next: ProjectSidebarState): void {
    if (next === projectSidebarState()) {
      return;
    }
    try {
      saveProjectSidebarState(next);
      setProjectSidebarState(next);
    } catch (reason) {
      reportError(reason);
    }
  }

  function projectExpanded(path: string): boolean {
    return readProjectExpanded(projectSidebarState(), path);
  }

  function projectThreadListExpanded(path: string): boolean {
    return readProjectThreadListExpanded(projectSidebarState(), path);
  }

  function toggleProjectExpanded(path: string): void {
    commitProjectSidebarState(toggleStoredProjectExpanded(projectSidebarState(), path));
  }

  function toggleProjectSection(): void {
    commitProjectSidebarState(toggleProjectSectionExpanded(projectSidebarState()));
  }

  function toggleProjectThreadListExpanded(path: string): void {
    commitProjectSidebarState(toggleStoredProjectThreadListExpanded(projectSidebarState(), path));
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

  function togglePinnedProject(path: string): void {
    if (!projects().some((project) => pathsEqual(project.path, path))) {
      setError("O projeto precisa estar disponível antes de ser fixado.");
      return;
    }
    try {
      const next = togglePinnedProjectPath(pinnedProjectPaths(), path);
      savePinnedProjectPaths(next);
      setPinnedProjectPaths(next);
    } catch (reason) {
      reportError(reason);
    }
  }

  function removePinnedProject(path: string): void {
    const next = removePinnedProjectPath(pinnedProjectPaths(), path);
    if (next.length === pinnedProjectPaths().length) {
      return;
    }
    try {
      savePinnedProjectPaths(next);
      setPinnedProjectPaths(next);
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

  function selectThreadProject(thread: ThreadSummary): boolean {
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
      mergeThread(response.thread);
      activateThreadPage(response.thread, response.nextCursor);
      rememberDestination(mode, response.thread.id, response.thread.projectPath);
      return response.thread;
    } catch (reason) {
      reportError(reason);
      return null;
    }
  }

  async function openThread(threadId: string): Promise<boolean> {
    if (pendingThreadSelectionId === threadId) {
      return false;
    }
    if (currentThread()?.id === threadId) {
      invalidateThreadSelection();
      return true;
    }
    const selectionRevision = beginThreadSelection(threadId);
    try {
      const cached = readCurrentCachedThreadPage(threadId);
      if (cached !== null) {
        if (!alignProductFlowToThread(cached.thread.mode)) {
          throw new Error("A conversa selecionada pertence a outro produto do aplicativo.");
        }
        if (!selectThreadProject(cached.thread)) {
          return false;
        }
        activateThreadPage(cached.thread, cached.nextCursor);
        rememberDestination(cached.thread.mode, cached.thread.id, cached.thread.projectPath);
        return true;
      }
      const response = await resumeThread(threadId);
      if (!isCurrentThreadSelection(selectionRevision)) {
        return false;
      }
      if (!pathsEqual(response.cwd, response.thread.cwd)) {
        throw new Error("O engine retomou a tarefa em um diretório inconsistente.");
      }
      if (!alignProductFlowToThread(response.thread.mode)) {
        throw new Error("A conversa selecionada pertence a outro produto do aplicativo.");
      }
      if (!selectThreadProject(response.thread)) {
        return false;
      }
      activateThreadPage(response.thread, response.nextCursor);
      mergeThread(response.thread);
      rememberDestination(response.thread.mode, response.thread.id, response.thread.projectPath);
      return true;
    } catch (reason) {
      if (!isCurrentThreadSelection(selectionRevision)) {
        return false;
      }
      reportError(reason);
      return false;
    } finally {
      finishThreadSelection(selectionRevision);
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
      threadPages.write({ thread: response.thread, nextCursor: response.nextCursor });
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
      mergeThread(response.thread);
      activateThreadPage(response.thread, response.nextCursor);
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
    if (archivedThreadsLoading()) {
      return false;
    }
    const firstPage = !archivedThreadsLoaded();
    const cursor = firstPage ? null : archivedThreadsNextCursor();
    if (!firstPage && cursor === null) {
      return false;
    }
    setArchivedThreadsLoading(true);
    try {
      const page = await listThreads(cursor, true);
      if (disposed) {
        return false;
      }
      batch(() => {
        setArchivedThreads((current) =>
          firstPage ? page.data : mergeThreadPages(current, page.data),
        );
        setArchivedThreadsLoaded(true);
        setArchivedThreadsNextCursor(page.nextCursor);
      });
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    } finally {
      setArchivedThreadsLoading(false);
    }
  }

  async function loadOlderHistory(): Promise<boolean> {
    const thread = currentThread();
    const cursor = historyCursor();
    if (thread === null || cursor === null || historyLoading()) {
      return false;
    }
    setHistoryLoading(true);
    try {
      const page = await readThread(thread.id, cursor);
      if (currentThread()?.id !== thread.id) {
        return false;
      }
      batch(() => {
        setCurrentThread((current) =>
          current?.id === thread.id ? prependThreadHistory(current, page.thread) : current,
        );
        setHistoryCursor(page.nextCursor);
      });
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    } finally {
      setHistoryLoading(false);
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
      const next = appendQueuedMessage(messageQueues(), thread.id, message);
      saveMessageQueue(thread.id, readQueuedMessages(next, thread.id));
      setMessageQueues(next);
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
    try {
      const result = reduceTakeQueuedMessage(messageQueues(), threadId, messageId);
      if (result.message === null) {
        return null;
      }
      saveMessageQueue(threadId, readQueuedMessages(result.queues, threadId));
      setMessageQueues(result.queues);
      return result.message;
    } catch (reason) {
      reportError(reason);
      return null;
    }
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
      removeDispatchedQueuedMessage(threadId, message.id);
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
    configQueue = settledQueueTail(operation);
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
    return rateLimitRefresh.refresh();
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
      threadPages.delete(threadId);
      removePinnedThread(threadId);
    });
    if (selected?.id === threadId) {
      rememberDestination(selected.mode, null, workspace());
    }
  }

  function deleteQueuedMessages(threadId: string): void {
    const current = messageQueues();
    const next = deleteMessageQueue(current, threadId);
    if (next === current) {
      return;
    }
    try {
      saveMessageQueue(threadId, []);
    } catch (reason) {
      reportError(reason);
    }
    setMessageQueues(next);
  }

  function removeDispatchedQueuedMessage(threadId: string, messageId: string): void {
    const result = reduceTakeQueuedMessage(messageQueues(), threadId, messageId);
    if (result.message === null) {
      return;
    }
    try {
      saveMessageQueue(threadId, readQueuedMessages(result.queues, threadId));
    } catch (reason) {
      reportError(reason);
    }
    setMessageQueues(result.queues);
  }

  function resumePersistedMessageQueues(availableThreads: readonly ThreadSummary[]): void {
    if (persistedQueuesResumed || messageQueues().size === 0) {
      return;
    }
    persistedQueuesResumed = true;
    const knownActiveThreads = new Set(
      availableThreads
        .filter((thread) => thread.status.type === "active")
        .map((thread) => thread.id),
    );
    for (const [threadId, messages] of messageQueues()) {
      if (messages.length === 0) {
        continue;
      }
      if (knownActiveThreads.has(threadId)) {
        void hydrateActiveQueuedThread(threadId);
        continue;
      }
      queueMicrotask(() => {
        void scheduleQueuedMessage(threadId);
      });
    }
  }

  async function hydrateActiveQueuedThread(threadId: string): Promise<void> {
    try {
      const page = await readThread(threadId, null);
      if (disposed || readQueuedMessages(messageQueues(), threadId).length === 0) {
        return;
      }
      synchronizeThreadRuntime(page.thread);
      if (page.thread.status.type !== "active") {
        void scheduleQueuedMessage(threadId);
      }
    } catch (reason) {
      reportError(reason);
    }
  }

  function mergeThread(thread: ThreadSummary): void {
    setThreads((current) => {
      const index = current.findIndex((entry) => entry.id === thread.id);
      if (index === -1) {
        return [thread, ...current];
      }
      return current.map((entry, entryIndex) => (entryIndex === index ? thread : entry));
    });
  }

  function activateThreadPage(thread: CodexThread, nextCursor: string | null): void {
    threadPages.write({ thread, nextCursor });
    batch(() => {
      synchronizeThreadRuntime(thread);
      setCurrentThread(thread);
      setHistoryCursor(nextCursor);
    });
  }

  function readCurrentCachedThreadPage(threadId: string) {
    const cached = threadPages.read(threadId);
    if (cached === null) {
      return null;
    }
    const summary = [...threads(), ...archivedThreads()].find((thread) => thread.id === threadId);
    return summary !== undefined && cachedThreadMatchesSummary(cached, summary) ? cached : null;
  }

  function updateCachedThread(
    threadId: string,
    update: (thread: CodexThread) => CodexThread,
  ): void {
    try {
      threadPages.update(threadId, (page) => ({
        ...page,
        thread: update(page.thread),
      }));
    } catch (reason) {
      threadPages.delete(threadId);
      if (currentThread()?.id === threadId) {
        throw reason;
      }
    }
  }

  function beginThreadSelection(threadId: string): number {
    threadSelectionRevision += 1;
    pendingThreadSelectionId = threadId;
    return threadSelectionRevision;
  }

  function isCurrentThreadSelection(revision: number): boolean {
    return revision === threadSelectionRevision;
  }

  function finishThreadSelection(revision: number): void {
    if (isCurrentThreadSelection(revision)) {
      pendingThreadSelectionId = null;
    }
  }

  function invalidateThreadSelection(): void {
    threadSelectionRevision += 1;
    pendingThreadSelectionId = null;
  }

  function clearCurrentThread(): void {
    const thread = currentThread();
    if (thread !== null) {
      threadPages.write({ thread, nextCursor: historyCursor() });
    }
    invalidateThreadSelection();
    batch(() => {
      setCurrentThread(null);
      setHistoryCursor(null);
    });
  }

  function accountSessionKey(value: AccountReadResponse | undefined): string | null {
    const currentAccount = value?.account;
    return currentAccount === null || currentAccount === undefined
      ? null
      : (currentAccount.email ?? "chatgpt");
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
    const diagnostic = describeDiagnosticError(reason);
    setError(message);
    addDiagnostic({ stream: "runtime", message: diagnostic });
    if (engine() !== null) {
      void reportFrontendDiagnostic(diagnostic).catch((persistenceFailure: unknown) => {
        addDiagnostic({
          stream: "runtime",
          message: `Falha ao persistir diagnóstico do frontend: ${describeError(persistenceFailure)}`,
        });
      });
    }
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
    archivedThreadsLoaded,
    archivedThreadsLoading,
    archivedThreadsNextCursor,
    automations,
    automationRuns,
    automationsLoading,
    busy,
    config,
    contextUsage,
    currentThread,
    currentThreadTitle,
    hasOlderHistory,
    historyLoading,
    product,
    chatGptMode,
    chatModels,
    conversationMode,
    diagnostics,
    engine,
    error,
    lastTurnFailure,
    loginPending,
    models,
    modelReroute,
    modelVerifications,
    pendingOperations,
    pinnedProjectPaths,
    pinnedThreadIds,
    persistedTurns,
    projectSectionExpanded,
    projects,
    queuedMessages,
    rateLimits,
    rateLimitsError,
    rateLimitsLoading,
    runtimeStatus,
    signedIn,
    safetyBuffering,
    threads: visibleThreads,
    threadsNextCursor,
    turnBusy,
    turns,
    unreadAutomationRuns,
    workspace,
    archiveThread,
    cancelLogin,
    chooseWorkspace,
    clearError: () => setError(null),
    compactThread,
    createAutomation,
    deleteAutomation,
    deleteThread,
    deleteQueuedMessage,
    ensureModelsForMode,
    enqueueMessage,
    forkThread,
    inspectFiles,
    interrupt,
    projectExpanded,
    projectThreadListExpanded,
    isThreadActive,
    loadMoreThreads,
    loadMoreArchivedThreads,
    loadOlderHistory,
    login,
    logout,
    markAutomationRunReviewed,
    newThread,
    openThread,
    refreshAutomations,
    refreshAccountProfile: accountProfileRefresh.refreshIfStale,
    refreshRateLimits,
    refreshRateLimitsIfStale: rateLimitRefresh.refreshIfStale,
    reportError,
    removeProject: removeProjectFromSidebar,
    renameThread,
    retryInitialization,
    respondToApproval,
    runAutomationNow,
    saveClipboardImage: saveClipboard,
    selectProject,
    selectProduct,
    selectChatGptMode,
    sendMessage,
    sendQueuedMessageNow,
    takeQueuedMessage,
    togglePinnedProject,
    togglePinnedThread,
    toggleProjectExpanded,
    toggleProjectSection,
    toggleProjectThreadListExpanded,
    updateAutomation,
    updateProject,
    updateSetting,
    unarchiveThread,
  };
}

type StreamNotification = Extract<
  EngineNotification,
  {
    readonly method: "item.streamDeltas";
  }
>;

function isStreamNotification(
  notification: EngineNotification,
): notification is StreamNotification {
  return notification.method === "item.streamDeltas";
}

function streamDeltasFromNotification(notification: StreamNotification): readonly StreamDelta[] {
  return notification.params.deltas.map((delta): StreamDelta => {
    switch (delta.kind) {
      case "agentText":
        return {
          kind: "agentText",
          threadId: notification.params.threadId,
          itemId: delta.itemId,
          delta: delta.delta,
        };
      case "reasoningSummary":
      case "reasoningText":
        return {
          kind: "reasoningText",
          threadId: notification.params.threadId,
          itemId: delta.itemId,
          index: delta.index,
          target: delta.kind === "reasoningSummary" ? "summary" : "content",
          delta: delta.delta,
        };
      default:
        return assertNever(delta);
    }
  });
}

function withBootTimeout<T>(
  label: string,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new InitializationTimeoutError(
          `O engine não respondeu em ${timeoutMs / 1000} segundos ao ${label}. Tente novamente.`,
        ),
      );
    }, timeoutMs);
  });
  return Promise.race([operation(), timeout]).finally(() => clearTimeout(timer));
}

function mergeThreadPages(
  current: readonly ThreadSummary[],
  incoming: readonly ThreadSummary[],
): readonly ThreadSummary[] {
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

function settledQueueTail(operation: Promise<unknown>): Promise<void> {
  return operation.then(
    () => undefined,
    () => undefined,
  );
}
