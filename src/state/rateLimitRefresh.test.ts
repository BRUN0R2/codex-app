import { describe, expect, it, vi } from "vitest";

import {
  createRateLimitRefreshCoordinator,
  RATE_LIMIT_REFRESH_INTERVAL_MS,
  type RateLimitRefreshHost,
} from "./rateLimitRefresh";

class FakeHost implements RateLimitRefreshHost {
  nowValue = 0;
  visible = true;
  intervalMs: number | null = null;
  interval: (() => void) | null = null;
  readonly focusListeners = new Set<() => void>();
  readonly visibilityListeners = new Set<() => void>();

  readonly now = () => this.nowValue;
  readonly isVisible = () => this.visible;

  readonly setInterval = (callback: () => void, intervalMs: number): number => {
    this.interval = callback;
    this.intervalMs = intervalMs;
    return 1;
  };

  readonly clearInterval = (_intervalId: number): void => {
    this.interval = null;
  };

  readonly addFocusListener = (listener: () => void): (() => void) => {
    this.focusListeners.add(listener);
    return () => this.focusListeners.delete(listener);
  };

  readonly addVisibilityListener = (listener: () => void): (() => void) => {
    this.visibilityListeners.add(listener);
    return () => this.visibilityListeners.delete(listener);
  };

  tickInterval(): void {
    this.nowValue += RATE_LIMIT_REFRESH_INTERVAL_MS;
    this.interval?.();
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

describe("atualização dos limites de uso", () => {
  it("usa a cadência de um minuto da aplicação oficial", async () => {
    const host = new FakeHost();
    const read = vi.fn(async () => 28);
    const apply = vi.fn();
    const coordinator = createRateLimitRefreshCoordinator({
      getSessionKey: () => "account",
      read,
      apply,
      reportError: vi.fn(),
      host,
    });

    coordinator.start();
    expect(host.intervalMs).toBe(RATE_LIMIT_REFRESH_INTERVAL_MS);
    host.tickInterval();
    await Promise.resolve();

    expect(read).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(28);
  });

  it("pausa em segundo plano e revalida ao recuperar visibilidade", async () => {
    const host = new FakeHost();
    const read = vi.fn(async () => 28);
    const coordinator = createRateLimitRefreshCoordinator({
      getSessionKey: () => "account",
      read,
      apply: vi.fn(),
      reportError: vi.fn(),
      host,
    });
    coordinator.start();

    host.changeVisibility(false);
    host.tickInterval();
    expect(read).not.toHaveBeenCalled();

    host.changeVisibility(true);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);

    host.focus();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("deduplica leituras concorrentes", async () => {
    const host = new FakeHost();
    const pending = deferred<number>();
    const read = vi.fn(() => pending.promise);
    const coordinator = createRateLimitRefreshCoordinator({
      getSessionKey: () => "account",
      read,
      apply: vi.fn(),
      reportError: vi.fn(),
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
    const coordinator = createRateLimitRefreshCoordinator({
      getSessionKey: () => "account",
      read: () => pending.promise,
      apply,
      reportError: vi.fn(),
      host,
    });

    const request = coordinator.refresh();
    coordinator.invalidateSession();
    pending.resolve(28);

    await expect(request).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("permite atualização manual mesmo quando o valor ainda está fresco", async () => {
    const host = new FakeHost();
    const read = vi.fn(async () => 28);
    const coordinator = createRateLimitRefreshCoordinator({
      getSessionKey: () => "account",
      read,
      apply: vi.fn(),
      reportError: vi.fn(),
      host,
    });

    await coordinator.refresh();
    await coordinator.refreshIfStale();
    await coordinator.refresh();

    expect(read).toHaveBeenCalledTimes(2);
  });
});
