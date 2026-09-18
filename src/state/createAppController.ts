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
  AccountProfileResponse,
  AccountReadResponse,
  AppProduct,
  ChatGptMode,
  ConfigReadResponse,
  ConfigUpdate,
  EngineNotification,
  EngineServerRequest,
  EngineStartResponse,
  OutputReadResponse,
  RuntimeDiagnostic,
  RuntimeStatus,
} from "../contracts/types";
import type { TranslationMessages } from "../i18n/messages";
import {
  cancelLogin as cancelLoginCommand,
  describeDiagnosticError,
  describeError,
  inspectAttachments,
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
  reportFrontendDiagnostic,
  savePastedImage,
  startEngine,
  subscribeToEvents,
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
  ClipboardImageResult,
  DiagnosticEntry,
} from "./appController";
import { createApplicationPreferencesController } from "./applicationPreferencesController";
import { assertNever } from "./assertNever";
import { createAutomationSessionController } from "./automationSessionController";
import { type SessionControllerHost, settledQueueTail, withBootTimeout } from "./controllerSupport";
import { createModelCatalogController } from "./modelCatalogController";
import { createNavigationSessionController } from "./navigationSessionController";
import { createNotificationOverlayBridge } from "./notificationOverlayBridge";
import { createNotificationSessionController } from "./notificationSessionController";
import {
  activeConversationMode,
  selectChatGptMode as reduceSelectChatGptMode,
  selectProduct as reduceSelectProduct,
  rememberConversationDestination,
} from "./productFlow";
import { pathsEqual } from "./projects";
import { SingleFlightOperations } from "./singleFlightOperations";
import { createTaskSessionController } from "./taskSessionController";
import { type UiError, uiError } from "./uiError";

const MAX_DIAGNOSTICS = 50;
const EVENT_SUBSCRIPTION_TIMEOUT_MS = 15_000;
const ENGINE_START_TIMEOUT_MS = 120_000;
const ACCOUNT_READ_TIMEOUT_MS = 45_000;

interface AppControllerLocalization {
  readonly confirmations: Accessor<TranslationMessages["confirmations"]>;
  readonly nativeMenu: Accessor<TranslationMessages["nativeMenu"]>;
  readonly notifications: Accessor<TranslationMessages["notifications"]>;
}

export function createAppController(localization: AppControllerLocalization): AppController {
  const [runtimeStatus, setRuntimeStatus] = createSignal<RuntimeStatus>({
    state: "starting",
    message: null,
  });
  const [engine, setEngine] = createSignal<EngineStartResponse | null>(null);
  const [account, setAccount] = createSignal<AccountReadResponse>();
  const [config, setConfig] = createSignal<ConfigReadResponse | null>(null);
  const [applicationShellActionRequest, setApplicationShellActionRequest] =
    createSignal<ApplicationShellActionRequest | null>(null);
  const [diagnostics, setDiagnostics] = createSignal<readonly DiagnosticEntry[]>([]);
  const [error, setError] = createSignal<UiError | null>(null);
  const [pendingOperations, setPendingOperations] = createSignal(0);
  let diagnosticSequence = 0;
  let disposed = false;
  const singleFlightOperations = new SingleFlightOperations<string, boolean>();

  function addDiagnostic(diagnostic: RuntimeDiagnostic): void {
    diagnosticSequence += 1;
    const entry: DiagnosticEntry = {
      ...diagnostic,
      id: diagnosticSequence,
      occurredAt: new Date(),
    };
    setDiagnostics((current) => [...current.slice(-(MAX_DIAGNOSTICS - 1)), entry]);
  }

  function recordDiagnostic(message: string): void {
    addDiagnostic({ stream: "runtime", message });
    if (engine() !== null) {
      void reportFrontendDiagnostic(message).catch((persistenceFailure: unknown) => {
        addDiagnostic({
          stream: "runtime",
          message: `Failed to persist frontend diagnostic: ${describeError(persistenceFailure)}`,
        });
      });
    }
  }

  function reportError(reason: unknown): void {
    const message = describeError(reason);
    const diagnostic = describeDiagnosticError(reason);
    setError(uiError("unexpected", message));
    recordDiagnostic(diagnostic);
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

  const navigation = createNavigationSessionController({ host: sessionHost });

  const [notificationUsageSettingsRequest, setNotificationUsageSettingsRequest] = createSignal(0);
  const [loginPending, setLoginPending] = createSignal(false);
  let loginId: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let unsubscribeFromMenu: (() => void) | null = null;
  let applicationShellActionSequence = 0;
  let initializationRevision = 0;
  let configQueue: Promise<void> = Promise.resolve();
  let authenticationSync: {
    readonly expectedSignedIn: boolean;
    readonly promise: Promise<void>;
  } | null = null;
  let authenticatedStateLoaded = false;
  let authenticatedStateRequest: Promise<void> | null = null;
  const modelCatalog = createModelCatalogController({
    host: sessionHost,
    isSignedIn: () => signedIn(),
  });

  function notifySettingsSaved(): void {
    notifications.notifySettingsSaved();
  }

  const preferences = createApplicationPreferencesController({
    isDisposed: () => disposed,
    onSaved: notifySettingsSaved,
    reportError,
  });

  const notifications = createNotificationSessionController({
    applicationPreferences: preferences.applicationPreferences,
    applicationPreferencesLoaded: preferences.applicationPreferencesLoaded,
    localization: { notifications: localization.notifications },
    taskLabels: () => [...tasks.threads(), ...tasks.allAgentThreads()],
  });

  const accountUsage = createAccountUsageController({
    account,
    addDiagnostic,
    applyAccountProfile: (profile: AccountProfileResponse) => {
      setAccount((current) => mergeAccountProfile(current, profile));
    },
    enqueueNotification: notifications.enqueue,
    host: sessionHost,
    isSignedIn: () => signedIn(),
    localization: { notifications: localization.notifications },
    onLunaReserveChanged: () => {
      modelCatalog.invalidateCatalogs();
      void modelCatalog.ensureModelsForMode(navigation.conversationMode());
    },
  });

  const automationSession = createAutomationSessionController({
    confirmations: localization.confirmations,
    host: sessionHost,
    isSignedIn: () => signedIn(),
  });

  const tasks = createTaskSessionController({
    confirmations: localization.confirmations,
    host: sessionHost,
    navigation,
    notifications: {
      notifyTurnCompletion: notifications.notifyTurnCompletion,
      removeApprovalNotification: notifications.removeApprovalNotification,
    },
    onUsageMayBeStale: () => {
      void accountUsage.refreshRateLimitsIfStale();
    },
  });

  const visibleThreads = createMemo(() =>
    tasks
      .threads()
      .filter((thread) =>
        navigation.product() === "codex" ? thread.mode === "codex" : thread.mode !== "codex",
      ),
  );
  const visibleArchivedThreads = createMemo(() =>
    tasks
      .archivedThreads()
      .filter((thread) =>
        navigation.product() === "codex" ? thread.mode === "codex" : thread.mode !== "codex",
      ),
  );
  const signedIn = createMemo(() => account()?.account !== null && account() !== undefined);

  const busy = createMemo(() => tasks.turnBusy() || pendingOperations() > 0);

  createEffect(() => {
    const mode = navigation.conversationMode();
    if (signedIn()) {
      void modelCatalog.ensureModelsForMode(mode);
    }
  });

  createEffect(() => {
    const translation = localization.nativeMenu();
    if (isDesktopRuntime()) void synchronizeApplicationMenu(translation).catch(reportError);
  });

  function publishApplicationShellAction(type: ApplicationShellActionRequest["type"]): void {
    applicationShellActionSequence += 1;
    setApplicationShellActionRequest({ sequence: applicationShellActionSequence, type });
  }

  function handleServerRequest(request: EngineServerRequest): void {
    tasks.addPendingApproval(request);
    notifications.notifyApprovalRequired(request);
  }

  onMount(() => {
    accountUsage.start();
    for (const failure of navigation.initializationFailures) {
      reportError(failure);
    }
    for (const failure of tasks.initializationFailures) {
      reportError(failure);
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
    accountUsage.dispose();
    tasks.dispose();
    notifications.dispose();
    unsubscribe?.();
    unsubscribe = null;
    unsubscribeFromMenu?.();
    unsubscribeFromMenu = null;
  });

  function beginInitialization(): void {
    if (disposed) {
      return;
    }
    const revision = ++initializationRevision;
    void initialize(revision);
  }

  async function initialize(revision: number): Promise<void> {
    if (!isCurrentInitialization(revision)) {
      return;
    }
    unsubscribe?.();
    unsubscribe = null;
    let acceptingEvents = true;
    const acceptsEvent = () => acceptingEvents && isCurrentInitialization(revision);
    const subscription = subscribeToEvents({
      onContractError: (reason) => {
        if (acceptsEvent()) reportError(reason);
      },
      onDiagnostic: (diagnostic) => {
        if (acceptsEvent()) addDiagnostic(diagnostic);
      },
      onNotification: (notification) => {
        if (acceptsEvent()) handleNotification(notification);
      },
      onServerRequest: (request) => {
        if (acceptsEvent()) handleServerRequest(request);
      },
      onStatus: (status) => {
        if (acceptsEvent()) handleRuntimeStatus(status);
      },
    });
    let releaseEvents: (() => void) | null = null;
    try {
      const release = await withBootTimeout(
        "register engine events",
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
      const currentAccount = await withBootTimeout(
        "read the signed-in account",
        ACCOUNT_READ_TIMEOUT_MS,
        () => readAccount(),
      );
      if (!isCurrentInitialization(revision)) {
        return;
      }
      applyAccountSession(currentAccount);
      if (currentAccount.account !== null) {
        void accountUsage.refreshAccountProfile();
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
      acceptingEvents = false;
      if (releaseEvents !== null && unsubscribe === releaseEvents) {
        unsubscribe = null;
        releaseEvents();
      }
      recordDiagnostic(describeDiagnosticError(reason));
      batch(() => {
        setEngine(null);
        setAccount(undefined);
        setConfig(null);
        accountUsage.applySignedOut();
        setError(uiError("unexpected", message));
        setRuntimeStatus({ state: "failed", message });
      });
    } finally {
      if (releaseEvents === null) {
        acceptingEvents = false;
        void subscription.then(
          (release) => release(),
          () => undefined,
        );
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
      const detail = currentAccount.refresh.error ?? undefined;
      setError(uiError("unexpected", detail));
      recordDiagnostic(detail ?? "The ChatGPT session refresh failed.");
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
        tasks.applyThreadPage(threadPage);
        automationSession.loadSession(automationSnapshot);
      });
      await tasks.restoreDestination(navigation.productFlow());
      const loaded = !disposed && accountSessionKey(account()) === expectedSessionKey;
      if (loaded) {
        tasks.resumePersistedMessageQueues(threadPage.data);
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
    tasks.invalidateAuthenticatedStateLoad();
    automationSession.clearSession();
  }

  function handleNotification(notification: EngineNotification): void {
    if (notification.method === "item.streamDeltas") {
      tasks.applyStreamNotification(notification);
      return;
    }
    batch(() => {
      tasks.flushStreamDeltas();
      handleSemanticNotification(notification);
    });
  }

  function handleSemanticNotification(
    notification: Exclude<EngineNotification, { readonly method: "item.streamDeltas" }>,
  ): void {
    switch (notification.method) {
      case "auth.loginCompleted":
        if (notification.params.loginId !== loginId) {
          throw new Error("The engine completed a login other than the active flow.");
        }
        loginId = null;
        setLoginPending(false);
        if (!notification.params.success) {
          const detail = notification.params.error ?? undefined;
          setError(uiError("loginFailed", detail));
          recordDiagnostic(detail ?? "The ChatGPT login did not complete.");
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
      case "thread.archived":
      case "thread.unarchived":
      case "thread.deleted":
      case "turn.started":
      case "turn.completed":
      case "model.rerouted":
      case "model.verification":
      case "model.safetyBufferingUpdated":
      case "item.started":
      case "item.completed":
        tasks.applyNotification(notification);
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
      tasks.resetSession();
      batch(() => {
        setAccount({
          account: null,
          requiresOpenaiAuth: true,
          refresh: { status: "notRequired", error: null },
        });
        accountUsage.applySignedOut();
      });
      if (response.remoteRevocation === "failed") {
        const detail = response.remoteRevocationError ?? undefined;
        setError(uiError("remoteRevocationFailed", detail));
        recordDiagnostic(detail ?? "Remote ChatGPT session revocation failed.");
      }
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
    }
  }

  async function chooseWorkspace(): Promise<string | null> {
    if (navigation.conversationMode() === "chat") {
      setError(uiError("chatProjectsUnsupported"));
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

  async function selectProduct(nextProduct: AppProduct): Promise<boolean> {
    const current = navigation.productFlow();
    if (current.product === nextProduct) {
      return true;
    }
    const withCurrentDestination = rememberConversationDestination(
      current,
      activeConversationMode(current),
      {
        threadId: tasks.currentThread()?.id ?? null,
        workspace: navigation.workspace(),
      },
    );
    const next = reduceSelectProduct(withCurrentDestination, nextProduct);
    if (!navigation.commitProductFlow(next)) {
      return false;
    }
    return tasks.restoreDestination(next);
  }

  async function selectChatGptMode(nextMode: ChatGptMode): Promise<boolean> {
    const current = navigation.productFlow();
    if (current.product === "chatgpt" && current.chatGptMode === nextMode) {
      return true;
    }
    const withCurrentDestination = rememberConversationDestination(
      current,
      activeConversationMode(current),
      {
        threadId: tasks.currentThread()?.id ?? null,
        workspace: navigation.workspace(),
      },
    );
    const next = reduceSelectChatGptMode(withCurrentDestination, nextMode);
    if (!navigation.commitProductFlow(next)) {
      return false;
    }
    return tasks.restoreDestination(next);
  }

  function selectProject(path: string): boolean {
    if (navigation.conversationMode() === "chat") {
      setError(uiError("chatProjectsAssociation"));
      return false;
    }
    const thread = tasks.currentThread();
    const changesConversation = thread !== null && !pathsEqual(thread.projectPath, path);
    if (!navigation.addProjectPath(path)) {
      return false;
    }
    if (changesConversation) {
      tasks.clearCurrentThread();
    }
    return navigation.rememberDestination(
      navigation.conversationMode(),
      changesConversation ? null : (thread?.id ?? null),
      path,
    );
  }

  function togglePinnedThread(threadId: string): void {
    if (!tasks.threads().some((thread) => thread.id === threadId)) {
      setError(uiError("taskUnavailable"));
      return;
    }
    navigation.togglePinnedThread(threadId);
  }

  function newThread(targetWorkspace?: string): boolean {
    const mode = navigation.conversationMode();
    if (signedIn()) {
      void modelCatalog.ensureModelsForMode(mode);
    }
    const requestedWorkspace = mode === "chat" ? null : (targetWorkspace ?? null);
    if (requestedWorkspace === null) {
      batch(() => {
        navigation.setWorkspace(null);
        tasks.clearCurrentThread();
      });
      return navigation.rememberDestination(mode, null, null);
    }
    if (!selectProject(requestedWorkspace)) {
      return false;
    }
    tasks.clearCurrentThread();
    return navigation.rememberDestination(mode, null, requestedWorkspace);
  }

  async function updateSetting(update: ConfigUpdate): Promise<boolean> {
    let succeeded = false;
    const operation = configQueue.then(async () => {
      const current = config();
      if (current === null) {
        setError(uiError("configurationNotLoaded"));
        return;
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

  async function saveClipboard(dataBase64: string): Promise<ClipboardImageResult> {
    try {
      return { attachment: await savePastedImage(dataBase64), type: "saved" };
    } catch (reason) {
      reportError(reason);
      return { error: uiError("imageUnavailable"), type: "failed" };
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
      return { type: "failed", error: uiError("attachmentSelectionFailed") };
    }
  }

  createNotificationOverlayBridge({
    approvalFor: notifications.approvalFor,
    priority: notifications.priority,
    transient: notifications.transient,
    dismiss: notifications.dismiss,
    targetFor: notifications.targetFor,
    onActivate: (target) => {
      if (target.type === "settings") {
        setNotificationUsageSettingsRequest((current) => current + 1);
      } else {
        void tasks.openThread(target.threadId);
      }
    },
    reportError,
    respondToApproval: tasks.respondToApproval,
  });

  return {
    account,
    accountProfile: accountUsage.accountProfile,
    accountProfileError: accountUsage.accountProfileError,
    accountProfileLoading: accountUsage.accountProfileLoading,
    activePlan: tasks.activePlan,
    activeTaskRootId: tasks.activeTaskRootId,
    activeTurnId: tasks.activeTurnId,
    agentThreads: tasks.agentThreads,
    approvals: tasks.approvals,
    applicationPreferences: preferences.applicationPreferences,
    applicationPreferencesError: preferences.applicationPreferencesError,
    applicationPreferencesLoaded: preferences.applicationPreferencesLoaded,
    applicationPreferencesSaving: preferences.applicationPreferencesSaving,
    applicationShellActionRequest,
    archivedThreads: visibleArchivedThreads,
    archivedThreadsLoaded: tasks.archivedThreadsLoaded,
    archivedThreadsLoading: tasks.archivedThreadsLoading,
    archivedThreadsNextCursor: tasks.archivedThreadsNextCursor,
    automations: automationSession.automations,
    automationRuns: automationSession.automationRuns,
    automationsLoading: automationSession.automationsLoading,
    busy,
    config,
    contextUsage: tasks.contextUsage,
    currentThread: tasks.currentThread,
    hasOlderHistory: tasks.hasOlderHistory,
    historyLoading: tasks.historyLoading,
    product: navigation.product,
    chatGptMode: navigation.chatGptMode,
    chatModels: modelCatalog.chatModels,
    conversationMode: navigation.conversationMode,
    diagnostics,
    engine,
    error,
    lastTurnFailure: tasks.lastTurnFailure,
    loginPending,
    models: modelCatalog.models,
    modelReroute: tasks.modelReroute,
    modelVerifications: tasks.modelVerifications,
    pendingOperations,
    pinnedProjectPaths: navigation.pinnedProjectPaths,
    pinnedThreadIds: navigation.pinnedThreadIds,
    persistedTurns: tasks.persistedTurns,
    projectSectionExpanded: navigation.projectSectionExpanded,
    projects: navigation.projects,
    queuedMessages: tasks.queuedMessages,
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
    safetyBuffering: tasks.safetyBuffering,
    threads: visibleThreads,
    threadsNextCursor: tasks.threadsNextCursor,
    turnBusy: tasks.turnBusy,
    turns: tasks.turns,
    unreadAutomationRuns: automationSession.unreadAutomationRuns,
    workspace: navigation.workspace,
    archiveThread: tasks.archiveThread,
    cancelLogin,
    chooseAttachments,
    chooseWorkspace,
    clearError: () => setError(null),
    createAutomation: automationSession.createAutomation,
    deleteAutomation: automationSession.deleteAutomation,
    deleteThread: tasks.deleteThread,
    deleteQueuedMessage: tasks.deleteQueuedMessage,
    ensureModelsForMode: modelCatalog.ensureModelsForMode,
    enqueueMessage: tasks.enqueueMessage,
    forkThread: tasks.forkThread,
    interrupt: tasks.interrupt,
    isItemStreaming: tasks.isItemStreaming,
    projectExpanded: navigation.projectExpanded,
    projectThreadListExpanded: navigation.projectThreadListExpanded,
    previewNotification: notifications.preview,
    isThreadActive: tasks.isThreadActive,
    loadMoreThreads: tasks.loadMoreThreads,
    loadMoreArchivedThreads: tasks.loadMoreArchivedThreads,
    loadOlderHistory: tasks.loadOlderHistory,
    login,
    logout,
    markAutomationRunReviewed: automationSession.markAutomationRunReviewed,
    newThread,
    openExternalUrl: requestExternalUrl,
    openThread: tasks.openThread,
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
    removeProject: navigation.removeProject,
    renameThread: tasks.renameThread,
    retryInitialization,
    respondToApproval: tasks.respondToApproval,
    runAutomationNow: automationSession.runAutomationNow,
    saveSetting,
    saveClipboardImage: saveClipboard,
    selectProject,
    selectProduct,
    selectChatGptMode,
    sendMessage: tasks.sendMessage,
    sendQueuedMessageNow: tasks.sendQueuedMessageNow,
    takeQueuedMessage: tasks.takeQueuedMessage,
    togglePinnedProject: navigation.togglePinnedProject,
    togglePinnedThread,
    toggleProjectExpanded: navigation.toggleProjectExpanded,
    toggleProjectSection: navigation.toggleProjectSection,
    toggleProjectThreadListExpanded: navigation.toggleProjectThreadListExpanded,
    updateAutomation: automationSession.updateAutomation,
    updateProject: navigation.updateProject,
    updateSetting,
    updateApplicationPreferences: preferences.updateApplicationPreferences,
    unarchiveThread: tasks.unarchiveThread,
  };
}

function accountSessionKey(value: AccountReadResponse | undefined): string | null {
  const currentAccount = value?.account;
  return currentAccount === null || currentAccount === undefined
    ? null
    : (currentAccount.email ?? "chatgpt");
}
