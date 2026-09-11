import {
  type Accessor,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import type { ConfigurableNotificationEventKind } from "../contracts/notificationOverlay";
import type {
  AccountProfileResponse,
  AccountReadResponse,
  AppProduct,
  ApprovalDecision,
  Attachment,
  ChatGptMode,
  CodexThread,
  ConfigReadResponse,
  ConfigUpdate,
  ConversationMode,
  EngineNotification,
  EngineServerRequest,
  EngineStartResponse,
  OutputReadResponse,
  ProjectRecord,
  RuntimeDiagnostic,
  RuntimeStatus,
  ThreadSummary,
} from "../contracts/types";
import { formatMessage, type TranslationMessages } from "../i18n/messages";
import {
  archiveThread as archiveThreadCommand,
  cancelLogin as cancelLoginCommand,
  confirmDesktopDialog as confirm,
  deleteThread as deleteThreadCommand,
  describeDiagnosticError,
  describeError,
  forkThread as forkThreadCommand,
  inspectAttachments,
  interruptTurn,
  listAutomations,
  listThreads,
  loginWithChatGpt,
  logout as logoutCommand,
  openDesktopDialog as open,
  openExternalUrl as openExternalUrlCommand,
  openWorkspaceDirectory as openWorkspaceDirectoryCommand,
  readAccount,
  readAttachmentImage as readAttachmentImageCommand,
  readOutput as readOutputCommand,
  readThread,
  reportFrontendDiagnostic,
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
import { subscribeToMenuEvents, synchronizeApplicationMenu } from "../infrastructure/desktopClient";
import { isDesktopRuntime } from "../platform/desktopRuntime";
import { mergeAccountProfile } from "./accountProfileRefresh";
import { createAccountUsageController } from "./accountUsageController";
import type {
  AppController,
  ApplicationShellActionRequest,
  AttachmentSelectionResult,
  DiagnosticEntry,
  SendMessageInput,
} from "./appController";
import { createApplicationPreferencesController } from "./applicationPreferencesController";
import { type AppNotificationInput, createAppNotificationCenter } from "./appNotifications";
import { createAutomationSessionController } from "./automationSessionController";
import {
  captureInitialization,
  type SessionControllerHost,
  settledQueueTail,
  withBootTimeout,
} from "./controllerSupport";
import { applyCommandStreamDeltasToThread, readLatestTurnFailure } from "./conversation";
import {
  type InitializationStage,
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
import { createModelCatalogController } from "./modelCatalogController";
import { createNotificationOverlayBridge } from "./notificationOverlayBridge";
import { createNotificationPreview } from "./notificationPreview";
import { notificationTaskLabel } from "./notificationTransitions";
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
import { SingleFlightOperations } from "./singleFlightOperations";
import {
  createBrowserStreamDeltaScheduler,
  createStreamDeltaBatcher,
  type StreamDelta,
} from "./streamDeltas";
import { replaceTaskAgentFamily, updateTaskThread, upsertTaskThread } from "./taskThreads";
import { applyThreadSummary, prependThreadHistory } from "./threadHistory";
import { cachedThreadMatchesSummary, ThreadPageCache } from "./threadPageCache";
import {
  applyThreadRuntimeStreamDeltas,
  completeThreadRuntimeTurn,
  isTimelineVisibleItem,
  mergeRuntimeThreadItems,
  type PersistedVisibleTurnsBySource,
  queuedMessageDispatchDecision,
  readActiveTurnPlan,
  readPersistedVisibleTurns,
  isThreadActive as readThreadActive,
  readThreadRuntimeItemIds,
  recordThreadRuntimeItemOrder,
  deleteThreadRuntime as reduceDeleteThreadRuntime,
  synchronizeThreadRuntime as reduceSynchronizeThreadRuntime,
  updateThreadRuntime as reduceUpdateThreadRuntime,
  removeThreadRuntimeItemOverlay,
  shouldMaterializeThreadItemNotification,
  type ThreadRuntimeState,
  upsertThreadRuntimeItemOverlay,
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

interface AppControllerLocalization {
  readonly confirmations: Accessor<TranslationMessages["confirmations"]>;
  readonly nativeMenu: Accessor<TranslationMessages["nativeMenu"]>;
  readonly notifications: Accessor<TranslationMessages["notifications"]>;
}

export function createAppController(localization: AppControllerLocalization): AppController {
  const capturedProductFlow = captureInitialization(() => loadProductFlowState());
  const initialProductFlow =
    capturedProductFlow.failure === undefined
      ? capturedProductFlow.value
      : defaultProductFlowState();
  const productFlowLoadError = capturedProductFlow.failure ?? null;
  const [productFlow, setProductFlow] = createSignal<ProductFlowState>(initialProductFlow);
  const [runtimeStatus, setRuntimeStatus] = createSignal<RuntimeStatus>({
    state: "starting",
    message: null,
  });
  const [engine, setEngine] = createSignal<EngineStartResponse | null>(null);
  const [account, setAccount] = createSignal<AccountReadResponse>();
  const [config, setConfig] = createSignal<ConfigReadResponse | null>(null);
  const [applicationShellActionRequest, setApplicationShellActionRequest] =
    createSignal<ApplicationShellActionRequest | null>(null);
  const [threads, setThreads] = createSignal<readonly ThreadSummary[]>([]);
  const [threadsNextCursor, setThreadsNextCursor] = createSignal<string | null>(null);
  const [archivedThreads, setArchivedThreads] = createSignal<readonly ThreadSummary[]>([]);
  const [archivedThreadsLoaded, setArchivedThreadsLoaded] = createSignal(false);
  const [archivedThreadsLoading, setArchivedThreadsLoading] = createSignal(false);
  const [archivedThreadsNextCursor, setArchivedThreadsNextCursor] = createSignal<string | null>(
    null,
  );
  const [currentThread, setCurrentThread] = createSignal<CodexThread | null>(null);
  const [allAgentThreads, setAllAgentThreads] = createSignal<readonly ThreadSummary[]>([]);
  const activeTaskRootId = createMemo(
    () => currentThread()?.agent?.rootThreadId ?? currentThread()?.id ?? null,
  );
  const agentThreads = createMemo(() => {
    const rootThreadId = activeTaskRootId();
    return rootThreadId === null
      ? []
      : allAgentThreads().filter((thread) => thread.agent?.rootThreadId === rootThreadId);
  });
  const [historyCursor, setHistoryCursor] = createSignal<string | null>(null);
  const [historyLoading, setHistoryLoading] = createSignal(false);
  const threadPages = new ThreadPageCache(THREAD_PAGE_CACHE_CAPACITY);
  const persistedVisibleTurnsBySource: PersistedVisibleTurnsBySource = new WeakMap();
  const capturedPinnedThreadIds = captureInitialization(loadPinnedThreadIds);
  const initialPinnedThreadIds =
    capturedPinnedThreadIds.failure === undefined ? capturedPinnedThreadIds.value : [];
  const pinLoadError = capturedPinnedThreadIds.failure ?? null;
  const [pinnedThreadIds, setPinnedThreadIds] = createSignal(initialPinnedThreadIds);
  const capturedProjectPins = captureInitialization(loadPinnedProjectPaths);
  const initialPinnedProjectPaths =
    capturedProjectPins.failure === undefined ? capturedProjectPins.value : [];
  const projectPinLoadError = capturedProjectPins.failure ?? null;
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
  const capturedMessageQueues = captureInitialization(loadMessageQueues);
  let initialMessageQueues: MessageQueueMap = new Map();
  let messageQueueLoadWarnings: readonly string[] = [];
  if (capturedMessageQueues.failure === undefined) {
    initialMessageQueues = capturedMessageQueues.value.queues;
    messageQueueLoadWarnings = capturedMessageQueues.value.warnings;
  } else {
    messageQueueLoadWarnings = [capturedMessageQueues.failure.message];
  }
  const [messageQueues, setMessageQueues] = createSignal<MessageQueueMap>(initialMessageQueues);
  const [pendingApprovals, setPendingApprovals] = createSignal<readonly EngineServerRequest[]>([]);
  const [diagnostics, setDiagnostics] = createSignal<readonly DiagnosticEntry[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [pendingOperations, setPendingOperations] = createSignal(0);
  const [notificationUsageSettingsRequest, setNotificationUsageSettingsRequest] = createSignal(0);
  const [loginPending, setLoginPending] = createSignal(false);
  const [workspace, setWorkspace] = createSignal<string | null>(null);
  let loginId: string | null = null;
  let diagnosticSequence = 0;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let unsubscribeFromMenu: (() => void) | null = null;
  let applicationShellActionSequence = 0;
  let notificationSequence = 0;
  let initializationRevision = 0;
  let initializationRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let configQueue: Promise<void> = Promise.resolve();
  const queuedDispatchTails = new Map<string, Promise<void>>();
  const singleFlightOperations = new SingleFlightOperations<string, boolean>();
  let authenticationSync: {
    readonly expectedSignedIn: boolean;
    readonly promise: Promise<void>;
  } | null = null;
  let authenticatedStateLoaded = false;
  let authenticatedStateRequest: Promise<void> | null = null;
  let persistedQueuesResumed = false;
  const capturedProjects = captureInitialization(loadProjects);
  const initialProjects = capturedProjects.failure === undefined ? capturedProjects.value : [];
  const projectLoadError = capturedProjects.failure ?? null;
  const [projects, setProjects] = createSignal(initialProjects);
  const capturedProjectSidebarState = captureInitialization(loadProjectSidebarState);
  const initialProjectSidebarState =
    capturedProjectSidebarState.failure === undefined
      ? capturedProjectSidebarState.value
      : defaultProjectSidebarState();
  const projectSidebarStateLoadError = capturedProjectSidebarState.failure ?? null;
  const [projectSidebarState, setProjectSidebarState] = createSignal<ProjectSidebarState>(
    initialProjectSidebarState,
  );
  setWorkspace(
    initialProductFlow.destinations[activeConversationMode(initialProductFlow)].workspace,
  );

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
          message: `Failed to persist frontend diagnostic: ${describeError(persistenceFailure)}`,
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

  const sessionHost: SessionControllerHost = {
    isDisposed: () => disposed,
    reportError,
    setError,
    singleFlight: singleFlightOperations,
    withPending,
  };

  const modelCatalog = createModelCatalogController({
    host: sessionHost,
    isSignedIn: () => signedIn(),
  });

  function enqueueNotification(input: AppNotificationInput): boolean {
    return preferences.applicationPreferencesLoaded() && notificationCenter.enqueue(input);
  }

  const accountUsage = createAccountUsageController({
    account,
    addDiagnostic,
    applyAccountProfile: (profile: AccountProfileResponse) => {
      setAccount((current) => mergeAccountProfile(current, profile));
    },
    enqueueNotification,
    host: sessionHost,
    isSignedIn: () => signedIn(),
    localization: { notifications: localization.notifications },
    onLunaReserveChanged: () => {
      modelCatalog.invalidateCatalogs();
      void modelCatalog.ensureModelsForMode(conversationMode());
    },
  });

  const automationSession = createAutomationSessionController({
    confirmations: localization.confirmations,
    host: sessionHost,
    isSignedIn: () => signedIn(),
  });

  const preferences = createApplicationPreferencesController({
    isDisposed: () => disposed,
    onSaved: notifySettingsSaved,
    reportError,
  });

  const notificationCenter = createAppNotificationCenter(
    () => preferences.applicationPreferences().notifications,
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

  const selectedRuntime = createMemo<ThreadRuntimeState | null>(() => {
    const threadId = currentThread()?.id;
    return threadId === undefined ? null : (threadRuntime().get(threadId) ?? null);
  });
  const activeTurnId = createMemo(() => selectedRuntime()?.activeTurnId ?? null);
  const contextUsage = createMemo(() => selectedRuntime()?.contextUsage ?? null);
  const streamingItemIds = createMemo<ReadonlySet<string>>(() =>
    readThreadRuntimeItemIds(selectedRuntime()),
  );
  const persistedTurns = createMemo<readonly VisibleThreadTurn[]>(() => {
    const thread = currentThread();
    return thread === null ? [] : readPersistedVisibleTurns(persistedVisibleTurnsBySource, thread);
  });
  const turns = createMemo<VisibleTurnSequence>(() => {
    const thread = currentThread();
    const runtime = selectedRuntime();
    return thread === null
      ? []
      : mergeRuntimeThreadItems(
          thread,
          persistedTurns(),
          runtime?.itemOverlaysByTurn ?? new Map(),
          runtime?.activeTurnId ?? null,
          runtime?.itemOrderByTurn ?? new Map(),
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
  const projectSectionExpanded = createMemo(() => projectSidebarState().projectsExpanded);
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
      void modelCatalog.ensureModelsForMode(mode);
    }
  });

  createEffect(() => {
    const translation = localization.nativeMenu();
    if (isDesktopRuntime()) void synchronizeApplicationMenu(translation).catch(reportError);
  });

  createEffect(() => {
    if (!preferences.applicationPreferences().notifications.enabled) notificationCenter.clear();
  });

  function publishApplicationShellAction(type: ApplicationShellActionRequest["type"]): void {
    applicationShellActionSequence += 1;
    setApplicationShellActionRequest({ sequence: applicationShellActionSequence, type });
  }

  function notifySettingsSaved(): void {
    notificationSequence += 1;
    enqueueNotification({
      approval: null,
      id: `settings-saved:${notificationSequence}`,
      event: "settingsSaved",
      tone: "success",
      title: localization.notifications().settingsSavedTitle,
      message: localization.notifications().settingsSavedMessage,
      target: null,
    });
  }

  function previewNotification(event: ConfigurableNotificationEventKind): boolean {
    if (!preferences.applicationPreferencesLoaded()) return false;
    notificationSequence += 1;
    return notificationCenter.preview(
      createNotificationPreview(event, localization.notifications(), notificationSequence),
    );
  }

  function notifyTurnCompletion(
    notification: Extract<EngineNotification, { readonly method: "turn.completed" }>,
  ): void {
    if (notification.params.turn.status === "interrupted") return;
    const task = notificationTaskLabel(
      notification.params.threadId,
      [...threads(), ...allAgentThreads()],
      localization.notifications().untitledTask,
    );
    const failed =
      notification.params.turn.status === "failed" || notification.params.error !== null;
    enqueueNotification({
      approval: null,
      id: `task-${failed ? "failed" : "completed"}:${notification.params.turn.id}`,
      event: failed ? "taskFailed" : "taskCompleted",
      tone: failed ? "error" : "success",
      title: failed
        ? localization.notifications().taskFailedTitle
        : localization.notifications().taskCompletedTitle,
      message: formatMessage(
        failed
          ? localization.notifications().taskFailedMessage
          : localization.notifications().taskCompletedMessage,
        { task },
      ),
      target: { type: "thread", threadId: notification.params.threadId },
    });
  }

  function handleServerRequest(request: EngineServerRequest): void {
    setPendingApprovals((current) => {
      if (current.some((entry) => entry.id === request.id)) {
        throw new Error(`Approval ${request.id} was received twice.`);
      }
      return [...current, request];
    });
    const task = notificationTaskLabel(
      request.params.threadId,
      [...threads(), ...allAgentThreads()],
      localization.notifications().untitledTask,
    );
    enqueueNotification({
      approval: request,
      id: `approval-required:${request.id}`,
      event: "approvalRequired",
      tone: "attention",
      title: localization.notifications().approvalTitle,
      message: formatMessage(localization.notifications().approvalMessage, { task }),
      target: { type: "thread", threadId: request.params.threadId },
    });
  }

  onMount(() => {
    accountUsage.start();
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
    if (isDesktopRuntime()) {
      void subscribeToMenuEvents({
        onNewThread: () => publishApplicationShellAction("newThread"),
        onToggleSettings: () => publishApplicationShellAction("toggleSettings"),
        onToggleSidebar: () => publishApplicationShellAction("toggleSidebar"),
      })
        .then((dispose) => {
          if (disposed) {
            dispose();
          } else {
            unsubscribeFromMenu = dispose;
          }
        })
        .catch(reportError);
    }
    void preferences.loadApplicationPreferences().finally(() => {
      if (!disposed) beginInitialization();
    });
  });

  onCleanup(() => {
    disposed = true;
    initializationRevision += 1;
    if (initializationRetryTimer !== null) {
      clearTimeout(initializationRetryTimer);
      initializationRetryTimer = null;
    }
    accountUsage.dispose();
    streamDeltas.dispose();
    unsubscribe?.();
    unsubscribe = null;
    unsubscribeFromMenu?.();
    unsubscribeFromMenu = null;
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
      const started = await withBootTimeout("start the engine", ENGINE_START_TIMEOUT_MS, () =>
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
      applyAccountSession(currentAccount);
      if (currentAccount.account !== null) {
        void accountUsage.refreshAccountProfile();
        stage = "authenticatedState";
        await loadAuthenticatedState();
      }
    } catch (reason) {
      if (!isCurrentInitialization(revision)) {
        return;
      }
      const message = describeError(reason);
      invalidateAuthenticatedStateLoad();
      modelCatalog.invalidateCatalogs();
      accountUsage.invalidateProfileSession();
      accountUsage.invalidateUsageSession();
      if (isRetryableInitializationFailure(reason, stage)) {
        const delay = initializationRetryDelay(attempt);
        batch(() => {
          setEngine(null);
          setAccount(undefined);
          setConfig(null);
          accountUsage.applySignedOut();
          setError(null);
          setRuntimeStatus({
            state: "starting",
            message: `${message} Retrying automatically in ${delay / 1000}s.`,
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
          accountUsage.applySignedOut();
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

  function applyAccountSession(currentAccount: AccountReadResponse): void {
    accountUsage.invalidateProfileSession();
    accountUsage.invalidateUsageSession();
    if (accountSessionKey(account()) !== accountSessionKey(currentAccount)) {
      invalidateAuthenticatedStateLoad();
      modelCatalog.invalidateCatalogs();
    }
    setAccount(currentAccount);
    if (currentAccount.refresh.status === "failed") {
      setError(currentAccount.refresh.error ?? "The ChatGPT session refresh failed.");
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
    modelCatalog.invalidateCatalogs();
    batch(() => {
      accountUsage.invalidateProfileSession();
      accountUsage.invalidateUsageSession();
      setEngine(null);
      setAccount(undefined);
      setConfig(null);
      accountUsage.applySignedOut();
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
          void accountUsage.refreshRateLimitsIfStale();
          void accountUsage.refreshUsageResetsIfStale();
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
    automationSession.setLoading(true);
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
        automationSession.loadSession(automationSnapshot);
      });
      await restoreActiveDestination(productFlow());
      const loaded = !disposed && accountSessionKey(account()) === expectedSessionKey;
      if (loaded) {
        resumePersistedMessageQueues(threadPage.data);
      }
      return loaded;
    } finally {
      if (!disposed) {
        automationSession.setLoading(false);
      }
    }
  }

  function invalidateAuthenticatedStateLoad(): void {
    authenticatedStateLoaded = false;
    authenticatedStateRequest = null;
    persistedQueuesResumed = false;
    automationSession.clearSession();
  }

  function handleNotification(notification: EngineNotification): void {
    if (isStreamNotification(notification)) {
      const deltas = streamDeltasFromNotification(notification);
      for (const delta of deltas) {
        streamDeltas.enqueue(delta);
      }
      const commandDeltas = deltas.filter(
        (delta): delta is Extract<StreamDelta, { readonly kind: "commandOutput" }> =>
          delta.kind === "commandOutput",
      );
      if (commandDeltas.length > 0) {
        updateCachedThread(notification.params.threadId, (thread) =>
          applyCommandStreamDeltasToThread(thread, commandDeltas),
        );
        setCurrentThread((current) =>
          current?.id === notification.params.threadId
            ? applyCommandStreamDeltasToThread(current, commandDeltas)
            : current,
        );
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
          throw new Error("The engine completed a login other than the active flow.");
        }
        loginId = null;
        setLoginPending(false);
        if (!notification.params.success) {
          setError(notification.params.error ?? "The ChatGPT login did not complete.");
          return;
        }
        void synchronizeAuthentication(true);
        return;
      case "auth.sessionChanged":
        void synchronizeAuthentication(notification.params.signedIn);
        return;
      case "account.rateLimitsUpdated":
        if (!signedIn()) {
          return;
        }
        accountUsage.applyRateLimitNotification(notification.params.rateLimits);
        return;
      case "automation.changed":
        automationSession.applyChanged(notification.params.automation);
        return;
      case "automation.deleted":
        automationSession.applyDeleted(notification.params.automationId);
        return;
      case "automation.runUpdated":
        automationSession.applyRunUpdated(notification.params.run);
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
        updateThreadSummary(notification.params.threadId, (thread) =>
          applySummaryTurnStarted(thread, notification.params.turn),
        );
        setCurrentThread((current) =>
          current?.id === notification.params.threadId
            ? applyTurnStarted(current, notification.params.turn)
            : current,
        );
        updateThreadRuntime(notification.params.threadId, (runtime) => ({
          ...runtime,
          activeTurnId: notification.params.turn.id,
          itemOrderByTurn: new Map(),
          modelReroute: null,
          modelVerifications: [],
          safetyBuffering: null,
        }));
        void accountUsage.refreshRateLimitsIfStale();
        return;
      case "turn.completed":
        {
          streamDeltas.releaseThread(notification.params.threadId);
          let completedActiveTurn = false;
          batch(() => {
            updateCachedThread(notification.params.threadId, (thread) =>
              applyTurnCompletion(thread, notification.params.turn),
            );
            updateThreadSummary(notification.params.threadId, (thread) =>
              applySummaryTurnCompletion(thread, notification.params.turn),
            );
            setCurrentThread((current) =>
              current?.id === notification.params.threadId
                ? applyTurnCompletion(current, notification.params.turn)
                : current,
            );
            updateThreadRuntime(notification.params.threadId, (runtime) => {
              const completion = completeThreadRuntimeTurn(runtime, notification.params.turn);
              completedActiveTurn = completion.completedActiveTurn;
              return completion.runtime;
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
          notifyTurnCompletion(notification);
          void accountUsage.refreshRateLimitsIfStale();
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
        {
          const item = notification.params.item;
          const itemOrderByTurn = recordThreadRuntimeItemOrder(
            threadRuntime().get(notification.params.threadId)?.itemOrderByTurn ?? new Map(),
            notification.params.turnId,
            item.id,
          );
          const causalOrder = itemOrderByTurn.get(notification.params.turnId);
          if (causalOrder === undefined) {
            throw new Error("The notified item's causal order became inconsistent.");
          }
          const materializeInThread = shouldMaterializeThreadItemNotification(notification.method);
          if (materializeInThread) {
            updateCachedThread(notification.params.threadId, (thread) =>
              applyTurnItem(thread, notification.params.turnId, item, causalOrder),
            );
            setCurrentThread((current) =>
              current?.id === notification.params.threadId
                ? applyTurnItem(current, notification.params.turnId, item, causalOrder)
                : current,
            );
          }
          if (notification.method === "item.completed") {
            streamDeltas.releaseItem(
              notification.params.threadId,
              notification.params.turnId,
              notification.params.item.id,
            );
          }
          updateThreadRuntime(notification.params.threadId, (runtime) => {
            if (item.type === "contextUsage") {
              return { ...runtime, contextUsage: item, itemOrderByTurn };
            }
            if (!isTimelineVisibleItem(item)) {
              return {
                ...runtime,
                itemOrderByTurn,
                itemOverlaysByTurn: removeThreadRuntimeItemOverlay(
                  runtime.itemOverlaysByTurn,
                  notification.params.turnId,
                  item.id,
                ),
              };
            }
            return {
              ...runtime,
              contextUsage: item.type === "contextCompaction" ? null : runtime.contextUsage,
              itemOrderByTurn,
              itemOverlaysByTurn:
                notification.method === "item.completed"
                  ? removeThreadRuntimeItemOverlay(
                      runtime.itemOverlaysByTurn,
                      notification.params.turnId,
                      item.id,
                    )
                  : upsertThreadRuntimeItemOverlay(
                      runtime.itemOverlaysByTurn,
                      notification.params.turnId,
                      item,
                    ),
            };
          });
        }
        if (
          notification.method === "item.completed" &&
          notification.params.item.type === "commandExecution" &&
          notification.params.item.processId !== null &&
          notification.params.item.status !== "inProgress"
        ) {
          queueMicrotask(() => {
            if (currentThread()?.id === notification.params.threadId && activeTurnId() === null) {
              void scheduleQueuedMessage(notification.params.threadId);
            }
          });
        }
        return;
      default:
        assertNever(notification);
    }
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
        applyAccountSession(currentAccount);
        if ((currentAccount.account !== null) !== expectedSignedIn) {
          throw new Error(
            "The authentication state differs from the transition emitted by the engine.",
          );
        }
        if (expectedSignedIn) {
          void accountUsage.refreshAccountProfile();
        }
        if (expectedSignedIn && !authenticatedStateLoaded) {
          await loadAuthenticatedState();
        } else if (expectedSignedIn) {
          void accountUsage.refreshRateLimitsIfStale();
        } else {
          accountUsage.applySignedOut();
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
        await openExternalUrlCommand(response.authUrl);
      } catch (openError) {
        const cancelResponse = await cancelLoginCommand(response.loginId);
        loginId = null;
        setLoginPending(false);
        throw new Error(
          `The browser could not be opened; login ${cancelResponse.status}: ${describeError(openError)}`,
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
        throw new Error("The login flow was no longer active.");
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
      accountUsage.invalidateProfileSession();
      accountUsage.invalidateUsageSession();
      invalidateAuthenticatedStateLoad();
      modelCatalog.invalidateCatalogs();
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
        accountUsage.applySignedOut();
        setThreads([]);
        setAllAgentThreads([]);
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
            "The local session was removed, but remote revocation failed.",
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
      setError("Chat conversations cannot access local projects. Switch to Work or Codex.");
      return null;
    }
    try {
      const selection = await open({ directory: true, multiple: false });
      if (selection === null) {
        return null;
      }
      if (Array.isArray(selection)) {
        throw new Error("The picker returned multiple directories for a single selection.");
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
          throw new Error("The stored conversation belongs to another application mode.");
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
        throw new Error("The restored conversation belongs to another application mode.");
      }
      if (!selectThreadProject(response.thread)) {
        return false;
      }
      activateThreadPage(response.thread, response.nextCursor);
      replaceAgentThreadFamily(response.thread, response.agentThreads);
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
      setError("Chat does not associate conversations with local projects.");
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
      setError("The task must be available before it can be pinned.");
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
      setError("The project must be available before it can be pinned.");
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
    if (signedIn()) {
      void modelCatalog.ensureModelsForMode(mode);
    }
    const requestedWorkspace = mode === "chat" ? null : (targetWorkspace ?? null);
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
        throw new Error("The engine created the conversation in a mode other than requested.");
      }
      if (!pathsEqual(response.thread.projectPath, projectPath)) {
        throw new Error("The engine created the task with a different project association.");
      }
      if (
        response.thread.projectPath !== null &&
        !pathsEqual(response.thread.cwd, response.thread.projectPath)
      ) {
        throw new Error("The task working directory differs from its associated project.");
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
          throw new Error("The selected conversation belongs to another application product.");
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
        throw new Error("The engine resumed the task in an inconsistent directory.");
      }
      if (!alignProductFlowToThread(response.thread.mode)) {
        throw new Error("The selected conversation belongs to another application product.");
      }
      if (!selectThreadProject(response.thread)) {
        return false;
      }
      activateThreadPage(response.thread, response.nextCursor);
      replaceAgentThreadFamily(response.thread, response.agentThreads);
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

  function renameThread(threadId: string, name: string): Promise<boolean> {
    return singleFlightOperations.run(`thread:rename:${threadId}:${name.trim()}`, () =>
      renameThreadOnce(threadId, name),
    );
  }

  async function renameThreadOnce(threadId: string, name: string): Promise<boolean> {
    if (name.trim().length === 0) {
      setError("The task name cannot be empty.");
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

  function archiveThread(threadId: string): Promise<boolean> {
    return singleFlightOperations.run(`thread:archive:${threadId}`, () =>
      archiveThreadOnce(threadId),
    );
  }

  async function archiveThreadOnce(threadId: string): Promise<boolean> {
    try {
      await withPending(() => archiveThreadCommand(threadId));
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  function unarchiveThread(threadId: string): Promise<boolean> {
    return singleFlightOperations.run(`thread:unarchive:${threadId}`, () =>
      unarchiveThreadOnce(threadId),
    );
  }

  async function unarchiveThreadOnce(threadId: string): Promise<boolean> {
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
    const thread = [...threads(), ...archivedThreads(), ...allAgentThreads()].find(
      (entry) => entry.id === threadId,
    );
    return thread !== undefined && readThreadActive(thread, threadRuntime().get(threadId));
  }

  function isItemStreaming(itemId: string): boolean {
    return streamingItemIds().has(itemId);
  }

  function deleteThread(threadId: string): Promise<boolean> {
    return singleFlightOperations.run(`thread:delete:${threadId}`, () =>
      deleteThreadOnce(threadId),
    );
  }

  async function deleteThreadOnce(threadId: string): Promise<boolean> {
    const thread = [...threads(), ...archivedThreads(), ...allAgentThreads()].find(
      (entry) => entry.id === threadId,
    );
    if (thread === undefined) {
      setError("The task to delete is no longer available.");
      return false;
    }
    try {
      const title = thread.name ?? thread.preview ?? localization.confirmations().newTask;
      const description = isThreadActive(threadId)
        ? formatMessage(localization.confirmations().deleteActiveTaskDescription, { name: title })
        : formatMessage(localization.confirmations().deleteTaskDescription, { name: title });
      const confirmed = await confirm(description, {
        cancelLabel: localization.confirmations().cancel,
        kind: "warning",
        okLabel: localization.confirmations().delete,
        title: localization.confirmations().deleteTaskTitle,
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

  function forkThread(threadId: string): Promise<boolean> {
    return singleFlightOperations.run(`thread:fork:${threadId}`, () => forkThreadOnce(threadId));
  }

  async function forkThreadOnce(threadId: string): Promise<boolean> {
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
      replaceAgentThreadFamily(page.thread, page.agentThreads);
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
        setError("The active turn is not associated with an open task.");
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
      setError("Open a task before adding messages to the queue.");
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
      const runtime = threadRuntime().get(threadId);
      const decision = queuedMessageDispatchDecision(runtime);
      if (decision.type === "startTurn") {
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
          expectedTurnId: decision.turnId,
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

  function interrupt(): Promise<boolean> {
    const thread = currentThread();
    const turnId = activeTurnId();
    if (thread === null || turnId === null) {
      return Promise.resolve(false);
    }
    return singleFlightOperations.run(`turn:interrupt:${thread.id}:${turnId}`, () =>
      interruptOnce(thread.id, turnId),
    );
  }

  async function interruptOnce(threadId: string, turnId: string): Promise<boolean> {
    try {
      await interruptTurn(threadId, turnId);
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  function respondToApproval(requestId: string, decision: ApprovalDecision): Promise<boolean> {
    return singleFlightOperations.run(`approval:respond:${requestId}`, () =>
      respondToApprovalOnce(requestId, decision),
    );
  }

  async function respondToApprovalOnce(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<boolean> {
    try {
      await respondToServerRequest(requestId, decision);
      setPendingApprovals((current) => current.filter((request) => request.id !== requestId));
      notificationCenter.remove(`approval-required:${requestId}`);
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
        throw new Error("The configuration has not loaded yet.");
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

  async function saveSetting(update: ConfigUpdate): Promise<boolean> {
    const saved = await updateSetting(update);
    if (saved) notifySettingsSaved();
    return saved;
  }

  async function requestExternalUrl(url: string): Promise<boolean> {
    try {
      await openExternalUrlCommand(url);
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  async function requestWorkspaceDirectory(path: string): Promise<boolean> {
    try {
      await openWorkspaceDirectoryCommand(path);
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  async function readAttachmentImageSource(path: string): Promise<string> {
    return (await readAttachmentImageCommand(path)).dataUrl;
  }

  function readThreadOutput(outputId: string, cursor: string | null): Promise<OutputReadResponse> {
    return readOutputCommand(outputId, cursor);
  }

  async function saveClipboard(dataBase64: string): Promise<Attachment | null> {
    try {
      return await savePastedImage(dataBase64);
    } catch (reason) {
      reportError(reason);
      return null;
    }
  }

  async function chooseAttachments(): Promise<AttachmentSelectionResult> {
    try {
      const selected = await open({ directory: false, multiple: true });
      if (selected === null) return { type: "cancelled" };
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0 || paths.some((path) => path.length === 0)) {
        throw new Error("The attachment picker returned an invalid path selection.");
      }
      return { type: "selected", attachments: await inspectAttachments(paths) };
    } catch (reason) {
      reportError(reason);
      return { type: "failed", message: describeError(reason) };
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
      setAllAgentThreads((current) => current.filter((thread) => thread.id !== threadId));
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
      replaceAgentThreadFamily(page.thread, page.agentThreads);
      if (page.thread.status.type !== "active") {
        void scheduleQueuedMessage(threadId);
      }
    } catch (reason) {
      reportError(reason);
    }
  }

  function mergeThread(thread: ThreadSummary): void {
    batch(() => {
      const next = upsertTaskThread(
        { rootThreads: threads(), agentThreads: allAgentThreads() },
        thread,
      );
      setThreads(next.rootThreads);
      setAllAgentThreads(next.agentThreads);
    });
  }

  function replaceAgentThreadFamily(thread: ThreadSummary, family: readonly ThreadSummary[]): void {
    setAllAgentThreads((current) => replaceTaskAgentFamily(current, thread, family));
  }

  function updateThreadSummary(
    threadId: string,
    update: (thread: ThreadSummary) => ThreadSummary,
  ): void {
    batch(() => {
      const next = updateTaskThread(
        { rootThreads: threads(), agentThreads: allAgentThreads() },
        threadId,
        update,
      );
      setThreads(next.rootThreads);
      setAllAgentThreads(next.agentThreads);
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
    const summary = [...threads(), ...archivedThreads(), ...allAgentThreads()].find(
      (thread) => thread.id === threadId,
    );
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
      reportError(reason);
      threadPages.delete(threadId);
      if (currentThread()?.id === threadId) {
        throw reason;
      }
    }
  }

  let pendingThreadSelectionId: string | null = null;
  let threadSelectionRevision = 0;

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

  createNotificationOverlayBridge({
    approvalFor: notificationCenter.approvalFor,
    priority: notificationCenter.priority,
    transient: notificationCenter.transient,
    dismiss: notificationCenter.dismiss,
    targetFor: notificationCenter.targetFor,
    onActivate: (target) => {
      if (target.type === "settings") {
        setNotificationUsageSettingsRequest((current) => current + 1);
      } else {
        void openThread(target.threadId);
      }
    },
    reportError,
    respondToApproval,
  });

  return {
    account,
    accountProfile: accountUsage.accountProfile,
    accountProfileError: accountUsage.accountProfileError,
    accountProfileLoading: accountUsage.accountProfileLoading,
    activePlan,
    activeTaskRootId,
    activeTurnId,
    agentThreads,
    approvals,
    applicationPreferences: preferences.applicationPreferences,
    applicationPreferencesError: preferences.applicationPreferencesError,
    applicationPreferencesLoaded: preferences.applicationPreferencesLoaded,
    applicationPreferencesSaving: preferences.applicationPreferencesSaving,
    applicationShellActionRequest,
    archivedThreads: visibleArchivedThreads,
    archivedThreadsLoaded,
    archivedThreadsLoading,
    archivedThreadsNextCursor,
    automations: automationSession.automations,
    automationRuns: automationSession.automationRuns,
    automationsLoading: automationSession.automationsLoading,
    busy,
    config,
    contextUsage,
    currentThread,
    hasOlderHistory,
    historyLoading,
    product,
    chatGptMode,
    chatModels: modelCatalog.chatModels,
    conversationMode,
    diagnostics,
    engine,
    error,
    lastTurnFailure,
    loginPending,
    models: modelCatalog.models,
    modelReroute,
    modelVerifications,
    pendingOperations,
    pinnedProjectPaths,
    pinnedThreadIds,
    persistedTurns,
    projectSectionExpanded,
    projects,
    queuedMessages,
    rateLimits: accountUsage.rateLimits,
    rateLimitsError: accountUsage.rateLimitsError,
    rateLimitsLoading: accountUsage.rateLimitsLoading,
    usageResets: accountUsage.usageResets,
    usageResetsError: accountUsage.usageResetsError,
    usageResetsLoading: accountUsage.usageResetsLoading,
    usageResetRedeemingId: accountUsage.usageResetRedeemingId,
    notificationUsageSettingsRequest,
    autoTopUpSettings: accountUsage.autoTopUpSettings,
    autoTopUpError: accountUsage.autoTopUpError,
    autoTopUpLoading: accountUsage.autoTopUpLoading,
    runtimeStatus,
    signedIn,
    safetyBuffering,
    threads: visibleThreads,
    threadsNextCursor,
    turnBusy,
    turns,
    unreadAutomationRuns: automationSession.unreadAutomationRuns,
    workspace,
    archiveThread,
    cancelLogin,
    chooseAttachments,
    chooseWorkspace,
    clearError: () => setError(null),
    createAutomation: automationSession.createAutomation,
    deleteAutomation: automationSession.deleteAutomation,
    deleteThread,
    deleteQueuedMessage,
    ensureModelsForMode: modelCatalog.ensureModelsForMode,
    enqueueMessage,
    forkThread,
    interrupt,
    isItemStreaming,
    projectExpanded,
    projectThreadListExpanded,
    previewNotification,
    isThreadActive,
    loadMoreThreads,
    loadMoreArchivedThreads,
    loadOlderHistory,
    login,
    logout,
    markAutomationRunReviewed: automationSession.markAutomationRunReviewed,
    newThread,
    openExternalUrl: requestExternalUrl,
    openThread,
    openWorkspaceDirectory: requestWorkspaceDirectory,
    readAttachmentImage: readAttachmentImageSource,
    readThreadOutput,
    refreshAutomations: automationSession.refreshAutomations,
    refreshAccountProfile: accountUsage.refreshAccountProfile,
    refreshRateLimits: accountUsage.refreshRateLimits,
    refreshRateLimitsIfStale: accountUsage.refreshRateLimitsIfStale,
    refreshUsageResets: accountUsage.refreshUsageResets,
    redeemUsageReset: accountUsage.redeemUsageReset,
    refreshAutoTopUpSettings: accountUsage.refreshAutoTopUpSettings,
    enableAutoTopUp: accountUsage.enableAutoTopUp,
    updateAutoTopUp: accountUsage.updateAutoTopUp,
    disableAutoTopUp: accountUsage.disableAutoTopUp,
    reportError,
    removeProject: removeProjectFromSidebar,
    renameThread,
    retryInitialization,
    respondToApproval,
    runAutomationNow: automationSession.runAutomationNow,
    saveSetting,
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
    updateAutomation: automationSession.updateAutomation,
    updateProject,
    updateSetting,
    updateApplicationPreferences: preferences.updateApplicationPreferences,
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
          turnId: notification.params.turnId,
          itemId: delta.itemId,
          delta: delta.delta,
        };
      case "commandOutput":
        return {
          kind: "commandOutput",
          threadId: notification.params.threadId,
          turnId: notification.params.turnId,
          itemId: delta.itemId,
          stream: delta.stream,
          operation: delta.operation,
        };
      case "reasoningSummary":
      case "reasoningText":
        return {
          kind: "reasoningText",
          threadId: notification.params.threadId,
          turnId: notification.params.turnId,
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
  throw new Error(`Unhandled notification state: ${JSON.stringify(value)}`);
}

function accountSessionKey(value: AccountReadResponse | undefined): string | null {
  const currentAccount = value?.account;
  return currentAccount === null || currentAccount === undefined
    ? null
    : (currentAccount.email ?? "chatgpt");
}
