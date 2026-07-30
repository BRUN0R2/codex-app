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
  readConfig,
  readConfigRequirements,
  respondToServerRequest,
  resumeThread as resumeCodexThread,
  savePastedImage,
  startRuntime,
  startThread,
  startTurn,
  subscribeToCodexEvents,
  setThreadName,
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

export type CompatibilityContextState = "failed" | "idle" | "loading" | "ready";

export interface CodexSession {
  account: Accessor<AccountReadResponse | undefined>;
  activeTurnId: Accessor<string | null>;
  pendingServerRequests: Accessor<PendingServerRequest[]>;
  busy: Accessor<boolean>;
  compatibilityContextState: Accessor<CompatibilityContextState>;
  config: Accessor<ConfigReadResponse | null>;
  configRequirements: Accessor<ConfigRequirementsReadResponse | null>;
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
  respondToInteractiveRequest: <T extends InteractiveServerRequest>(
    request: T,
    response: ServerResponseFor<T>,
  ) => Promise<boolean>;
  saveClipboardImage: (dataBase64: string) => Promise<Attachment>;
  selectProject: (path: string) => Promise<void>;
  sendMessage: (text: string, attachments: Attachment[]) => Promise<boolean>;
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

export function createCodexSession(): CodexSession {
  const projectWorkspace = createProjectWorkspace();
  const [runtime, setRuntime] = createSignal<RuntimeStartResponse | null>(null);
  const [runtimeStatus, setRuntimeStatus] = createSignal<RuntimeStatus>({
    state: "starting",
    message: null,
  });
  const [account, setAccount] = createSignal<AccountReadResponse>();
  const [loginPending, setLoginPending] = createSignal(false);
  const [threadId, setThreadId] = createSignal<string | null>(null);
  const [activeTurnId, setActiveTurnId] = createSignal<string | null>(null);
  const [openingThreadId, setOpeningThreadId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const serverRequests = createServerRequestQueue();
  const [compatibilityContextState, setCompatibilityContextState] =
    createSignal<CompatibilityContextState>("idle");
  const [config, setConfig] = createSignal<ConfigReadResponse | null>(null);
  const [configRequirements, setConfigRequirements] =
    createSignal<ConfigRequirementsReadResponse | null>(null);
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
  let compatibilityContextGeneration = 0;
  let compatibilityContextRequest: Promise<void> | null = null;
  let pendingLoginId: string | null = null;

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

      const [configResponse, requirementsResponse, modelsResponse] = await Promise.all([
        readConfig({ includeLayers: true, cwd: workspace() }),
        readConfigRequirements(),
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
    setModels([]);
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
    setError(null);
    try {
      await Promise.all([
        compatibilityContextRequest?.catch(() => undefined),
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
    serverRequests.clear();
  }

  function hydrateThread(thread: CodexThread) {
    setThreadId(thread.id);
    serverRequests.clear();
    turnProgress.reset();

    let resumedTurnId: string | null = null;
    timeline.hydrate(thread.turns.flatMap((turn) => turn.items));
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
    const [configResponse, requirementsResponse] = await Promise.all([
      readConfig({
        includeLayers: true,
        cwd: workspace(),
      }),
      readConfigRequirements(),
    ]);
    setConfig(configResponse);
    setConfigRequirements(requirementsResponse);
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
      case "thread/started": {
        const item = asObject(params?.thread);
        const id = readString(item, "id");
        if (id !== undefined && threadId() === null) {
          setThreadId(id);
        }
        threadLibrary.refreshInBackground();
        break;
      }
      case "thread/status/changed":
        threadLibrary.refreshInBackground();
        break;
      case "thread/name/updated": {
        const updatedThreadId = readString(params, "threadId");
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
        const removedThreadId = readString(params, "threadId");
        if (removedThreadId !== undefined) {
          threadLibrary.remove(removedThreadId);
          if (removedThreadId === threadId()) {
            resetConversation();
          }
        }
        break;
      }
      case "thread/unarchived":
        threadLibrary.refreshInBackground();
        break;
      case "turn/started": {
        const turn = asObject(params?.turn);
        turnProgress.reset();
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
        threadLibrary.refreshInBackground();
        break;
      }
      case "turn/diff/updated":
        turnProgress.updateDiff(params);
        break;
      case "turn/plan/updated":
        turnProgress.updatePlan(params);
        break;
      case "item/started":
      case "item/completed":
        timeline.handleItem(
          params?.item,
          notification.method === "item/completed",
        );
        break;
      case "item/agentMessage/delta":
        timeline.appendAgentDelta(params);
        break;
      case "item/commandExecution/outputDelta":
        timeline.appendCommandOutputDelta(params);
        break;
      case "item/commandExecution/terminalInteraction":
        timeline.appendTerminalInteraction(params);
        break;
      case "item/mcpToolCall/progress":
        timeline.appendMcpToolProgress(params);
        break;
      case "item/fileChange/patchUpdated":
        timeline.updateFileChangePatch(params);
        break;
      case "item/plan/delta":
        timeline.appendPlanDelta(params);
        break;
      case "item/reasoning/summaryTextDelta":
        timeline.appendReasoningSummaryDelta(params);
        break;
      case "item/reasoning/textDelta":
        timeline.appendReasoningTextDelta(params);
        break;
      case "error": {
        const eventError = asObject(params?.error);
        setError(readString(eventError, "message") ?? "O turno falhou.");
        break;
      }
      case "serverRequest/resolved": {
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
    const protocolError = serverRequests.enqueue(request);
    if (protocolError !== null) {
      setError(protocolError);
    }
  }

  function handleDiagnostic(diagnostic: RuntimeDiagnostic) {
    addDiagnostic(diagnostic.stream, diagnostic.message);
  }

  function addDiagnostic(stream: RuntimeDiagnostic["stream"], message: string) {
    setDiagnostics((current) => [...current.slice(-19), { stream, message }]);
  }

  return {
    account,
    activeTurnId,
    pendingServerRequests: serverRequests.pending,
    busy,
    cancelLogin: cancelPendingLogin,
    compatibilityContextState,
    config,
    configRequirements,
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
    respondToInteractiveRequest,
    saveClipboardImage: savePastedImage,
    selectProject,
    sendMessage,
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

function extractModels(response: ModelListResponse): CodexModel[] {
  return response.data ?? response.models ?? [];
}
