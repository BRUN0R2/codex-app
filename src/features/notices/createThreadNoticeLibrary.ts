import type {
  WarningEntry,
  WarningKind,
} from "../chat/timelineTypes";

const MAX_NOTICES_PER_THREAD = 40;
const MAX_TRACKED_THREADS = 64;
const MAX_NOTICE_CHARACTERS = 8 * 1024;
const FALLBACK_MODEL_WARNING_PREFIX = "Model metadata for `";
const FALLBACK_MODEL_WARNING_SUFFIX =
  "` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.";

interface ThreadNoticeState {
  entries: WarningEntry[];
  fallbackModelSlugs: Set<string>;
  omittedCount: number;
}

interface ThreadNoticeLibraryOptions {
  reportDiagnostic: (message: string) => void;
}

export interface ThreadNoticeLibrary {
  clear: () => void;
  entriesFor: (threadId: string) => WarningEntry[];
  record: (
    threadId: string,
    kind: WarningKind,
    message: string,
  ) => boolean;
  remove: (threadId: string) => void;
}

export function createThreadNoticeLibrary(
  options: ThreadNoticeLibraryOptions,
): ThreadNoticeLibrary {
  const states = new Map<string, ThreadNoticeState>();
  let sequence = 0;

  function record(
    threadId: string,
    kind: WarningKind,
    message: string,
  ): boolean {
    const state = states.get(threadId) ?? createState();
    if (suppressRepeatedFallbackModelWarning(state, message)) {
      touch(threadId, state);
      return false;
    }

    const entry: WarningEntry = {
      type: "warning",
      id: nextEntryId(threadId),
      kind,
      message: boundNoticeMessage(message),
      omittedBefore: 0,
    };
    const entries = [...state.entries, entry];
    const overflow = Math.max(0, entries.length - MAX_NOTICES_PER_THREAD);
    touch(threadId, {
      ...state,
      entries: entries.slice(overflow),
      omittedCount: state.omittedCount + overflow,
    });
    evictOldestThreadIfRequired(threadId);
    return true;
  }

  function entriesFor(threadId: string): WarningEntry[] {
    const state = states.get(threadId);
    if (state === undefined) {
      return [];
    }
    touch(threadId, state);
    return state.entries.map((entry, index) =>
      index === 0 && state.omittedCount > 0
        ? { ...entry, omittedBefore: state.omittedCount }
        : entry,
    );
  }

  function touch(threadId: string, state: ThreadNoticeState) {
    states.delete(threadId);
    states.set(threadId, state);
  }

  function evictOldestThreadIfRequired(activeThreadId: string) {
    if (states.size <= MAX_TRACKED_THREADS) {
      return;
    }
    const oldestThreadId = states.keys().next().value as string | undefined;
    if (oldestThreadId === undefined || oldestThreadId === activeThreadId) {
      return;
    }
    const removed = states.get(oldestThreadId);
    states.delete(oldestThreadId);
    if (removed !== undefined) {
      const count = removed.entries.length + removed.omittedCount;
      options.reportDiagnostic(
        `${count} aviso(s) transitório(s) da tarefa ${formatThreadId(oldestThreadId)} foram descartados pelo limite de memória.`,
      );
    }
  }

  function nextEntryId(threadId: string): string {
    sequence = sequence === Number.MAX_SAFE_INTEGER ? 1 : sequence + 1;
    return `thread-warning:${sequence}`;
  }

  return {
    clear: () => states.clear(),
    entriesFor,
    record,
    remove: (threadId) => states.delete(threadId),
  };
}

function formatThreadId(threadId: string): string {
  const maximum = 96;
  if (threadId.length <= maximum) {
    return threadId;
  }
  const retainedAtEachEnd = maximum / 2;
  return `${threadId.slice(0, retainedAtEachEnd)}…${threadId.slice(-retainedAtEachEnd)}`;
}

function boundNoticeMessage(value: string): string {
  if (value.length <= MAX_NOTICE_CHARACTERS) {
    return value;
  }
  const omitted = value.length - MAX_NOTICE_CHARACTERS;
  return `${value.slice(0, MAX_NOTICE_CHARACTERS)}\n[${omitted} caracteres adicionais omitidos]`;
}

function createState(): ThreadNoticeState {
  return {
    entries: [],
    fallbackModelSlugs: new Set(),
    omittedCount: 0,
  };
}

function suppressRepeatedFallbackModelWarning(
  state: ThreadNoticeState,
  message: string,
): boolean {
  const slug = fallbackModelWarningSlug(message);
  if (slug === null) {
    return false;
  }
  if (state.fallbackModelSlugs.has(slug)) {
    return true;
  }
  state.fallbackModelSlugs.add(slug);
  return false;
}

function fallbackModelWarningSlug(message: string): string | null {
  if (
    !message.startsWith(FALLBACK_MODEL_WARNING_PREFIX)
    || !message.endsWith(FALLBACK_MODEL_WARNING_SUFFIX)
  ) {
    return null;
  }
  return message.slice(
    FALLBACK_MODEL_WARNING_PREFIX.length,
    -FALLBACK_MODEL_WARNING_SUFFIX.length,
  );
}
