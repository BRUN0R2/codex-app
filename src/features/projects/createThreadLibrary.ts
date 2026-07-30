import { createSignal, type Accessor } from "solid-js";

import {
  describeCommandError,
  listThreads,
} from "../../shared/codex/client";
import type {
  CodexThread,
  RuntimeStartResponse,
} from "../../shared/codex/types";
import { mergeThreadPage, type ThreadLibraryState } from "./threadLibrary";

interface ThreadLibraryOptions {
  isDisposed: () => boolean;
  reportDiagnostic: (message: string) => void;
  runtime: Accessor<RuntimeStartResponse | null>;
  signedIn: Accessor<boolean>;
}

export interface ThreadLibrary {
  nextCursor: Accessor<string | null>;
  state: Accessor<ThreadLibraryState>;
  threads: Accessor<CodexThread[]>;
  loadMore: () => Promise<void>;
  merge: (page: CodexThread[]) => void;
  prewarm: () => void;
  refreshInBackground: () => void;
  remove: (threadId: string) => void;
  reset: () => void;
  settle: () => Promise<void>;
  update: (
    threadId: string,
    updateThread: (thread: CodexThread) => CodexThread,
  ) => void;
}

export function createThreadLibrary(
  options: ThreadLibraryOptions,
): ThreadLibrary {
  const [state, setState] = createSignal<ThreadLibraryState>("idle");
  const [threads, setThreads] = createSignal<CodexThread[]>([]);
  const [nextCursor, setNextCursor] = createSignal<string | null>(null);

  let generation = 0;
  let request: Promise<void> | null = null;

  async function load(force = false) {
    if (!force && state() === "ready") {
      return;
    }
    if (request !== null) {
      return request;
    }
    return loadPage(null, true);
  }

  async function loadMore() {
    const cursor = nextCursor();
    if (cursor !== null) {
      await loadPage(cursor, false);
    }
  }

  async function loadPage(cursor: string | null, replace: boolean) {
    if (request !== null) {
      return request;
    }

    const preserveReadyState = state() === "ready";
    if (!preserveReadyState) {
      setState("loading");
    }
    const requestGeneration = generation;
    const currentRequest = (async () => {
      const started = options.runtime();
      if (started === null) {
        throw new Error("A engine nativa ainda não foi inicializada.");
      }
      if (!started.compatibility.available) {
        throw new Error(
          started.compatibility.reason ??
            "A ponte de compatibilidade do Codex não está disponível.",
        );
      }

      const response = await listThreads({ cursor });
      if (
        options.isDisposed() ||
        requestGeneration !== generation ||
        !options.signedIn()
      ) {
        return;
      }
      setThreads((current) =>
        replace ? response.data : mergeThreadPage(current, response.data),
      );
      setNextCursor(response.nextCursor);
      setState("ready");
    })();
    request = currentRequest;

    try {
      await currentRequest;
    } catch (reason) {
      if (!options.isDisposed() && requestGeneration === generation) {
        if (!preserveReadyState) {
          setState("failed");
        }
        options.reportDiagnostic(describeCommandError(reason));
      }
      throw reason;
    } finally {
      if (request === currentRequest) {
        request = null;
      }
    }
  }

  function merge(page: CodexThread[]) {
    setThreads((current) => mergeThreadPage(current, page));
  }

  function prewarm() {
    const started = options.runtime();
    if (options.isDisposed() || !options.signedIn() || started === null) {
      return;
    }
    if (!started.compatibility.available) {
      setState("failed");
      return;
    }
    void load().catch(() => {
      // load owns the visible state and diagnostic.
    });
  }

  function refreshInBackground() {
    void load(true).catch(() => {
      // load owns the visible state and diagnostic.
    });
  }

  function remove(threadId: string) {
    setThreads((current) =>
      current.filter((thread) => thread.id !== threadId),
    );
  }

  function reset() {
    generation += 1;
    setState("idle");
    setThreads([]);
    setNextCursor(null);
  }

  async function settle() {
    await request?.catch(() => undefined);
  }

  function update(
    threadId: string,
    updateThread: (thread: CodexThread) => CodexThread,
  ) {
    setThreads((current) =>
      current.map((thread) =>
        thread.id === threadId ? updateThread(thread) : thread,
      ),
    );
  }

  return {
    nextCursor,
    state,
    threads,
    loadMore,
    merge,
    prewarm,
    refreshInBackground,
    remove,
    reset,
    settle,
    update,
  };
}
