import { describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_PROFILE_STALE_TIME_MS,
  createAccountProfileRefreshCoordinator,
  mergeAccountProfile,
} from "./accountProfileRefresh";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("atualização do perfil ChatGPT", () => {
  it("aplica nome e foto oficiais sem descartar os demais dados da conta", () => {
    const account = {
      account: {
        type: "chatgpt",
        email: "ada@example.com",
        name: "Ada",
        picture: null,
        planType: "pro",
      },
      requiresOpenaiAuth: true,
      refresh: { status: "notRequired", error: null },
    } as const;
    const profile = {
      displayName: "Ada Lovelace",
      username: "ada.dev",
      picture: "https://images.example.com/ada.png",
      statisticsStatus: "available",
      summary: {
        lifetimeTokens: null,
        peakDailyTokens: null,
        longestRunningTurnSeconds: null,
        currentStreakDays: null,
        longestStreakDays: null,
      },
      dailyUsage: null,
      activityInsights: {
        fastModePercent: null,
        mostUsedReasoningEffort: null,
        mostUsedReasoningEffortPercent: null,
        uniqueSkillsUsed: null,
        totalSkillsUsed: null,
        totalThreads: null,
        topInvocations: null,
      },
    } as const;

    expect(mergeAccountProfile(account, profile)?.account).toEqual({
      ...account.account,
      name: "Ada Lovelace",
      picture: "https://images.example.com/ada.png",
    });
    const existingPicture = "https://images.example.com/existing.png";
    expect(
      mergeAccountProfile(
        { ...account, account: { ...account.account, picture: existingPicture } },
        { ...profile, picture: null },
      )?.account?.picture,
    ).toBe(existingPicture);
  });

  it("compartilha a chamada em andamento dentro da mesma sessão", async () => {
    const pending = deferred<{ picture: string }>();
    const read = vi.fn(() => pending.promise);
    const apply = vi.fn();
    const coordinator = createAccountProfileRefreshCoordinator({
      getSessionKey: () => "account-1",
      read,
      apply,
      reportError: vi.fn(),
    });

    const first = coordinator.refresh();
    const second = coordinator.refresh();
    expect(first).toBe(second);
    expect(read).toHaveBeenCalledTimes(1);

    pending.resolve({ picture: "https://images.example.com/ada.png" });
    await expect(first).resolves.toBe(true);
    expect(apply).toHaveBeenCalledOnce();
  });

  it("descarta a resposta de uma sessão invalidada", async () => {
    const pending = deferred<{ picture: string }>();
    const apply = vi.fn();
    const reportError = vi.fn();
    const coordinator = createAccountProfileRefreshCoordinator({
      getSessionKey: () => "account-1",
      read: () => pending.promise,
      apply,
      reportError,
    });

    const request = coordinator.refresh();
    coordinator.invalidateSession();
    pending.resolve({ picture: "https://images.example.com/old.png" });

    await expect(request).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("relata falhas apenas enquanto a sessão ainda é atual", async () => {
    const failure = new Error("profile unavailable");
    const reportError = vi.fn();
    const coordinator = createAccountProfileRefreshCoordinator({
      getSessionKey: () => "account-1",
      read: () => Promise.reject(failure),
      apply: vi.fn(),
      reportError,
    });

    await expect(coordinator.refresh()).resolves.toBe(false);
    expect(reportError).toHaveBeenCalledWith(failure);

    coordinator.dispose();
    await expect(coordinator.refresh()).resolves.toBe(false);
  });

  it("mantém o perfil em cache por seis horas como o cliente oficial", async () => {
    let now = 1_000;
    const read = vi.fn(() => Promise.resolve({ picture: "https://images.example.com/ada.png" }));
    const coordinator = createAccountProfileRefreshCoordinator({
      getSessionKey: () => "account-1",
      read,
      apply: vi.fn(),
      reportError: vi.fn(),
      now: () => now,
    });

    await expect(coordinator.refreshIfStale()).resolves.toBe(true);
    now += ACCOUNT_PROFILE_STALE_TIME_MS - 1;
    await expect(coordinator.refreshIfStale()).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(1);

    now += 1;
    await expect(coordinator.refreshIfStale()).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
