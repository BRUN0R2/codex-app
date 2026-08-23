import type { AccountProfileResponse, AccountReadResponse } from "../contracts/types";

export const ACCOUNT_PROFILE_STALE_TIME_MS = 6 * 60 * 60 * 1_000;

export function mergeAccountProfile(
  current: AccountReadResponse | undefined,
  profile: AccountProfileResponse,
): AccountReadResponse | undefined {
  if (current?.account === null || current === undefined) {
    return current;
  }
  return {
    ...current,
    account: {
      ...current.account,
      name: profile.displayName ?? current.account.name,
      picture: profile.picture ?? current.account.picture,
    },
  };
}

export interface AccountProfileRefreshOptions<T> {
  readonly getSessionKey: () => string | null;
  readonly read: () => Promise<T>;
  readonly apply: (value: T) => void;
  readonly reportError: (reason: unknown) => void;
  readonly now?: () => number;
}

export interface AccountProfileRefreshCoordinator {
  readonly refresh: () => Promise<boolean>;
  readonly refreshIfStale: () => Promise<boolean>;
  readonly invalidateSession: () => void;
  readonly dispose: () => void;
}

export function createAccountProfileRefreshCoordinator<T>(
  options: AccountProfileRefreshOptions<T>,
): AccountProfileRefreshCoordinator {
  let disposed = false;
  let sessionRevision = 0;
  let lastSuccessfulRequest: { readonly key: string; readonly completedAt: number } | null = null;
  const requests = new Map<string, Promise<boolean>>();
  const now = options.now ?? Date.now;

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
    const elapsed = completed === null ? Number.POSITIVE_INFINITY : now() - completed.completedAt;
    if (
      !force &&
      completed?.key === requestKey &&
      elapsed >= 0 &&
      elapsed < ACCOUNT_PROFILE_STALE_TIME_MS
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
        lastSuccessfulRequest = { key: requestKey, completedAt: now() };
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

  return {
    refresh: () => run(true),
    refreshIfStale: () => run(false),
    invalidateSession() {
      sessionRevision += 1;
      lastSuccessfulRequest = null;
    },
    dispose() {
      disposed = true;
      sessionRevision += 1;
    },
  };
}
