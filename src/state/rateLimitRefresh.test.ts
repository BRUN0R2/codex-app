import { describe, expect, it, vi } from "vitest";

import {
  createRateLimitRefreshCoordinator,
  RATE_LIMIT_STALE_TIME_MS,
  type RateLimitRefreshHost,
} from "./rateLimitRefresh";

class FakeHost implements RateLimitRefreshHost {
  nowValue = 0;
  visible = true;
  readonly focusListeners = new Set<() => void>();
  readonly visibilityListeners = new Set<() => void>();

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
  it("não faz polling e revalida no foco somente quando o cache vence", async () => {
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
    expect(read).not.toHaveBeenCalled();

    host.focus();
    await flushCoordinator();
    expect(read).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(28);

    host.nowValue += RATE_LIMIT_STALE_TIME_MS - 1;
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
    const coordinator = createRateLimitRefreshCoordinator({
      getSessionKey: () => "account",
      read,
      apply: vi.fn(),
      reportError: vi.fn(),
      host,
    });
    coordinator.start();

    host.changeVisibility(false);
    expect(read).not.toHaveBeenCalled();

    host.changeVisibility(true);
    await flushCoordinator();
    expect(read).toHaveBeenCalledTimes(1);

    host.nowValue += RATE_LIMIT_STALE_TIME_MS;
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

  it("remove os observadores ao descartar o coordenador", () => {
    const host = new FakeHost();
    const coordinator = createRateLimitRefreshCoordinator({
      getSessionKey: () => "account",
      read: async () => 28,
      apply: vi.fn(),
      reportError: vi.fn(),
      host,
    });

    coordinator.start();
    expect(host.focusListeners.size).toBe(1);
    expect(host.visibilityListeners.size).toBe(1);

    coordinator.dispose();
    expect(host.focusListeners.size).toBe(0);
    expect(host.visibilityListeners.size).toBe(0);
  });
});
