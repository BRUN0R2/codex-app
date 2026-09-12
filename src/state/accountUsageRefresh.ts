export const ACCOUNT_USAGE_STALE_TIME_MS = 5 * 60_000;

export interface AccountUsageRefreshHost {
  readonly now: () => number;
  readonly isVisible: () => boolean;
  readonly addFocusListener: (listener: () => void) => () => void;
  readonly addVisibilityListener: (listener: () => void) => () => void;
  readonly scheduleRefresh: (listener: () => void, delayMs: number) => () => void;
}

interface AccountUsageRefreshOptions<T> {
  readonly getSessionKey: () => string | null;
  readonly read: () => Promise<T>;
  readonly apply: (value: T) => void;
  readonly reportError: (reason: unknown) => void;
  readonly setLoading: (loading: boolean) => void;
  readonly host: AccountUsageRefreshHost;
}

export interface AccountUsageRefreshCoordinator {
  readonly start: () => void;
  readonly refresh: () => Promise<boolean>;
  readonly refreshIfStale: () => Promise<boolean>;
  readonly invalidate: () => void;
  readonly dispose: () => void;
}

export function createAccountUsageRefreshCoordinator<T>(
  options: AccountUsageRefreshOptions<T>,
): AccountUsageRefreshCoordinator {
  let disposed = false;
  let started = false;
  let revision = 0;
  let removeFocusListener: (() => void) | null = null;
  let removeVisibilityListener: (() => void) | null = null;
  let cancelRefreshTimer: (() => void) | null = null;
  let lastSuccessfulRequest: { readonly key: string; readonly completedAt: number } | null = null;
  const requests = new Map<string, Promise<boolean>>();

  function currentRequestKey(): string | null {
    const sessionKey = options.getSessionKey();
    return sessionKey === null ? null : `${revision}\u0000${sessionKey}`;
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
      elapsed < ACCOUNT_USAGE_STALE_TIME_MS
    ) {
      return Promise.resolve(true);
    }
    const activeRequest = requests.get(requestKey);
    if (activeRequest !== undefined) {
      return activeRequest;
    }

    options.setLoading(true);
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
        if (!disposed && currentRequestKey() === requestKey) {
          options.setLoading(false);
          scheduleNextRefresh();
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

  function scheduleNextRefresh(): void {
    cancelRefreshTimer?.();
    cancelRefreshTimer = null;
    if (!started || disposed) return;
    cancelRefreshTimer = options.host.scheduleRefresh(() => {
      cancelRefreshTimer = null;
      scheduleNextRefresh();
      void run(false);
    }, ACCOUNT_USAGE_STALE_TIME_MS);
  }

  return {
    start() {
      if (started || disposed) {
        return;
      }
      started = true;
      removeFocusListener = options.host.addFocusListener(refreshWhenVisible);
      removeVisibilityListener = options.host.addVisibilityListener(refreshWhenVisible);
      scheduleNextRefresh();
    },
    refresh: () => run(true),
    refreshIfStale: () => run(false),
    invalidate() {
      revision += 1;
      lastSuccessfulRequest = null;
      options.setLoading(false);
      scheduleNextRefresh();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      options.setLoading(false);
      cancelRefreshTimer?.();
      cancelRefreshTimer = null;
      removeFocusListener?.();
      removeVisibilityListener?.();
      removeFocusListener = null;
      removeVisibilityListener = null;
    },
  };
}

export function createBrowserAccountUsageRefreshHost(): AccountUsageRefreshHost {
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
    scheduleRefresh(listener, delayMs) {
      const timer = setTimeout(listener, delayMs);
      return () => clearTimeout(timer);
    },
  };
}
