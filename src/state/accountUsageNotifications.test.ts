import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AccountRateLimitsResponse,
  AccountReadResponse,
  UsageResetCreditsResponse,
} from "../contracts/types";
import { findCatalog, translationCatalogs } from "../i18n/catalog";
import * as client from "../infrastructure/codexClient";
import { createAccountUsageController } from "./accountUsageController";
import { ACCOUNT_USAGE_STALE_TIME_MS } from "./accountUsageRefresh";
import { DEFAULT_APPLICATION_PREFERENCES } from "./applicationPreferences";
import { createNotificationSessionController } from "./notificationSessionController";
import { SingleFlightOperations } from "./singleFlightOperations";

const account: AccountReadResponse = {
  account: {
    type: "chatgpt",
    email: "ada@example.com",
    name: "Ada",
    picture: null,
    planType: "pro",
  },
  requiresOpenaiAuth: true,
  refresh: { status: "notRequired", error: null },
};
const emptyCredits: UsageResetCreditsResponse = {
  credits: [],
  availableCount: 0,
  immediateResetPurchaseEligible: false,
};

function limits(usedPercent: number, resetsAt: number): AccountRateLimitsResponse {
  return {
    generalRateLimit: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent, resetsAt, windowDurationMins: 300 },
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: "pro",
      rateLimitReachedType: null,
    },
    additionalRateLimitsByLimitId: {},
    planPrice: null,
    lunaReserveAvailable: false,
  };
}

describe("account notifications without user interaction", () => {
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    vi.spyOn(client, "readRateLimits").mockResolvedValue(limits(100, Date.now()));
    vi.spyOn(client, "readUsageResets").mockResolvedValue(emptyCredits);
  });

  afterEach(() => {
    dispose?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function startUsage() {
    const catalog = findCatalog(translationCatalogs, "en");
    if (catalog === null) throw new Error("The English notification catalog is unavailable.");
    const localization = { notifications: () => catalog.messages.notifications };
    const result = createRoot((release) => {
      let disposed = false;
      const notifications = createNotificationSessionController({
        applicationPreferences: () => DEFAULT_APPLICATION_PREFERENCES,
        applicationPreferencesLoaded: () => true,
        localization,
        taskLabels: () => [],
      });
      const addDiagnostic = vi.fn();
      const usage = createAccountUsageController({
        account: () => account,
        addDiagnostic,
        applyAccountProfile: vi.fn(),
        enqueueNotification: notifications.enqueue,
        host: {
          isDisposed: () => disposed,
          reportError: vi.fn(),
          setError: vi.fn(),
          singleFlight: new SingleFlightOperations<string, boolean>(),
          withPending: async (operation) => operation(),
        },
        isSignedIn: () => true,
        localization,
        onLunaReserveChanged: vi.fn(),
      });
      dispose = () => {
        disposed = true;
        usage.dispose();
        release();
      };
      usage.start();
      return { usage, notifications, addDiagnostic };
    });
    await Promise.all([result.usage.refreshRateLimits(), result.usage.refreshUsageResets()]);
    return result;
  }

  it.each([false, true])(
    "detects a new reset credit with a failed limits read=%s",
    async (limitsFail) => {
      const { usage, notifications, addDiagnostic } = await startUsage();
      const credits: UsageResetCreditsResponse = {
        ...emptyCredits,
        availableCount: 1,
        credits: [{ id: "new-reset", title: null, status: "available", expiresAt: null }],
      };
      vi.mocked(client.readUsageResets).mockResolvedValue(credits);
      if (limitsFail)
        vi.mocked(client.readRateLimits).mockRejectedValue(new Error("Limits unavailable."));

      expect(notifications.priority.active()).toBeNull();
      await vi.advanceTimersByTimeAsync(ACCOUNT_USAGE_STALE_TIME_MS);
      expect(usage.usageResets()).toEqual(credits);
      expect(notifications.priority.active()).toMatchObject({
        id: "usage-reset-available:new-reset",
        event: "usageResetAvailable",
      });
      expect(addDiagnostic).toHaveBeenCalledTimes(limitsFail ? 1 : 0);
      notifications.dismiss("usage-reset-available:new-reset");

      await vi.advanceTimersByTimeAsync(ACCOUNT_USAGE_STALE_TIME_MS);
      expect(notifications.priority.active()).toBeNull();
      expect(client.readUsageResets).toHaveBeenCalledTimes(3);
    },
  );

  it("notifies a server-confirmed usage reset while the app remains open", async () => {
    const { notifications, usage } = await startUsage();
    const renewed = limits(0, Date.now() + 300 * 60_000);
    vi.mocked(client.readRateLimits).mockResolvedValue(renewed);

    expect(notifications.transient.active()).toBeNull();
    await vi.advanceTimersByTimeAsync(ACCOUNT_USAGE_STALE_TIME_MS);
    expect(usage.rateLimits()).toEqual(renewed);
    const notification = notifications.transient.active();
    expect(notification?.event).toBe("usageLimitReset");
    if (notification === null) throw new Error("The usage reset notification was not delivered.");
    notifications.dismiss(notification.id);

    await vi.advanceTimersByTimeAsync(ACCOUNT_USAGE_STALE_TIME_MS);
    expect(notifications.transient.active()).toBeNull();
    dispose?.();
    await vi.advanceTimersByTimeAsync(ACCOUNT_USAGE_STALE_TIME_MS);
    expect(client.readRateLimits).toHaveBeenCalledTimes(3);
    expect(client.readUsageResets).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
