export const RATE_LIMIT_STALE_TIME_MS = 5 * 60_000;

export interface RateLimitRefreshHost {
  readonly now: () => number;
  readonly isVisible: () => boolean;
  readonly addFocusListener: (listener: () => void) => () => void;
  readonly addVisibilityListener: (listener: () => void) => () => void;
}

interface RateLimitRefreshOptions<T> {
  readonly getSessionKey: () => string | null;
  readonly read: () => Promise<T>;
  readonly apply: (value: T) => void;
  readonly reportError: (reason: unknown) => void;
  readonly host: RateLimitRefreshHost;
}

export interface RateLimitRefreshCoordinator {
  readonly start: () => void;
  readonly refresh: () => Promise<boolean>;
  readonly refreshIfStale: () => Promise<boolean>;
  readonly invalidateSession: () => void;
  readonly dispose: () => void;
}

export function createRateLimitRefreshCoordinator<T>(
  options: RateLimitRefreshOptions<T>,
): RateLimitRefreshCoordinator {
  let disposed = false;
  let started = false;
  let sessionRevision = 0;
  let removeFocusListener: (() => void) | null = null;
  let removeVisibilityListener: (() => void) | null = null;
  let lastSuccessfulRequest: { readonly key: string; readonly completedAt: number } | null = null;
  const requests = new Map<string, Promise<boolean>>();

  function currentRequestKey(): string | null {
    const sessionKey = options.getSessionKey();
    return sessionKey === null ? null : `${sessionRevision}\u0000${sessionKey}`;
  }

  function run(force: boolean): Promise<boolean> {
    const requestKey = currentRequestKey();
    if (disposed || requestKey === null) {
      return Promise.resolve(false);
    }
    const completed = lastSuccessfulRequest;
    const elapsed =
      completed === null ? Number.POSITIVE_INFINITY : options.host.now() - completed.completedAt;
    if (
      !force &&
      completed?.key === requestKey &&
      elapsed >= 0 &&
      elapsed < RATE_LIMIT_STALE_TIME_MS
    ) {
      return Promise.resolve(true);
    }
    const activeRequest = requests.get(requestKey);
    if (activeRequest !== undefined) {
      return activeRequest;
    }

    const request = options
      .read()
      .then((value) => {
        if (disposed || currentRequestKey() !== requestKey) {
          return false;
        }
        options.apply(value);
        lastSuccessfulRequest = { key: requestKey, completedAt: options.host.now() };
        return true;
      })
      .catch((reason: unknown) => {
        if (!disposed && currentRequestKey() === requestKey) {
          options.reportError(reason);
        }
        return false;
      })
      .finally(() => {
        if (requests.get(requestKey) === request) {
          requests.delete(requestKey);
        }
      });
    requests.set(requestKey, request);
    return request;
  }

  function refreshWhenVisible(): void {
    if (options.host.isVisible()) {
      void run(false);
    }
  }

  return {
    start() {
      if (started || disposed) {
        return;
      }
      started = true;
      removeFocusListener = options.host.addFocusListener(refreshWhenVisible);
      removeVisibilityListener = options.host.addVisibilityListener(refreshWhenVisible);
    },
    refresh: () => run(true),
    refreshIfStale: () => run(false),
    invalidateSession() {
      sessionRevision += 1;
      lastSuccessfulRequest = null;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      removeFocusListener?.();
      removeVisibilityListener?.();
      removeFocusListener = null;
      removeVisibilityListener = null;
    },
  };
}

export function createBrowserRateLimitRefreshHost(): RateLimitRefreshHost {
  return {
    now: Date.now,
    isVisible: () => document.visibilityState === "visible",
    addFocusListener(listener) {
      window.addEventListener("focus", listener);
      return () => window.removeEventListener("focus", listener);
    },
    addVisibilityListener(listener) {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}
