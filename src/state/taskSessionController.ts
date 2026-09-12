import { type Accessor, batch, createEffect, createMemo, createSignal } from "solid-js";

import type {
  ApprovalDecision,
  CodexThread,
  ContextUsageItem,
  ConversationMode,
  EngineNotification,
  EngineServerRequest,
  ModelReroutedNotification,
  ModelSafetyBufferingUpdatedNotification,
  ModelVerification,
  PlanItem,
  ThreadSummary,
} from "../contracts/types";
import { formatMessage, type TranslationMessages } from "../i18n/messages";
import {
  archiveThread as archiveThreadCommand,
  confirmDesktopDialog as confirm,
  deleteThread as deleteThreadCommand,
  forkThread as forkThreadCommand,
  interruptTurn,
  listThreads,
  readThread,
  respondToServerRequest,
  resumeThread,
  setThreadName,
  startThread,
  startTurn,
  steerTurn,
  unarchiveThread as unarchiveThreadCommand,
} from "../infrastructure/codexClient";
import type { SendMessageInput } from "./appController";
import { assertNever } from "./assertNever";
import { captureInitialization, type SessionControllerHost } from "./controllerSupport";
import { applyCommandStreamDeltasToThread, readLatestTurnFailure } from "./conversation";
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
import type { NavigationSessionController } from "./navigationSessionController";
import {
  activeConversationMode,
  type ProductFlowState,
  selectChatGptMode as reduceSelectChatGptMode,
  rememberConversationDestination,
} from "./productFlow";
import { pathsEqual } from "./projects";
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

const THREAD_PAGE_CACHE_CAPACITY = 8;

type StreamNotification = Extract<EngineNotification, { readonly method: "item.streamDeltas" }>;

type TurnCompletedNotification = Extract<EngineNotification, { readonly method: "turn.completed" }>;

type NonTaskNotification =
  | { readonly method: "auth.loginCompleted" }
  | { readonly method: "auth.sessionChanged" }
  | { readonly method: "account.rateLimitsUpdated" }
  | { readonly method: "automation.changed" }
  | { readonly method: "automation.deleted" }
  | { readonly method: "automation.runUpdated" }
  | { readonly method: "item.streamDeltas" };

type TaskNotification = Exclude<EngineNotification, NonTaskNotification>;

export interface TaskSessionController {
  readonly activePlan: Accessor<PlanItem | null>;
  readonly activeTaskRootId: Accessor<string | null>;
  readonly activeTurnId: Accessor<string | null>;
  readonly agentThreads: Accessor<readonly ThreadSummary[]>;
  readonly allAgentThreads: Accessor<readonly ThreadSummary[]>;
  readonly approvals: Accessor<readonly EngineServerRequest[]>;
  readonly archivedThreads: Accessor<readonly ThreadSummary[]>;
  readonly archivedThreadsLoaded: Accessor<boolean>;
  readonly archivedThreadsLoading: Accessor<boolean>;
  readonly archivedThreadsNextCursor: Accessor<string | null>;
  readonly contextUsage: Accessor<ContextUsageItem | null>;
  readonly currentThread: Accessor<CodexThread | null>;
  readonly hasOlderHistory: Accessor<boolean>;
  readonly historyLoading: Accessor<boolean>;
  readonly initializationFailures: readonly Error[];
  readonly lastTurnFailure: Accessor<string | null>;
  readonly modelReroute: Accessor<ModelReroutedNotification["params"] | null>;
  readonly modelVerifications: Accessor<readonly ModelVerification[]>;
  readonly persistedTurns: Accessor<readonly VisibleThreadTurn[]>;
  readonly queuedMessages: Accessor<readonly QueuedMessage[]>;
  readonly safetyBuffering: Accessor<ModelSafetyBufferingUpdatedNotification["params"] | null>;
  readonly threads: Accessor<readonly ThreadSummary[]>;
  readonly threadsNextCursor: Accessor<string | null>;
  readonly turnBusy: Accessor<boolean>;
  readonly turns: Accessor<VisibleTurnSequence>;
  readonly addPendingApproval: (request: EngineServerRequest) => void;
  readonly applyNotification: (notification: TaskNotification) => void;
  readonly applyStreamNotification: (notification: StreamNotification) => void;
  readonly applyThreadPage: (page: {
    readonly data: readonly ThreadSummary[];
    readonly nextCursor: string | null;
  }) => void;
  readonly archiveThread: (threadId: string) => Promise<boolean>;
  readonly clearCurrentThread: () => void;
  readonly deleteQueuedMessage: (messageId: string) => boolean;
  readonly deleteThread: (threadId: string) => Promise<boolean>;
  readonly dispose: () => void;
  readonly enqueueMessage: (input: SendMessageInput) => boolean;
  readonly flushStreamDeltas: () => void;
  readonly forkThread: (threadId: string) => Promise<boolean>;
  readonly invalidateAuthenticatedStateLoad: () => void;
  readonly interrupt: () => Promise<boolean>;
  readonly isItemStreaming: (itemId: string) => boolean;
  readonly isThreadActive: (threadId: string) => boolean;
  readonly loadMoreArchivedThreads: () => Promise<boolean>;
  readonly loadMoreThreads: () => Promise<boolean>;
  readonly loadOlderHistory: () => Promise<boolean>;
  readonly openThread: (threadId: string) => Promise<boolean>;
  readonly renameThread: (threadId: string, name: string) => Promise<boolean>;
  readonly resetSession: () => void;
  readonly respondToApproval: (requestId: string, decision: ApprovalDecision) => Promise<boolean>;
  readonly restoreDestination: (expected: ProductFlowState) => Promise<boolean>;
  readonly resumePersistedMessageQueues: (availableThreads: readonly ThreadSummary[]) => void;
  readonly sendMessage: (input: SendMessageInput) => Promise<boolean>;
  readonly sendQueuedMessageNow: (messageId?: string) => Promise<boolean>;
  readonly takeQueuedMessage: (messageId: string) => QueuedMessage | null;
  readonly unarchiveThread: (threadId: string) => Promise<boolean>;
}

export interface TaskSessionDependencies {
  readonly confirmations: Accessor<TranslationMessages["confirmations"]>;
  readonly host: SessionControllerHost;
  readonly navigation: NavigationSessionController;
  readonly notifications: {
    readonly notifyTurnCompletion: (notification: TurnCompletedNotification) => void;
    readonly removeApprovalNotification: (requestId: string) => void;
  };
  readonly onUsageMayBeStale: () => void;
}

export function createTaskSessionController(
  dependencies: TaskSessionDependencies,
): TaskSessionController {
  const { confirmations, host, navigation, notifications, onUsageMayBeStale } = dependencies;
  const { isDisposed, reportError, setError, singleFlight, withPending } = host;
  const singleFlightOperations = singleFlight;

  function selectThreadProject(thread: ThreadSummary): boolean {
    return navigation.selectProjectPath(thread.projectPath);
  }

  function alignProductFlowToThread(mode: ConversationMode): boolean {
    const current = navigation.productFlow();
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
        workspace: navigation.workspace(),
      },
    );
    return navigation.commitProductFlow(reduceSelectChatGptMode(withCurrentDestination, mode));
  }

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

  const queuedDispatchTails = new Map<string, Promise<void>>();

  let persistedQueuesResumed = false;

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

  const lastTurnFailure = createMemo(() => {
    const thread = currentThread();
    return thread === null ? null : readLatestTurnFailure(thread);
  });

  async function restoreActiveDestination(expected: ProductFlowState): Promise<boolean> {
    const mode = activeConversationMode(expected);
    const destination = expected.destinations[mode];
    batch(() => {
      clearCurrentThread();
      navigation.setWorkspace(mode === "chat" ? null : destination.workspace);
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
        navigation.rememberDestination(mode, cached.thread.id, cached.thread.projectPath);
        return true;
      }
      const response = await withPending(() => resumeThread(threadId));
      if (!isCurrentThreadSelection(selectionRevision) || navigation.conversationMode() !== mode) {
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
      navigation.rememberDestination(mode, response.thread.id, response.thread.projectPath);
      return true;
    } catch (reason) {
      if (!isCurrentThreadSelection(selectionRevision)) {
        return false;
      }
      navigation.rememberDestination(mode, null, destination.workspace);
      reportError(reason);
      return false;
    } finally {
      finishThreadSelection(selectionRevision);
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
      navigation.rememberDestination(mode, response.thread.id, response.thread.projectPath);
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
        navigation.rememberDestination(
          cached.thread.mode,
          cached.thread.id,
          cached.thread.projectPath,
        );
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
      navigation.rememberDestination(
        response.thread.mode,
        response.thread.id,
        response.thread.projectPath,
      );
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
      const title = thread.name ?? thread.preview ?? confirmations().newTask;
      const description = isThreadActive(threadId)
        ? formatMessage(confirmations().deleteActiveTaskDescription, { name: title })
        : formatMessage(confirmations().deleteTaskDescription, { name: title });
      const confirmed = await confirm(description, {
        cancelLabel: confirmations().cancel,
        kind: "warning",
        okLabel: confirmations().delete,
        title: confirmations().deleteTaskTitle,
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
      navigation.rememberDestination(
        response.thread.mode,
        response.thread.id,
        response.thread.projectPath,
      );
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
      if (isDisposed()) {
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
      const mode = navigation.conversationMode();
      thread = await materializeThread(mode === "chat" ? null : navigation.workspace(), mode);
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
      notifications.removeApprovalNotification(requestId);
      return true;
    } catch (reason) {
      reportError(reason);
      return false;
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
      navigation.removePinnedThread(threadId);
    });
    if (selected?.id === threadId) {
      navigation.rememberDestination(selected.mode, null, navigation.workspace());
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
      if (isDisposed() || readQueuedMessages(messageQueues(), threadId).length === 0) {
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

  const initializationFailures: readonly Error[] = messageQueueLoadWarnings.map(
    (warning) => new Error(warning),
  );

  function applyStreamNotification(notification: StreamNotification): void {
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
  }

  function flushStreamDeltas(): void {
    streamDeltas.flush();
  }

  function applyNotification(notification: TaskNotification): void {
    switch (notification.method) {
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
            navigation.rememberDestination(selected.mode, null, navigation.workspace());
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
        void onUsageMayBeStale();
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
          notifications.notifyTurnCompletion(notification);
          void onUsageMayBeStale();
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

  function addPendingApproval(request: EngineServerRequest): void {
    setPendingApprovals((current) => {
      if (current.some((entry) => entry.id === request.id)) {
        throw new Error(`Approval ${request.id} was received twice.`);
      }
      return [...current, request];
    });
  }

  function applyThreadPage(page: {
    readonly data: readonly ThreadSummary[];
    readonly nextCursor: string | null;
  }): void {
    setThreads(page.data);
    setThreadsNextCursor(page.nextCursor);
  }

  function invalidateAuthenticatedStateLoad(): void {
    persistedQueuesResumed = false;
  }

  createEffect(() => {
    const thread = currentThread();
    const nextCursor = historyCursor();
    if (thread !== null) {
      threadPages.write({ thread, nextCursor });
    }
  });

  function resetSession(): void {
    try {
      clearPersistedMessageQueues();
    } catch (reason) {
      reportError(reason);
    }
    batch(() => {
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
  }

  return {
    activePlan,
    activeTaskRootId,
    activeTurnId,
    addPendingApproval,
    agentThreads,
    allAgentThreads,
    applyNotification,
    applyStreamNotification,
    applyThreadPage,
    approvals,
    archiveThread,
    archivedThreads,
    archivedThreadsLoaded,
    archivedThreadsLoading,
    archivedThreadsNextCursor,
    clearCurrentThread,
    contextUsage,
    currentThread,
    deleteQueuedMessage,
    deleteThread,
    dispose: () => streamDeltas.dispose(),
    enqueueMessage,
    flushStreamDeltas,
    forkThread,
    hasOlderHistory,
    historyLoading,
    initializationFailures,
    interrupt,
    invalidateAuthenticatedStateLoad,
    isItemStreaming,
    isThreadActive,
    lastTurnFailure,
    loadMoreArchivedThreads,
    loadMoreThreads,
    loadOlderHistory,
    modelReroute,
    modelVerifications,
    openThread,
    persistedTurns,
    queuedMessages,
    renameThread,
    resetSession,
    respondToApproval,
    restoreDestination: restoreActiveDestination,
    resumePersistedMessageQueues,
    safetyBuffering,
    sendMessage,
    sendQueuedMessageNow,
    takeQueuedMessage,
    threads,
    threadsNextCursor,
    turnBusy,
    turns,
    unarchiveThread,
  };
}
