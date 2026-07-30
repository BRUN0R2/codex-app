import { open } from "@tauri-apps/plugin-dialog";
import {
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
} from "solid-js";

import {
  archiveThread as archiveCodexThread,
  cancelLogin as cancelChatGptLogin,
  describeCommandError,
  inspectAttachments,
  interruptTurn,
  listModels,
  loginWithChatGpt,
  logout,
  openExternalUrl,
  readAccount,
  readAccountRateLimits,
  readConfig,
  readConfigRequirements,
  readWindowsSandboxReadiness,
  respondToServerRequest,
  resumeThread as resumeCodexThread,
  savePastedImage,
  startRuntime,
  startThread,
  startTurn,
  startWindowsSandboxSetup,
  subscribeToCodexEvents,
  setThreadName,
  writeConfig,
  writeConfigBatch,
} from "../../shared/codex/client";
import {
  mergeAccountRateLimitsUpdate,
  parseAccountRateLimitsUpdatedNotification,
} from "../../shared/codex/rateLimits";
import type { AccountRateLimitsResponse } from "../../shared/codex/rateLimitTypes";
import {
  isJsonObject,
  readString,
  type AccountReadResponse,
  type Attachment,
  type CodexModel,
  type CodexNotification,
  type CodexServerRequest,
  type CodexThread,
  type ConfigReadResponse,
  type ConfigRequirementsReadResponse,
  type ConfigEditRequest,
  type JsonObject,
  type JsonValue,
  type ModelListResponse,
  type NativeLogoutResponse,
  type RuntimeDiagnostic,
  type RuntimeStartResponse,
  type RuntimeStatus,
  type WindowsSandboxReadinessResponse,
  type WindowsSandboxSetupCompletedNotification,
  type WindowsSandboxSetupMode,
  type WindowsWorldWritableWarningNotification,
} from "../../shared/codex/types";
import { createTimeline } from "../chat/createTimeline";
import {
  createTurnProgress,
  type TurnProgressSummary,
} from "../chat/createTurnProgress";
import type { MessageEntry, TimelineEntry } from "../chat/timelineTypes";
import { createServerRequestQueue } from "../approvals/createServerRequestQueue";
import type {
  InteractiveServerRequest,
  PendingServerRequest,
  ServerResponseFor,
} from "../approvals/serverRequestTypes";
import { createProjectWorkspace } from "../projects/createProjectWorkspace";
import { createThreadLibrary } from "../projects/createThreadLibrary";
import { pathsEqual, type ProjectRecord } from "../projects/projectStore";
import { threadTitle, type ThreadLibraryState } from "../projects/threadLibrary";
import { parseConfigWarning } from "../notices/configWarningProtocol";
import {
  createAppNoticeCenter,
  type AppNotice,
} from "../notices/createAppNoticeCenter";
import { createThreadNoticeLibrary } from "../notices/createThreadNoticeLibrary";
import { modelVerificationWarnings } from "../notices/modelVerificationNotice";
import {
  parseDeprecationNotice,
  parseGuardianWarningNotification,
  parseModelVerificationNotification,
  parseWarningNotification,
} from "../notices/runtimeNoticeProtocol";
import {
  isActiveThreadTarget,
  isRequestVisibleForThread,
  readRequiredNotificationThreadId,
} from "./threadNotificationRouting";
import {
  parseWindowsWorldWritableWarning,
  WORLD_WRITABLE_WARNING_CONFIG_KEY,
} from "../security/windowsWorldWritableWarningProtocol";

export type CompatibilityContextState = "failed" | "idle" | "loading" | "ready";
export type AccountRateLimitsState = "failed" | "idle" | "loading" | "ready";
export type WindowsSandboxSetupState =
  | { type: "failed"; error: string; mode: WindowsSandboxSetupMode }
  | { type: "idle" }
  | { type: "running"; mode: WindowsSandboxSetupMode }
  | { type: "starting"; mode: WindowsSandboxSetupMode }
  | { type: "succeeded"; mode: WindowsSandboxSetupMode };
export type WindowsWorldWritableWarningState =
  | {
      type: "failed";
      error: string;
      warning: WindowsWorldWritableWarningNotification;
    }
  | { type: "idle" }
  | {
      type: "pending";
      warning: WindowsWorldWritableWarningNotification;
    }
  | {
      type: "persisting";
      warning: WindowsWorldWritableWarningNotification;
    };

export interface CodexSession {
  account: Accessor<AccountReadResponse | undefined>;
  accountRateLimits: Accessor<AccountRateLimitsResponse | null>;
  accountRateLimitsState: Accessor<AccountRateLimitsState>;
  activeTurnId: Accessor<string | null>;
  pendingServerRequests: Accessor<PendingServerRequest[]>;
  busy: Accessor<boolean>;
  compatibilityContextState: Accessor<CompatibilityContextState>;
  config: Accessor<ConfigReadResponse | null>;
  appNotices: Accessor<readonly AppNotice[]>;
  appNoticesOmitted: Accessor<number>;
  configRequirements: Accessor<ConfigRequirementsReadResponse | null>;
  windowsSandboxReadiness: Accessor<WindowsSandboxReadinessResponse | null>;
  windowsSandboxSetupState: Accessor<WindowsSandboxSetupState>;
  worldWritableWarningState: Accessor<WindowsWorldWritableWarningState>;
  diagnostics: Accessor<RuntimeDiagnostic[]>;
  error: Accessor<string | null>;
  loginPending: Accessor<boolean>;
  models: Accessor<CodexModel[]>;
  openingThreadId: Accessor<string | null>;
  projects: Accessor<ProjectRecord[]>;
  runtime: Accessor<RuntimeStartResponse | null>;
  runtimeStatus: Accessor<RuntimeStatus>;
  signedIn: Accessor<boolean>;
  threadId: Accessor<string | null>;
  threadLibraryState: Accessor<ThreadLibraryState>;
  threads: Accessor<CodexThread[]>;
  threadsNextCursor: Accessor<string | null>;
  currentThreadTitle: Accessor<string>;
  timeline: Accessor<TimelineEntry[]>;
  turnProgress: Accessor<TurnProgressSummary | null>;
  workspace: Accessor<string | null>;
  chooseWorkspace: () => Promise<void>;
  clearError: () => void;
  dismissAppNotice: (notice: AppNotice) => void;
  cancelLogin: () => Promise<void>;
  inspectFiles: (paths: string[]) => Promise<Attachment[]>;
  interrupt: () => Promise<void>;
  interruptPendingRequest: (request: PendingServerRequest) => Promise<void>;
  login: () => Promise<void>;
  loadCompatibilityContext: () => Promise<void>;
  loadMoreThreads: () => Promise<void>;
  logout: () => Promise<void>;
  newThread: () => void;
  newThreadForProject: (path: string) => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  archiveThread: (threadId: string) => Promise<void>;
  removeProject: (path: string) => Promise<void>;
  renameThread: (threadId: string, name: string) => Promise<boolean>;
  refreshConfig: () => Promise<void>;
  refreshAccountRateLimits: () => Promise<void>;
  respondToInteractiveRequest: <T extends InteractiveServerRequest>(
    request: T,
    response: ServerResponseFor<T>,
  ) => Promise<boolean>;
  resolveWorldWritableWarning: (remember: boolean) => Promise<boolean>;
  saveClipboardImage: (dataBase64: string) => Promise<Attachment>;
  selectProject: (path: string) => Promise<void>;
  sendMessage: (text: string, attachments: Attachment[]) => Promise<boolean>;
  setupWindowsSandbox: (mode: WindowsSandboxSetupMode) => Promise<boolean>;
  writeSetting: (
    keyPath: string,
    value: JsonValue,
    mergeStrategy: "replace" | "upsert",
  ) => Promise<void>;
  writeSettings: (edits: ConfigEditRequest[]) => Promise<void>;
}

function isSignedInAccount(
  snapshot: AccountReadResponse | undefined,
): snapshot is AccountReadResponse {
  return (
    snapshot !== undefined &&
    (snapshot.account !== null || !snapshot.requiresOpenaiAuth)
  );
}

function isChatGptSession(
  snapshot: AccountReadResponse | undefined,
): snapshot is AccountReadResponse {
  return snapshot?.account?.type === "chatgpt";
}

export function createCodexSession(): CodexSession {
  const projectWorkspace = createProjectWorkspace();
  const [runtime, setRuntime] = createSignal<RuntimeStartResponse | null>(null);
  const [runtimeStatus, setRuntimeStatus] = createSignal<RuntimeStatus>({
    state: "starting",
    message: null,
  });
  const [account, setAccount] = createSignal<AccountReadResponse>();
  const [accountRateLimits, setAccountRateLimits] =
    createSignal<AccountRateLimitsResponse | null>(null);
  const [accountRateLimitsState, setAccountRateLimitsState] =
    createSignal<AccountRateLimitsState>("idle");
  const [loginPending, setLoginPending] = createSignal(false);
  const [threadId, setThreadId] = createSignal<string | null>(null);
  const [activeTurnId, setActiveTurnId] = createSignal<string | null>(null);
  const [openingThreadId, setOpeningThreadId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const serverRequests = createServerRequestQueue();
  const pendingServerRequests = createMemo(() =>
    serverRequests
      .pending()
      .filter((request) =>
        isRequestVisibleForThread(request.threadId, threadId()),
      ),
  );
  const appNotices = createAppNoticeCenter();
  const threadNotices = createThreadNoticeLibrary({
    reportDiagnostic: (message) => addDiagnostic("stderr", message),
  });
  const [compatibilityContextState, setCompatibilityContextState] =
    createSignal<CompatibilityContextState>("idle");
  const [config, setConfig] = createSignal<ConfigReadResponse | null>(null);
  const [configRequirements, setConfigRequirements] =
    createSignal<ConfigRequirementsReadResponse | null>(null);
  const [windowsSandboxReadiness, setWindowsSandboxReadiness] =
    createSignal<WindowsSandboxReadinessResponse | null>(null);
  const [windowsSandboxSetupState, setWindowsSandboxSetupState] =
    createSignal<WindowsSandboxSetupState>({ type: "idle" });
  const [worldWritableWarningState, setWorldWritableWarningState] =
    createSignal<WindowsWorldWritableWarningState>({ type: "idle" });
  const [models, setModels] = createSignal<CodexModel[]>([]);
  const [diagnostics, setDiagnostics] = createSignal<RuntimeDiagnostic[]>([]);
  const [error, setError] = createSignal<string | null>(
    projectWorkspace.loadWarning,
  );

  const signedIn = createMemo(() => isSignedInAccount(account()));
  const workspace = projectWorkspace.path;
  let disposed = false;
  const timeline = createTimeline({
    reportProtocolError: (message) => addDiagnostic("stderr", message),
  });
  const turnProgress = createTurnProgress();
  const threadLibrary = createThreadLibrary({
    isDisposed: () => disposed,
    reportDiagnostic: (message) => addDiagnostic("stderr", message),
    runtime,
    signedIn,
  });
  const currentThreadTitle = createMemo(() => {
    const currentThreadId = threadId();
    if (currentThreadId !== null) {
      const current = threadLibrary
        .threads()
        .find((thread) => thread.id === currentThreadId);
      if (current !== undefined) {
        return threadTitle(current);
      }
    }
    const firstUserMessage = timeline.entries().find(
      (entry): entry is MessageEntry => entry.type === "message" && entry.role === "user",
    );
    return firstUserMessage?.text.trim() || "Nova tarefa";
  });

  let disposeEvents: () => void = () => undefined;
  let accountRefreshRequest: Promise<void> | null = null;
  let accountRateLimitsGeneration = 0;
  let accountRateLimitsRequest: Promise<void> | null = null;
  let compatibilityContextGeneration = 0;
  let compatibilityContextRequest: Promise<void> | null = null;
  let pendingLoginId: string | null = null;
  let worldWritableWarningAcknowledgedForSession = false;

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

    if (!started.compatibility.available) {
      if (signedIn()) {
        setCompatibilityContextState("failed");
      }
      addDiagnostic(
        "stderr",
        started.compatibility.reason ??
          "A ponte de compatibilidade do Codex não está disponível.",
      );
    }
  }

  async function loadCompatibilityContext() {
    if (compatibilityContextState() === "ready") {
      return;
    }
    if (compatibilityContextRequest !== null) {
      return compatibilityContextRequest;
    }

    setCompatibilityContextState("loading");
    const generation = compatibilityContextGeneration;
    const request = (async () => {
      const started = runtime();
      if (started === null) {
        throw new Error("A engine nativa ainda não foi inicializada.");
      }
      if (!started.compatibility.available) {
        throw new Error(
          started.compatibility.reason ??
            "A ponte de compatibilidade do Codex não está disponível.",
        );
      }

      const [
        configResponse,
        requirementsResponse,
        sandboxReadinessResponse,
        modelsResponse,
      ] = await Promise.all([
        readConfig({ includeLayers: true, cwd: workspace() }),
        readConfigRequirements(),
        readWindowsSandboxReadiness(),
        listModels(),
      ]);
      if (
        disposed ||
        generation !== compatibilityContextGeneration ||
        !signedIn()
      ) {
        return;
      }
      setConfig(configResponse);
      setConfigRequirements(requirementsResponse);
      setWindowsSandboxReadiness(sandboxReadinessResponse);
      setModels(extractModels(modelsResponse));
      setCompatibilityContextState("ready");
    })();
    compatibilityContextRequest = request;

    try {
      await request;
    } catch (reason) {
      if (!disposed && generation === compatibilityContextGeneration) {
        setCompatibilityContextState("failed");
        addDiagnostic("stderr", describeCommandError(reason));
      }
      throw reason;
    } finally {
      if (compatibilityContextRequest === request) {
        compatibilityContextRequest = null;
      }
    }
  }

  async function refreshAccount() {
    if (accountRefreshRequest !== null) {
      return accountRefreshRequest;
    }

    const request = readAccount().then((response) => {
      setAccount(response);
      if (response.refresh?.status === "failed" && response.refresh.error !== null) {
        addDiagnostic("stderr", response.refresh.error);
      }
      if (!isSignedInAccount(response)) {
        resetCompatibilityContext();
        resetAccountRateLimits();
        setWindowsSandboxSetupState({ type: "idle" });
        setWorldWritableWarningState({ type: "idle" });
        serverRequests.clear();
        threadNotices.clear();
        threadLibrary.reset();
        return;
      }
      prewarmCompatibilityContext();
      threadLibrary.prewarm();
    });
    accountRefreshRequest = request;

    try {
      await request;
    } finally {
      if (accountRefreshRequest === request) {
        accountRefreshRequest = null;
      }
    }
  }

  function refreshAccountInBackground() {
    void refreshAccount().catch((reason) => {
      if (!disposed) {
        setError(describeCommandError(reason));
      }
    });
  }

  function prewarmCompatibilityContext() {
    const started = runtime();
    if (disposed || !signedIn() || started === null) {
      return;
    }
    if (!started.compatibility.available) {
      setCompatibilityContextState("failed");
      return;
    }
    refreshAccountRateLimitsInBackground();
    void loadCompatibilityContext().catch(() => {
      // The loader owns its state and diagnostic; prewarming must not replace
      // an unrelated foreground error.
    });
  }

  function resetCompatibilityContext() {
    compatibilityContextGeneration += 1;
    setCompatibilityContextState("idle");
    setConfig(null);
    setConfigRequirements(null);
    setWindowsSandboxReadiness(null);
    setModels([]);
  }

  function resetAccountRateLimits() {
    accountRateLimitsGeneration += 1;
    setAccountRateLimits(null);
    setAccountRateLimitsState("idle");
  }

  async function refreshAccountRateLimits() {
    if (!isChatGptSession(account())) {
      setAccountRateLimits(null);
      setAccountRateLimitsState("idle");
      return;
    }
    if (accountRateLimitsRequest !== null) {
      return accountRateLimitsRequest;
    }

    const started = runtime();
    if (started === null) {
      throw new Error("A engine nativa ainda não foi inicializada.");
    }
    if (!started.compatibility.available) {
      throw new Error(
        started.compatibility.reason ??
          "A ponte de compatibilidade do Codex não está disponível.",
      );
    }

    const generation = accountRateLimitsGeneration;
    setAccountRateLimitsState("loading");
    const request = readAccountRateLimits().then((response) => {
      if (
        disposed
        || generation !== accountRateLimitsGeneration
        || !isChatGptSession(account())
      ) {
        return;
      }
      setAccountRateLimits(response);
      setAccountRateLimitsState("ready");
    });
    accountRateLimitsRequest = request;

    try {
      await request;
    } catch (reason) {
      if (!disposed && generation === accountRateLimitsGeneration) {
        setAccountRateLimitsState("failed");
        addDiagnostic("stderr", describeCommandError(reason));
      }
      throw reason;
    } finally {
      if (accountRateLimitsRequest === request) {
        accountRateLimitsRequest = null;
      }
    }
  }

  function refreshAccountRateLimitsInBackground() {
    void refreshAccountRateLimits().catch(() => {
      // The usage surface owns its explicit failure state and retry action.
    });
  }

  async function reloadCompatibilityContext() {
    const pendingRequest = compatibilityContextRequest;
    resetCompatibilityContext();
    if (pendingRequest !== null) {
      await pendingRequest.catch(() => undefined);
    }
    if (signedIn()) {
      await loadCompatibilityContext();
    }
  }

  async function loadMoreThreads() {
    try {
      await threadLibrary.loadMore();
    } catch (reason) {
      setError(describeCommandError(reason));
    }
  }

  async function login() {
    setLoginPending(true);
    setError(null);
    try {
      const response = await loginWithChatGpt();
      pendingLoginId = response.loginId;
      try {
        await openExternalUrl(response.authUrl);
      } catch (reason) {
        try {
          await cancelChatGptLogin({ loginId: response.loginId });
        } catch (cancelReason) {
          addDiagnostic("stderr", describeCommandError(cancelReason));
        }
        throw new Error(
          "Não foi possível abrir o navegador para entrar com o ChatGPT.",
          { cause: reason },
        );
      }
    } catch (reason) {
      pendingLoginId = null;
      setLoginPending(false);
      setError(describeCommandError(reason));
    }
  }

  async function cancelPendingLogin() {
    const loginId = pendingLoginId;
    if (loginId === null) {
      return;
    }
    setError(null);
    try {
      await cancelChatGptLogin({ loginId });
      pendingLoginId = null;
      setLoginPending(false);
      await refreshAccount();
    } catch (reason) {
      setError(describeCommandError(reason));
    }
  }

  async function logoutAccount() {
    if (isWindowsSandboxSetupPending(windowsSandboxSetupState())) {
      setError("Aguarde a configuração do sandbox do Windows terminar antes de sair.");
      return;
    }
    setError(null);
    try {
      await Promise.all([
        compatibilityContextRequest?.catch(() => undefined),
        accountRateLimitsRequest?.catch(() => undefined),
        threadLibrary.settle(),
      ]);
      const response = await logout();
      if (
        isNativeLogoutResponse(response) &&
        response.remoteRevocation === "failed" &&
        response.remoteRevocationError !== null
      ) {
        addDiagnostic("stderr", response.remoteRevocationError);
      }
      resetCompatibilityContext();
      resetAccountRateLimits();
      setWindowsSandboxSetupState({ type: "idle" });
      setWorldWritableWarningState({ type: "idle" });
      serverRequests.clear();
      threadNotices.clear();
      threadLibrary.reset();
      setThreadId(null);
      timeline.reset();
      turnProgress.reset();
      await refreshAccount();
    } catch (reason) {
      setError(describeCommandError(reason));
    }
  }

  async function chooseWorkspace() {
    setError(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Selecione a pasta do projeto",
      });
      if (typeof selected !== "string") {
        return;
      }
      await activateProject(selected, true);
    } catch (reason) {
      setError(describeCommandError(reason));
    }
  }

  async function selectProject(path: string) {
    setError(null);
    try {
      await activateProject(path, false);
    } catch (reason) {
      setError(describeCommandError(reason));
    }
  }

  async function newThreadForProject(path: string) {
    setError(null);
    try {
      await activateProject(path, true);
    } catch (reason) {
      setError(describeCommandError(reason));
    }
  }

  async function removeProject(path: string) {
    if (busy() && pathsEqual(workspace(), path)) {
      setError("Interrompa a tarefa atual antes de remover este projeto.");
      return;
    }
    setError(null);
    try {
      const previousWorkspace = workspace();
      projectWorkspace.remove(path);
      if (!pathsEqual(previousWorkspace, workspace())) {
        resetConversation();
        await refreshWorkspaceConfig();
      }
    } catch (reason) {
      setError(describeCommandError(reason));
    }
  }

  async function activateProject(path: string, startFresh: boolean) {
    const workspaceChanged = !pathsEqual(workspace(), path);
    if (!workspaceChanged && !startFresh) {
      return;
    }
    if (busy()) {
      throw new Error(
        workspaceChanged
          ? "Interrompa a tarefa atual antes de trocar de projeto."
          : "Interrompa a tarefa atual antes de iniciar outra tarefa.",
      );
    }
    projectWorkspace.select(path);
    if (workspaceChanged || startFresh) {
      resetConversation();
    }
    if (workspaceChanged) {
      await refreshWorkspaceConfig();
    }
  }

  async function refreshWorkspaceConfig() {
    if (compatibilityContextState() === "ready") {
      await refreshConfig();
    } else {
      await reloadCompatibilityContext();
    }
  }

  function newThread() {
    if (busy()) {
      setError("Interrompa a tarefa atual antes de iniciar outra tarefa.");
      return;
    }
    resetConversation();
    setError(null);
  }

  function resetConversation() {
    setThreadId(null);
    setActiveTurnId(null);
    timeline.reset();
    turnProgress.reset();
  }

  function hydrateThread(thread: CodexThread) {
    setThreadId(thread.id);
    turnProgress.reset();

    let resumedTurnId: string | null = null;
    timeline.hydrate(thread.turns.flatMap((turn) => turn.items));
    timeline.reconcileWarnings(threadNotices.entriesFor(thread.id));
    for (const turn of thread.turns) {
      if (turn.status === "inProgress") {
        resumedTurnId = turn.id;
      }
    }
    setActiveTurnId(resumedTurnId);
    setBusy(thread.status.type === "active" || resumedTurnId !== null);
  }

  async function openThread(requestedThreadId: string) {
    if (openingThreadId() !== null || requestedThreadId === threadId()) {
      return;
    }
    if (busy()) {
      setError("Interrompa a tarefa atual antes de abrir outra tarefa.");
      return;
    }
    setOpeningThreadId(requestedThreadId);
    setError(null);
    try {
      const response = await resumeCodexThread({ threadId: requestedThreadId });
      projectWorkspace.add(response.thread.cwd);
      hydrateThread(response.thread);
      threadLibrary.merge([response.thread]);
      await refreshWorkspaceConfig();
    } catch (reason) {
      setError(describeCommandError(reason));
    } finally {
      setOpeningThreadId(null);
    }
  }

  async function renameThread(threadIdToRename: string, rawName: string) {
    const name = rawName.trim();
    if (name.length === 0) {
      setError("Informe um nome para a tarefa.");
      return false;
    }
    setError(null);
    try {
      await setThreadName({ threadId: threadIdToRename, name });
      threadLibrary.update(threadIdToRename, (thread) => ({ ...thread, name }));
      return true;
    } catch (reason) {
      setError(describeCommandError(reason));
      return false;
    }
  }

  async function archiveThread(threadIdToArchive: string) {
    if (busy() && threadIdToArchive === threadId()) {
      setError("Interrompa a tarefa atual antes de arquivá-la.");
      return;
    }
    setError(null);
    try {
      await archiveCodexThread({ threadId: threadIdToArchive });
      threadLibrary.remove(threadIdToArchive);
      serverRequests.removeForThread(threadIdToArchive);
      threadNotices.remove(threadIdToArchive);
      if (threadIdToArchive === threadId()) {
        resetConversation();
      }
    } catch (reason) {
      setError(describeCommandError(reason));
    }
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
    timeline.addOptimisticUserMessage(clientUserMessageId, text, attachments);
    setBusy(true);
    setError(null);

    try {
      let currentThreadId = threadId();
      if (currentThreadId === null) {
        const response = await startThread({ cwd });
        currentThreadId = response.thread.id;
        setThreadId(currentThreadId);
        threadLibrary.merge([response.thread]);
      }

      const response = await startTurn({
        threadId: currentThreadId,
        clientUserMessageId,
        text,
        attachments: attachments.map(({ path }) => ({ path })),
      });
      setActiveTurnId(response.turn.id);
      timeline.markUserMessage(clientUserMessageId, "complete");
      return true;
    } catch (reason) {
      setBusy(false);
      timeline.markUserMessage(clientUserMessageId, "failed");
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
    const [configResponse, requirementsResponse, sandboxReadinessResponse] =
      await Promise.all([
        readConfig({
          includeLayers: true,
          cwd: workspace(),
        }),
        readConfigRequirements(),
        readWindowsSandboxReadiness(),
      ]);
    setConfig(configResponse);
    setConfigRequirements(requirementsResponse);
    setWindowsSandboxReadiness(sandboxReadinessResponse);
  }

  async function setupWindowsSandbox(
    mode: WindowsSandboxSetupMode,
  ): Promise<boolean> {
    if (isWindowsSandboxSetupPending(windowsSandboxSetupState())) {
      return false;
    }
    const allowed =
      configRequirements()?.requirements?.allowedWindowsSandboxImplementations
      ?? null;
    if (allowed !== null && !allowed.includes(mode)) {
      const message = "A organização não permite esta implementação do sandbox.";
      setWindowsSandboxSetupState({ type: "failed", error: message, mode });
      addDiagnostic("stderr", message);
      return false;
    }
    if (windowsSandboxReadiness()?.status === "ready") {
      return false;
    }

    setWindowsSandboxSetupState({ type: "starting", mode });
    try {
      const response = await startWindowsSandboxSetup({
        mode,
        cwd: workspace(),
      });
      if (!response.started) {
        throw new Error("O app-server não iniciou a configuração do sandbox.");
      }
      setWindowsSandboxSetupState((current) =>
        current.type === "starting" && current.mode === mode
          ? { type: "running", mode }
          : current,
      );
      return true;
    } catch (reason) {
      const message = describeCommandError(reason);
      setWindowsSandboxSetupState({ type: "failed", error: message, mode });
      addDiagnostic("stderr", message);
      return false;
    }
  }

  async function writeSetting(
    keyPath: string,
    value: JsonValue,
    mergeStrategy: "replace" | "upsert",
  ) {
    await writeConfig({
      keyPath,
      value,
      mergeStrategy,
      expectedVersion: activeUserConfigVersion(config()),
    });
    await refreshConfig();
  }

  async function writeSettings(edits: ConfigEditRequest[]) {
    await writeConfigBatch({
      edits,
      expectedVersion: activeUserConfigVersion(config()),
    });
    await refreshConfig();
  }

  async function resolveWorldWritableWarning(
    remember: boolean,
  ): Promise<boolean> {
    const current = worldWritableWarningState();
    if (current.type === "idle" || current.type === "persisting") {
      return false;
    }
    if (!remember) {
      worldWritableWarningAcknowledgedForSession = true;
      setWorldWritableWarningState({ type: "idle" });
      return true;
    }

    setWorldWritableWarningState({
      type: "persisting",
      warning: current.warning,
    });
    try {
      await writeSetting(
        WORLD_WRITABLE_WARNING_CONFIG_KEY,
        true,
        "replace",
      );
      if (!worldWritableWarningIsHidden(config())) {
        throw new Error(
          "O Codex salvou a preferência, mas ela não ficou efetiva na configuração.",
        );
      }
      worldWritableWarningAcknowledgedForSession = true;
      setWorldWritableWarningState({ type: "idle" });
      return true;
    } catch (reason) {
      const message = describeCommandError(reason);
      setWorldWritableWarningState({
        type: "failed",
        error: message,
        warning: current.warning,
      });
      addDiagnostic("stderr", message);
      return false;
    }
  }

  async function respondToInteractiveRequest<T extends InteractiveServerRequest>(
    request: T,
    response: ServerResponseFor<T>,
  ): Promise<boolean> {
    try {
      await respondToServerRequest({
        id: request.id,
        response,
      });
      serverRequests.remove(request.id);
      return true;
    } catch (reason) {
      setError(describeCommandError(reason));
      return false;
    }
  }

  async function interruptPendingRequest(request: PendingServerRequest) {
    const requestedThreadId = request.threadId ?? threadId();
    const requestedTurnId = request.turnId ?? activeTurnId();
    if (requestedThreadId === null || requestedTurnId === null) {
      setError("A solicitação não está associada a um turno que possa ser interrompido.");
      return;
    }
    try {
      await interruptTurn({
        threadId: requestedThreadId,
        turnId: requestedTurnId,
      });
      serverRequests.remove(request.id);
    } catch (reason) {
      setError(describeCommandError(reason));
    }
  }

  function handleNotification(notification: CodexNotification) {
    const params = asObject(notification.params);
    switch (notification.method) {
      case "account/login/completed": {
        const completedLoginId = readString(params, "loginId");
        if (completedLoginId === undefined || completedLoginId !== pendingLoginId) {
          break;
        }
        pendingLoginId = null;
        setLoginPending(false);
        if (params?.success === false) {
          setError(readString(params, "error") ?? "Não foi possível concluir o login.");
        } else {
          refreshAccountInBackground();
        }
        break;
      }
      case "account/updated":
        refreshAccountInBackground();
        break;
      case "account/rateLimits/updated": {
        try {
          const update = parseAccountRateLimitsUpdatedNotification(
            notification.params,
          );
          const current = accountRateLimits();
          if (current === null) {
            refreshAccountRateLimitsInBackground();
            break;
          }
          setAccountRateLimits(
            mergeAccountRateLimitsUpdate(current, update.rateLimits),
          );
          setAccountRateLimitsState("ready");
        } catch (reason) {
          addDiagnostic("stderr", describeCommandError(reason));
        }
        break;
      }
      case "configWarning": {
        try {
          appNotices.push({
            type: "configWarning",
            value: parseConfigWarning(notification.params),
          });
        } catch (reason) {
          addDiagnostic("stderr", describeCommandError(reason));
        }
        break;
      }
      case "deprecationNotice": {
        try {
          appNotices.push({
            type: "deprecationNotice",
            value: parseDeprecationNotice(notification.params),
          });
        } catch (reason) {
          addDiagnostic("stderr", describeCommandError(reason));
        }
        break;
      }
      case "warning": {
        try {
          const warning = parseWarningNotification(notification.params);
          if (warning.threadId === null) {
            appNotices.push({ type: "warning", message: warning.message });
          } else {
            recordThreadWarning(warning.threadId, "warning", warning.message);
          }
        } catch (reason) {
          addDiagnostic("stderr", describeCommandError(reason));
        }
        break;
      }
      case "guardianWarning": {
        try {
          const warning = parseGuardianWarningNotification(notification.params);
          recordThreadWarning(warning.threadId, "guardian", warning.message);
        } catch (reason) {
          addDiagnostic("stderr", describeCommandError(reason));
        }
        break;
      }
      case "model/verification": {
        try {
          const verification = parseModelVerificationNotification(
            notification.params,
          );
          for (const message of modelVerificationWarnings(verification)) {
            recordThreadWarning(verification.threadId, "warning", message);
          }
        } catch (reason) {
          addDiagnostic("stderr", describeCommandError(reason));
        }
        break;
      }
      case "windowsSandbox/setupCompleted": {
        try {
          const completed = parseWindowsSandboxSetupCompleted(params);
          const current = windowsSandboxSetupState();
          if (
            !isWindowsSandboxSetupPending(current)
            || current.mode !== completed.mode
          ) {
            addDiagnostic(
              "stderr",
              "O app-server concluiu uma configuração de sandbox sem solicitação ativa correspondente.",
            );
            break;
          }
          if (!completed.success) {
            const message =
              completed.error ?? "Não foi possível configurar o sandbox do Windows.";
            setWindowsSandboxSetupState({
              type: "failed",
              error: message,
              mode: completed.mode,
            });
            addDiagnostic("stderr", message);
            break;
          }
          setWindowsSandboxSetupState({
            type: "succeeded",
            mode: completed.mode,
          });
          void refreshConfig().catch((reason) => {
            addDiagnostic("stderr", describeCommandError(reason));
          });
        } catch (reason) {
          addDiagnostic("stderr", describeCommandError(reason));
        }
        break;
      }
      case "windows/worldWritableWarning": {
        try {
          const warning = parseWindowsWorldWritableWarning(notification.params);
          if (worldWritableWarningAcknowledgedForSession) {
            break;
          }
          setWorldWritableWarningState((current) =>
            current.type === "persisting"
              ? current
              : { type: "pending", warning },
          );
        } catch (reason) {
          addDiagnostic("stderr", describeCommandError(reason));
        }
        break;
      }
      case "thread/started": {
        const item = asObject(params?.thread);
        if (readString(item, "id") === undefined) {
          addDiagnostic(
            "stderr",
            "Notificação incompatível do Codex em thread/started: thread.id ausente.",
          );
          break;
        }
        threadLibrary.refreshInBackground();
        break;
      }
      case "thread/status/changed": {
        if (readNotificationThreadId(notification.method, params) === undefined) {
          break;
        }
        threadLibrary.refreshInBackground();
        break;
      }
      case "thread/name/updated": {
        const updatedThreadId = readNotificationThreadId(
          notification.method,
          params,
        );
        const name = readString(params, "threadName");
        if (updatedThreadId !== undefined) {
          threadLibrary.update(updatedThreadId, (thread) => ({
            ...thread,
            name: name ?? null,
          }));
        }
        break;
      }
      case "thread/archived":
      case "thread/deleted": {
        const removedThreadId = readNotificationThreadId(
          notification.method,
          params,
        );
        if (removedThreadId !== undefined) {
          threadLibrary.remove(removedThreadId);
          serverRequests.removeForThread(removedThreadId);
          threadNotices.remove(removedThreadId);
          if (removedThreadId === threadId()) {
            resetConversation();
          }
        }
        break;
      }
      case "thread/unarchived":
        if (readNotificationThreadId(notification.method, params) === undefined) {
          break;
        }
        threadLibrary.refreshInBackground();
        break;
      case "turn/started": {
        if (!notificationTargetsCurrentThread(notification.method, params)) {
          threadLibrary.refreshInBackground();
          break;
        }
        const turn = asObject(params?.turn);
        turnProgress.reset();
        setActiveTurnId(readString(turn, "id") ?? null);
        setBusy(true);
        break;
      }
      case "turn/completed": {
        if (!notificationTargetsCurrentThread(notification.method, params)) {
          threadLibrary.refreshInBackground();
          break;
        }
        const turn = asObject(params?.turn);
        const turnError = asObject(turn?.error);
        const message = readString(turnError, "message");
        if (message !== undefined) {
          setError(message);
        }
        setActiveTurnId(null);
        setBusy(false);
        threadLibrary.refreshInBackground();
        break;
      }
      case "turn/diff/updated":
        if (!notificationTargetsCurrentThread(notification.method, params)) {
          break;
        }
        turnProgress.updateDiff(params);
        break;
      case "turn/plan/updated":
        if (!notificationTargetsCurrentThread(notification.method, params)) {
          break;
        }
        turnProgress.updatePlan(params);
        break;
      case "item/started":
      case "item/completed":
        if (!notificationTargetsCurrentThread(notification.method, params)) {
          break;
        }
        timeline.handleItem(
          params?.item,
          notification.method === "item/completed",
        );
        break;
      case "item/agentMessage/delta":
        if (!notificationTargetsCurrentThread(notification.method, params)) {
          break;
        }
        timeline.appendAgentDelta(params);
        break;
      case "item/commandExecution/outputDelta":
        if (!notificationTargetsCurrentThread(notification.method, params)) {
          break;
        }
        timeline.appendCommandOutputDelta(params);
        break;
      case "item/commandExecution/terminalInteraction":
        if (!notificationTargetsCurrentThread(notification.method, params)) {
          break;
        }
        timeline.appendTerminalInteraction(params);
        break;
      case "item/mcpToolCall/progress":
        if (!notificationTargetsCurrentThread(notification.method, params)) {
          break;
        }
        timeline.appendMcpToolProgress(params);
        break;
      case "item/fileChange/patchUpdated":
        if (!notificationTargetsCurrentThread(notification.method, params)) {
          break;
        }
        timeline.updateFileChangePatch(params);
        break;
      case "item/plan/delta":
        if (!notificationTargetsCurrentThread(notification.method, params)) {
          break;
        }
        timeline.appendPlanDelta(params);
        break;
      case "item/reasoning/summaryTextDelta":
        if (!notificationTargetsCurrentThread(notification.method, params)) {
          break;
        }
        timeline.appendReasoningSummaryDelta(params);
        break;
      case "item/reasoning/textDelta":
        if (!notificationTargetsCurrentThread(notification.method, params)) {
          break;
        }
        timeline.appendReasoningTextDelta(params);
        break;
      case "error": {
        if (!notificationTargetsCurrentThread(notification.method, params)) {
          threadLibrary.refreshInBackground();
          break;
        }
        const eventError = asObject(params?.error);
        setError(readString(eventError, "message") ?? "O turno falhou.");
        break;
      }
      case "serverRequest/resolved": {
        if (readNotificationThreadId(notification.method, params) === undefined) {
          break;
        }
        const requestId = params?.requestId;
        if (requestId !== undefined) {
          serverRequests.remove(requestId);
        }
        break;
      }
      default:
        break;
    }
  }

  function handleServerRequest(request: CodexServerRequest) {
    const result = serverRequests.enqueue(request);
    if (
      result.error !== null
      && (result.request === null
        || isRequestVisibleForThread(result.request.threadId, threadId()))
    ) {
      setError(result.error);
    }
  }

  function recordThreadWarning(
    targetThreadId: string,
    kind: "guardian" | "warning",
    message: string,
  ) {
    const recorded = threadNotices.record(targetThreadId, kind, message);
    if (
      recorded
      && isActiveThreadTarget(targetThreadId, threadId())
    ) {
      timeline.reconcileWarnings(threadNotices.entriesFor(targetThreadId));
    }
  }

  function readNotificationThreadId(
    method: string,
    params: JsonObject | undefined,
  ): string | undefined {
    try {
      return readRequiredNotificationThreadId(method, params);
    } catch (reason) {
      addDiagnostic("stderr", describeCommandError(reason));
      return undefined;
    }
  }

  function notificationTargetsCurrentThread(
    method: string,
    params: JsonObject | undefined,
  ): boolean {
    const targetThreadId = readNotificationThreadId(method, params);
    return (
      targetThreadId !== undefined
      && isActiveThreadTarget(targetThreadId, threadId())
    );
  }

  function handleDiagnostic(diagnostic: RuntimeDiagnostic) {
    addDiagnostic(diagnostic.stream, diagnostic.message);
  }

  function addDiagnostic(stream: RuntimeDiagnostic["stream"], message: string) {
    setDiagnostics((current) => [...current.slice(-19), { stream, message }]);
  }

  return {
    account,
    accountRateLimits,
    accountRateLimitsState,
    activeTurnId,
    pendingServerRequests,
    busy,
    cancelLogin: cancelPendingLogin,
    compatibilityContextState,
    config,
    appNotices: appNotices.notices,
    appNoticesOmitted: appNotices.omittedCount,
    configRequirements,
    windowsSandboxReadiness,
    windowsSandboxSetupState,
    worldWritableWarningState,
    diagnostics,
    error,
    loginPending,
    models,
    openingThreadId,
    projects: projectWorkspace.projects,
    runtime,
    runtimeStatus,
    signedIn,
    currentThreadTitle,
    threadId,
    threadLibraryState: threadLibrary.state,
    threads: threadLibrary.threads,
    threadsNextCursor: threadLibrary.nextCursor,
    timeline: timeline.entries,
    turnProgress: turnProgress.summary,
    workspace,
    chooseWorkspace,
    clearError: () => setError(null),
    dismissAppNotice: appNotices.dismiss,
    inspectFiles: inspectAttachments,
    interrupt,
    interruptPendingRequest,
    login,
    loadCompatibilityContext,
    loadMoreThreads,
    logout: logoutAccount,
    newThread,
    newThreadForProject,
    openThread,
    archiveThread,
    removeProject,
    renameThread,
    refreshConfig,
    refreshAccountRateLimits,
    respondToInteractiveRequest,
    resolveWorldWritableWarning,
    saveClipboardImage: savePastedImage,
    selectProject,
    sendMessage,
    setupWindowsSandbox,
    writeSetting,
    writeSettings,
  };
}

function isNativeLogoutResponse(value: unknown): value is NativeLogoutResponse {
  return (
    isJsonObject(value) &&
    typeof value.localCredentialsRemoved === "boolean" &&
    typeof value.remoteRevocation === "string" &&
    (value.remoteRevocationError === null ||
      typeof value.remoteRevocationError === "string")
  );
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function activeUserConfigVersion(snapshot: ConfigReadResponse | null): string | null {
  return snapshot?.layers?.find((layer) => layer.name.type === "user")?.version ?? null;
}

function worldWritableWarningIsHidden(
  snapshot: ConfigReadResponse | null,
): boolean {
  const notice = snapshot?.config.notice;
  return isJsonObject(notice) && notice.hide_world_writable_warning === true;
}

function isWindowsSandboxSetupPending(
  state: WindowsSandboxSetupState,
): state is Extract<WindowsSandboxSetupState, { type: "running" | "starting" }> {
  return state.type === "running" || state.type === "starting";
}

function parseWindowsSandboxSetupCompleted(
  params: JsonObject | undefined,
): WindowsSandboxSetupCompletedNotification {
  const mode = readString(params, "mode");
  const success = params?.success;
  const error = params?.error;
  if (
    (mode !== "elevated" && mode !== "unelevated")
    || typeof success !== "boolean"
    || (error !== null && typeof error !== "string")
  ) {
    throw new Error(
      "Notificação incompatível do Codex em windowsSandbox/setupCompleted.",
    );
  }
  return { mode, success, error };
}

function extractModels(response: ModelListResponse): CodexModel[] {
  return response.data ?? response.models ?? [];
}
