import { describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_USAGE_STALE_TIME_MS,
  type AccountUsageRefreshHost,
  createAccountUsageRefreshCoordinator,
} from "./accountUsageRefresh";

class FakeHost implements AccountUsageRefreshHost {
  nowValue = 0;
  visible = true;
  readonly focusListeners = new Set<() => void>();
  readonly visibilityListeners = new Set<() => void>();
  readonly timers = new Set<{ readonly dueAt: number; readonly listener: () => void }>();

  readonly now = () => this.nowValue;
  readonly isVisible = () => this.visible;

  readonly addFocusListener = (listener: () => void): (() => void) => {
    this.focusListeners.add(listener);
    return () => this.focusListeners.delete(listener);
  };

  readonly addVisibilityListener = (listener: () => void): (() => void) => {
    this.visibilityListeners.add(listener);
    return () => this.visibilityListeners.delete(listener);
  };

  readonly scheduleRefresh = (listener: () => void, delayMs: number): (() => void) => {
    const timer = { dueAt: this.nowValue + delayMs, listener };
    this.timers.add(timer);
    return () => this.timers.delete(timer);
  };

  async advance(milliseconds: number): Promise<void> {
    this.nowValue += milliseconds;
    for (const timer of [...this.timers]) {
      if (timer.dueAt <= this.nowValue && this.timers.delete(timer)) timer.listener();
    }
    await flushCoordinator();
  }

  focus(): void {
    for (const listener of this.focusListeners) {
      listener();
    }
  }

  changeVisibility(visible: boolean): void {
    this.visible = visible;
    for (const listener of this.visibilityListeners) {
      listener();
    }
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

async function flushCoordinator(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("atualização dos limites de uso", () => {
  it("revalidates on focus only when the cached response becomes stale", async () => {
    const host = new FakeHost();
    const read = vi.fn(async () => 28);
    const apply = vi.fn();
    const coordinator = createAccountUsageRefreshCoordinator({
      getSessionKey: () => "account",
      read,
      apply,
      reportError: vi.fn(),
      setLoading: vi.fn(),
      host,
    });

    coordinator.start();
    expect(read).not.toHaveBeenCalled();

    host.focus();
    await flushCoordinator();
    expect(read).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(28);

    host.nowValue += ACCOUNT_USAGE_STALE_TIME_MS - 1;
    host.focus();
    expect(read).toHaveBeenCalledTimes(1);

    host.nowValue += 1;
    host.focus();
    await flushCoordinator();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("ignora eventos em segundo plano e revalida ao recuperar visibilidade", async () => {
    const host = new FakeHost();
    const read = vi.fn(async () => 28);
    const coordinator = createAccountUsageRefreshCoordinator({
      getSessionKey: () => "account",
      read,
      apply: vi.fn(),
      reportError: vi.fn(),
      setLoading: vi.fn(),
      host,
    });
    coordinator.start();

    host.changeVisibility(false);
    expect(read).not.toHaveBeenCalled();

    host.changeVisibility(true);
    await flushCoordinator();
    expect(read).toHaveBeenCalledTimes(1);

    host.nowValue += ACCOUNT_USAGE_STALE_TIME_MS;
    host.changeVisibility(false);
    host.focus();
    expect(read).toHaveBeenCalledTimes(1);

    host.changeVisibility(true);
    await flushCoordinator();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("deduplica leituras concorrentes", async () => {
    const host = new FakeHost();
    const pending = deferred<number>();
    const read = vi.fn(() => pending.promise);
    const coordinator = createAccountUsageRefreshCoordinator({
      getSessionKey: () => "account",
      read,
      apply: vi.fn(),
      reportError: vi.fn(),
      setLoading: vi.fn(),
      host,
    });

    const first = coordinator.refresh();
    const second = coordinator.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve(28);

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
  });

  it("descarta uma resposta pertencente à sessão anterior", async () => {
    const host = new FakeHost();
    const pending = deferred<number>();
    const apply = vi.fn();
    const coordinator = createAccountUsageRefreshCoordinator({
      getSessionKey: () => "account",
      read: () => pending.promise,
      apply,
      reportError: vi.fn(),
      setLoading: vi.fn(),
      host,
    });

    const request = coordinator.refresh();
    coordinator.invalidate();
    pending.resolve(28);

    await expect(request).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("permite atualização manual mesmo quando o valor ainda está fresco", async () => {
    const host = new FakeHost();
    const read = vi.fn(async () => 28);
    const coordinator = createAccountUsageRefreshCoordinator({
      getSessionKey: () => "account",
      read,
      apply: vi.fn(),
      reportError: vi.fn(),
      setLoading: vi.fn(),
      host,
    });

    await coordinator.refresh();
    await coordinator.refreshIfStale();
    await coordinator.refresh();

    expect(read).toHaveBeenCalledTimes(2);
  });

  it("remove os observadores ao descartar o coordenador", () => {
    const host = new FakeHost();
    const coordinator = createAccountUsageRefreshCoordinator({
      getSessionKey: () => "account",
      read: async () => 28,
      apply: vi.fn(),
      reportError: vi.fn(),
      setLoading: vi.fn(),
      host,
    });

    coordinator.start();
    expect(host.focusListeners.size).toBe(1);
    expect(host.visibilityListeners.size).toBe(1);
    expect(host.timers.size).toBe(1);

    coordinator.dispose();
    expect(host.focusListeners.size).toBe(0);
    expect(host.visibilityListeners.size).toBe(0);
    expect(host.timers.size).toBe(0);
  });

  it.each([true, false])("refreshes without interaction while visible=%s", async (visible) => {
    const host = new FakeHost();
    host.visible = visible;
    const read = vi.fn(async () => 28);
    const coordinator = createAccountUsageRefreshCoordinator({
      getSessionKey: () => "account",
      read,
      apply: vi.fn(),
      reportError: vi.fn(),
      setLoading: vi.fn(),
      host,
    });
    coordinator.start();
    coordinator.start();
    await coordinator.refresh();

    await host.advance(ACCOUNT_USAGE_STALE_TIME_MS - 1);
    expect(read).toHaveBeenCalledTimes(1);
    await host.advance(1);
    expect(read).toHaveBeenCalledTimes(2);
    await host.advance(ACCOUNT_USAGE_STALE_TIME_MS);
    expect(read).toHaveBeenCalledTimes(3);
    expect(host.timers.size).toBe(1);
    coordinator.dispose();
  });

  it("schedules the next read from completion and coalesces timer, focus, and manual requests", async () => {
    const host = new FakeHost();
    const pending = Promise.withResolvers<number>();
    const read = vi.fn(() => pending.promise);
    const coordinator = createAccountUsageRefreshCoordinator({
      getSessionKey: () => "account",
      read,
      apply: vi.fn(),
      reportError: vi.fn(),
      setLoading: vi.fn(),
      host,
    });
    coordinator.start();
    await host.advance(ACCOUNT_USAGE_STALE_TIME_MS);
    host.focus();
    const request = coordinator.refresh();
    await host.advance(ACCOUNT_USAGE_STALE_TIME_MS);
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve(28);
    await request;

    await host.advance(ACCOUNT_USAGE_STALE_TIME_MS - 1);
    expect(read).toHaveBeenCalledTimes(1);
    await host.advance(1);
    expect(read).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it("reports failures and retries on the next bounded interval", async () => {
    const host = new FakeHost();
    const failure = new Error("The account service is unavailable.");
    const read = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(28);
    const reportError = vi.fn();
    const apply = vi.fn();
    const coordinator = createAccountUsageRefreshCoordinator({
      getSessionKey: () => "account",
      read,
      apply,
      reportError,
      setLoading: vi.fn(),
      host,
    });
    coordinator.start();
    await host.advance(ACCOUNT_USAGE_STALE_TIME_MS);
    expect(reportError).toHaveBeenCalledWith(failure);
    expect(apply).not.toHaveBeenCalled();
    await host.advance(ACCOUNT_USAGE_STALE_TIME_MS - 1);
    expect(read).toHaveBeenCalledTimes(1);
    await host.advance(1);
    expect(apply).toHaveBeenCalledWith(28);
    coordinator.dispose();
  });

  it("does not query signed-out accounts or rearm a disposed coordinator", async () => {
    const host = new FakeHost();
    let sessionKey: string | null = null;
    const pending = Promise.withResolvers<number>();
    const read = vi.fn(() => pending.promise);
    const apply = vi.fn();
    const coordinator = createAccountUsageRefreshCoordinator({
      getSessionKey: () => sessionKey,
      read,
      apply,
      reportError: vi.fn(),
      setLoading: vi.fn(),
      host,
    });
    coordinator.start();
    await host.advance(ACCOUNT_USAGE_STALE_TIME_MS);
    expect(read).not.toHaveBeenCalled();
    sessionKey = "account";
    await host.advance(ACCOUNT_USAGE_STALE_TIME_MS);
    expect(read).toHaveBeenCalledOnce();
    coordinator.dispose();
    pending.resolve(28);
    await flushCoordinator();
    await host.advance(ACCOUNT_USAGE_STALE_TIME_MS);
    expect(read).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
    expect(host.timers.size).toBe(0);
  });

  it("keeps the current session loading when an obsolete request completes", async () => {
    const host = new FakeHost();
    const oldRequest = Promise.withResolvers<number>();
    const newRequest = Promise.withResolvers<number>();
    const read = vi
      .fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    const setLoading = vi.fn();
    const apply = vi.fn();
    const coordinator = createAccountUsageRefreshCoordinator({
      getSessionKey: () => "account",
      read,
      apply,
      reportError: vi.fn(),
      setLoading,
      host,
    });
    const previous = coordinator.refresh();
    coordinator.invalidate();
    const current = coordinator.refresh();
    oldRequest.resolve(10);
    await previous;
    expect(setLoading).toHaveBeenLastCalledWith(true);
    expect(apply).not.toHaveBeenCalled();
    newRequest.resolve(20);
    await current;
    expect(setLoading).toHaveBeenLastCalledWith(false);
    expect(apply).toHaveBeenCalledExactlyOnceWith(20);
    coordinator.dispose();
  });
});
