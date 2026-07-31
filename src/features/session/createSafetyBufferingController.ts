import { createSignal } from "solid-js";

import type {
  Attachment,
  ModelSafetyBufferingUpdatedNotification,
} from "../../shared/codex/types";

const MAX_TRACKED_THREADS = 64;
const MAX_TRACKED_TURN_FACTS = 256;
const MAX_ERROR_CHARACTERS = 4_096;

export interface SafetyBufferedTurnInput {
  threadId: string;
  turnId: string;
  text: string;
  attachments: readonly Attachment[];
}

export type SafetyBufferingViewState =
  | { type: "idle" }
  | {
      type: "waiting";
      threadId: string;
      turnId: string;
      model: string;
      fasterModel: string | null;
      canRetry: boolean;
      retrying: boolean;
      error: string | null;
    };

export interface SafetyBufferingRetryContext {
  threadId: string;
  turnId: string;
  fasterModel: string;
  input: SafetyBufferedTurnInput;
}

interface SafetyBufferingRecord {
  threadId: string;
  turnId: string;
  notification: ModelSafetyBufferingUpdatedNotification | null;
  input: SafetyBufferedTurnInput | null;
  responseStarted: boolean;
  dismissed: boolean;
  retrying: boolean;
  error: string | null;
}

interface SafetyTurnReference {
  threadId: string;
  turnId: string;
}

export interface SafetyBufferingController {
  stateFor: (threadId: string | null) => SafetyBufferingViewState;
  retryingFor: (threadId: string | null) => boolean;
  isCompleted: (threadId: string, turnId: string) => boolean;
  handle: (notification: ModelSafetyBufferingUpdatedNotification) => void;
  recordSubmittedTurn: (input: SafetyBufferedTurnInput) => void;
  turnStarted: (threadId: string, turnId: string) => void;
  markResponseStarted: (threadId: string, turnId: string) => void;
  completeTurn: (threadId: string, turnId: string) => void;
  dismiss: (threadId: string, turnId: string) => void;
  beginRetry: (threadId: string, turnId: string) => SafetyBufferingRetryContext | null;
  failRetry: (context: SafetyBufferingRetryContext, error: string) => void;
  finishRetry: (context: SafetyBufferingRetryContext) => void;
  clearWaitingState: (threadId: string) => void;
  remove: (threadId: string) => void;
  clear: () => void;
}

export function createSafetyBufferingController(): SafetyBufferingController {
  const records = new Map<string, SafetyBufferingRecord>();
  const completedTurns = new Map<string, SafetyTurnReference>();
  const responseStartedTurns = new Map<string, SafetyTurnReference>();
  const [revision, setRevision] = createSignal(0);

  function stateFor(threadId: string | null): SafetyBufferingViewState {
    revision();
    if (threadId === null) {
      return { type: "idle" };
    }
    const record = records.get(threadId);
    const notification = record?.notification;
    if (
      record === undefined
      || notification === null
      || notification === undefined
      || record.dismissed
    ) {
      return { type: "idle" };
    }
    return {
      type: "waiting",
      threadId: record.threadId,
      turnId: record.turnId,
      model: notification.model,
      fasterModel: notification.fasterModel,
      canRetry: canRetry(record),
      retrying: record.retrying,
      error: record.error,
    };
  }

  function retryingFor(threadId: string | null): boolean {
    revision();
    return threadId !== null && records.get(threadId)?.retrying === true;
  }

  function isCompleted(threadId: string, turnId: string): boolean {
    return completedTurns.has(turnKey(threadId, turnId));
  }

  function handle(notification: ModelSafetyBufferingUpdatedNotification) {
    if (isCompleted(notification.threadId, notification.turnId)) {
      return;
    }
    const current = records.get(notification.threadId);
    if (!notification.showBufferingUi) {
      if (current?.turnId === notification.turnId) {
        store({
          ...current,
          notification: null,
          dismissed: true,
          error: null,
        });
      }
      return;
    }

    const sameTurn = current?.turnId === notification.turnId;
    const previous = sameTurn ? current : undefined;
    const beforeCanRetry = previous === undefined ? false : canRetry(previous);
    const next: SafetyBufferingRecord = {
      threadId: notification.threadId,
      turnId: notification.turnId,
      notification: cloneNotification(notification),
      input: previous?.input ?? null,
      responseStarted:
        previous?.responseStarted
        ?? hasTurnFact(responseStartedTurns, notification.threadId, notification.turnId),
      dismissed: previous?.dismissed ?? false,
      retrying: previous?.retrying ?? false,
      error: previous?.error ?? null,
    };
    if (!beforeCanRetry && canRetry(next)) {
      next.dismissed = false;
    }
    store(next);
  }

  function recordSubmittedTurn(input: SafetyBufferedTurnInput) {
    if (isCompleted(input.threadId, input.turnId)) {
      return;
    }
    for (const [key, record] of records) {
      if (key !== input.threadId && record.input !== null) {
        records.set(key, { ...record, input: null });
      }
    }

    const current = records.get(input.threadId);
    const sameTurn = current?.turnId === input.turnId;
    const previous = sameTurn ? current : undefined;
    const beforeCanRetry = previous === undefined ? false : canRetry(previous);
    const next: SafetyBufferingRecord = {
      threadId: input.threadId,
      turnId: input.turnId,
      notification: previous?.notification ?? null,
      input: cloneInput(input),
      responseStarted:
        previous?.responseStarted
        ?? hasTurnFact(responseStartedTurns, input.threadId, input.turnId),
      dismissed: previous?.dismissed ?? false,
      retrying: previous?.retrying ?? false,
      error: previous?.error ?? null,
    };
    if (!beforeCanRetry && canRetry(next)) {
      next.dismissed = false;
    }
    store(next);
  }

  function turnStarted(threadId: string, turnId: string) {
    if (isCompleted(threadId, turnId)) {
      return;
    }
    const current = records.get(threadId);
    if (current !== undefined && current.turnId !== turnId) {
      records.delete(threadId);
      changed();
    }
  }

  function markResponseStarted(threadId: string, turnId: string) {
    markTurnFact(responseStartedTurns, threadId, turnId);
    updateExact(threadId, turnId, (record) => ({
      ...record,
      responseStarted: true,
    }));
  }

  function completeTurn(threadId: string, turnId: string) {
    markTurnFact(completedTurns, threadId, turnId);
    const current = records.get(threadId);
    if (current?.turnId === turnId) {
      if (current.retrying) {
        store(current);
      } else {
        records.delete(threadId);
        changed();
      }
    }
  }

  function dismiss(threadId: string, turnId: string) {
    updateExact(threadId, turnId, (record) => ({
      ...record,
      dismissed: true,
      error: null,
    }));
  }

  function beginRetry(
    threadId: string,
    turnId: string,
  ): SafetyBufferingRetryContext | null {
    const record = records.get(threadId);
    const fasterModel = record?.notification?.fasterModel;
    if (
      record === undefined
      || record.turnId !== turnId
      || record.retrying
      || !canRetry(record)
      || fasterModel === null
      || fasterModel === undefined
      || record.input === null
    ) {
      return null;
    }
    store({ ...record, retrying: true, error: null });
    return {
      threadId,
      turnId,
      fasterModel,
      input: cloneInput(record.input),
    };
  }

  function failRetry(context: SafetyBufferingRetryContext, error: string) {
    if (isCompleted(context.threadId, context.turnId)) {
      records.delete(context.threadId);
      changed();
      return;
    }
    updateExact(context.threadId, context.turnId, (record) => ({
      ...record,
      retrying: false,
      dismissed: false,
      error: error.slice(0, MAX_ERROR_CHARACTERS),
    }));
  }

  function finishRetry(context: SafetyBufferingRetryContext) {
    markTurnFact(completedTurns, context.threadId, context.turnId);
    records.delete(context.threadId);
    changed();
  }

  function clearWaitingState(threadId: string) {
    if (records.delete(threadId)) {
      changed();
    }
  }

  function remove(threadId: string) {
    const removed = records.delete(threadId);
    const removedCompletion = removeThreadFacts(completedTurns, threadId);
    const removedResponse = removeThreadFacts(responseStartedTurns, threadId);
    if (removed || removedCompletion || removedResponse) {
      changed();
    }
  }

  function clear() {
    if (
      records.size > 0
      || completedTurns.size > 0
      || responseStartedTurns.size > 0
    ) {
      records.clear();
      completedTurns.clear();
      responseStartedTurns.clear();
      changed();
    }
  }

  function updateExact(
    threadId: string,
    turnId: string,
    update: (record: SafetyBufferingRecord) => SafetyBufferingRecord,
  ) {
    const current = records.get(threadId);
    if (current?.turnId === turnId) {
      store(update(current));
    }
  }

  function store(record: SafetyBufferingRecord) {
    records.delete(record.threadId);
    records.set(record.threadId, record);
    trimMap(records, MAX_TRACKED_THREADS);
    changed();
  }

  function changed() {
    setRevision((current) => current + 1);
  }

  return {
    stateFor,
    retryingFor,
    isCompleted,
    handle,
    recordSubmittedTurn,
    turnStarted,
    markResponseStarted,
    completeTurn,
    dismiss,
    beginRetry,
    failRetry,
    finishRetry,
    clearWaitingState,
    remove,
    clear,
  };
}

function markTurnFact(
  facts: Map<string, SafetyTurnReference>,
  threadId: string,
  turnId: string,
) {
  const key = turnKey(threadId, turnId);
  facts.delete(key);
  facts.set(key, { threadId, turnId });
  trimMap(facts, MAX_TRACKED_TURN_FACTS);
}

function hasTurnFact(
  facts: Map<string, SafetyTurnReference>,
  threadId: string,
  turnId: string,
): boolean {
  return facts.has(turnKey(threadId, turnId));
}

function removeThreadFacts(
  facts: Map<string, SafetyTurnReference>,
  threadId: string,
): boolean {
  let removed = false;
  for (const [key, reference] of facts) {
    if (reference.threadId === threadId) {
      facts.delete(key);
      removed = true;
    }
  }
  return removed;
}

function turnKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId]);
}

function trimMap<T>(map: Map<string, T>, maximumSize: number) {
  while (map.size > maximumSize) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) {
      return;
    }
    map.delete(oldest);
  }
}

function canRetry(record: SafetyBufferingRecord): boolean {
  return (
    record.notification?.fasterModel !== null
    && record.notification?.fasterModel !== undefined
    && record.input !== null
    && !record.responseStarted
  );
}

function cloneNotification(
  notification: ModelSafetyBufferingUpdatedNotification,
): ModelSafetyBufferingUpdatedNotification {
  return {
    ...notification,
    useCases: [...notification.useCases],
    reasons: [...notification.reasons],
  };
}

function cloneInput(input: SafetyBufferedTurnInput): SafetyBufferedTurnInput {
  return {
    ...input,
    attachments: input.attachments.map((attachment) => ({ ...attachment })),
  };
}
