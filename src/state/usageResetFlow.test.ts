import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AccountRateLimitsResponse,
  UsageResetCreditsResponse,
  UsageResetRedemptionResponse,
} from "../contracts/types";
import { createI18nController } from "../i18n/context";
import * as client from "../infrastructure/codexClient";
import { resetBrowserPreviewRuntime } from "../infrastructure/runtimeBridge";
import { setupBrowserPreview } from "../preview/setupBrowserPreview";
import { createAppController } from "./createAppController";

function resetLimits(before: AccountRateLimitsResponse): AccountRateLimitsResponse {
  const snapshot = before.rateLimits;
  return {
    ...before,
    rateLimits: {
      ...snapshot,
      primary: snapshot.primary === null ? null : { ...snapshot.primary, usedPercent: 0 },
      secondary: snapshot.secondary === null ? null : { ...snapshot.secondary, usedPercent: 0 },
    },
    lunaReserveAvailable: false,
  };
}

describe("usage reset flow", () => {
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-06T12:00:00Z"));
    const values = new Map<string, string>();
    const attributes = new Map<string, string>();
    const document = {
      title: "",
      visibilityState: "visible",
      documentElement: {
        getAttribute: (name: string) => attributes.get(name) ?? null,
        setAttribute: (name: string, value: string) => attributes.set(name, value),
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", {
      document,
      location: { search: "?preview=1" },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("localStorage", {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    setupBrowserPreview();
  });

  afterEach(() => {
    dispose?.();
    resetBrowserPreviewRuntime();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function startController() {
    const controller = createRoot((release) => {
      dispose = release;
      const i18n = createI18nController({ languages: ["en"], storage: null });
      return createAppController({
        confirmations: () => i18n.messages().confirmations,
        nativeMenu: () => i18n.messages().nativeMenu,
        notifications: () => i18n.messages().notifications,
      });
    });
    await vi.waitFor(() => {
      expect(controller.rateLimits()).not.toBeNull();
      expect(controller.usageResets()).not.toBeNull();
    });
    return controller;
  }

  it("consumes one reset, updates the provider windows, and preserves the idempotent result", async () => {
    const controller = await startController();
    const before = controller.rateLimits();
    expect(before?.rateLimits.primary?.usedPercent).toBe(43);
    expect(before?.rateLimits.secondary?.usedPercent).toBe(93);
    expect(controller.usageResets()?.availableCount).toBe(1);

    await expect(
      controller.redeemUsageReset("preview-reset-credit", "reset-request"),
    ).resolves.toEqual({
      code: "reset",
      creditId: "preview-reset-credit",
    });
    await vi.waitFor(() => expect(controller.usageResetRedeemingId()).toBeNull());
    const after = controller.rateLimits();
    if (before === null || after === null) throw new Error("Missing account usage.");
    expect(after?.rateLimits.primary).toEqual({
      usedPercent: 0,
      windowDurationMins: 300,
      resetsAt: Date.now() + 300 * 60_000,
    });
    expect(after?.rateLimits.secondary).toEqual({
      usedPercent: 0,
      windowDurationMins: 10_080,
      resetsAt: Date.now() + 10_080 * 60_000,
    });
    const { codex_spark: spark, base_model_inference: reserve } = after.rateLimitsByLimitId;
    const { base_model_inference: previousReserve } = before.rateLimitsByLimitId;
    expect(spark?.secondary?.usedPercent).toBe(0);
    expect(reserve).toEqual(previousReserve);
    expect(after?.rateLimits.credits).toEqual(before?.rateLimits.credits);
    expect(after?.lunaReserveAvailable).toBe(false);
    expect(controller.usageResets()?.availableCount).toBe(0);
    expect(controller.usageResetRedeemingId()).toBeNull();

    await expect(
      controller.redeemUsageReset("preview-reset-credit", "reset-request"),
    ).resolves.toEqual({
      code: "already_redeemed",
      creditId: "preview-reset-credit",
    });
    expect(controller.rateLimits()).toEqual(after);
    expect(controller.usageResets()?.availableCount).toBe(0);
    await vi.waitFor(() => expect(controller.usageResetRedeemingId()).toBeNull());
    await expect(controller.redeemUsageReset(null, "another-request")).resolves.toEqual({
      code: "no_credits_available",
      creditId: null,
    });
    expect(controller.usageResetsError()).toBe("No reset is available to use.");
    expect(controller.rateLimits()).toEqual(after);
  });

  it("returns the authoritative success while post-reset reads are still pending", async () => {
    const controller = await startController();
    const beforeLimits = controller.rateLimits();
    const beforeCredits = controller.usageResets();
    if (beforeLimits === null || beforeCredits === null) throw new Error("Missing account usage.");
    const pendingLimits = Promise.withResolvers<AccountRateLimitsResponse>();
    const pendingCredits = Promise.withResolvers<UsageResetCreditsResponse>();
    const readLimits = vi
      .spyOn(client, "readRateLimits")
      .mockImplementationOnce(() => pendingLimits.promise);
    const readCredits = vi
      .spyOn(client, "readUsageResets")
      .mockImplementationOnce(() => pendingCredits.promise);
    vi.spyOn(client, "redeemUsageReset").mockResolvedValue({
      code: "reset",
      creditId: "preview-reset-credit",
    });

    await expect(
      controller.redeemUsageReset("preview-reset-credit", "reset-request"),
    ).resolves.toEqual({ code: "reset", creditId: "preview-reset-credit" });
    expect(readLimits).toHaveBeenCalledTimes(1);
    expect(readCredits).toHaveBeenCalledTimes(1);
    expect(controller.usageResetRedeemingId()).toBe("preview-reset-credit");

    pendingLimits.resolve(resetLimits(beforeLimits));
    pendingCredits.resolve({ ...beforeCredits, credits: [], availableCount: 0 });
    await vi.waitFor(() => expect(controller.usageResetRedeemingId()).toBeNull());
  });

  it.each(["before", "after"])(
    "discards older reads that complete %s the post-reset reads",
    async (completionOrder) => {
      const controller = await startController();
      const beforeLimits = controller.rateLimits();
      const beforeCredits = controller.usageResets();
      if (beforeLimits === null || beforeCredits === null)
        throw new Error("Missing account usage.");
      const afterLimits = resetLimits(beforeLimits);
      const afterCredits: UsageResetCreditsResponse = {
        ...beforeCredits,
        credits: [],
        availableCount: 0,
      };
      const pendingLimits = Promise.withResolvers<AccountRateLimitsResponse>();
      const pendingCredits = Promise.withResolvers<UsageResetCreditsResponse>();
      const readLimits = vi
        .spyOn(client, "readRateLimits")
        .mockImplementationOnce(() => pendingLimits.promise)
        .mockResolvedValue(afterLimits);
      const readCredits = vi
        .spyOn(client, "readUsageResets")
        .mockImplementationOnce(() => pendingCredits.promise)
        .mockResolvedValue(afterCredits);
      vi.spyOn(client, "redeemUsageReset").mockResolvedValue({
        code: "reset",
        creditId: "preview-reset-credit",
      });

      const olderLimits = controller.refreshRateLimits();
      const olderCredits = controller.refreshUsageResets();
      await vi.waitFor(() => expect(readCredits).toHaveBeenCalledTimes(1));
      const redemption = controller.redeemUsageReset("preview-reset-credit", "reset-request");
      if (completionOrder === "after") await redemption;
      pendingLimits.resolve(beforeLimits);
      pendingCredits.resolve(beforeCredits);
      await Promise.all([olderLimits, olderCredits, redemption]);

      await vi.waitFor(() => {
        expect(readLimits).toHaveBeenCalledTimes(2);
        expect(readCredits).toHaveBeenCalledTimes(2);
        expect(controller.rateLimits()).toEqual(afterLimits);
        expect(controller.usageResets()).toEqual(afterCredits);
      });
    },
  );

  it.each(["readRateLimits", "readUsageResets"] as const)(
    "preserves the authoritative redemption when %s fails during synchronization",
    async (operation) => {
      const controller = await startController();
      vi.spyOn(client, operation).mockRejectedValue(new Error("Post-reset read failed."));

      await expect(
        controller.redeemUsageReset("preview-reset-credit", "reset-request"),
      ).resolves.toEqual({ code: "reset", creditId: "preview-reset-credit" });
      await vi.waitFor(() => {
        expect(
          operation === "readRateLimits"
            ? controller.rateLimitsError()
            : controller.usageResetsError(),
        ).toContain("Post-reset read failed.");
        expect(controller.usageResetRedeemingId()).toBeNull();
      });
    },
  );

  it("keeps the provider values when a confirmed redemption returns unchanged usage", async () => {
    const controller = await startController();
    const before = controller.rateLimits();
    vi.spyOn(client, "redeemUsageReset").mockResolvedValue({
      code: "reset",
      creditId: "preview-reset-credit",
    });

    await controller.redeemUsageReset("preview-reset-credit", "reset-request");

    expect(controller.rateLimits()).toEqual(before);
  });

  it("allows only one redemption at a time and preserves the request id for a retry", async () => {
    const controller = await startController();
    const pending = Promise.withResolvers<UsageResetRedemptionResponse>();
    const redeem = vi
      .spyOn(client, "redeemUsageReset")
      .mockImplementationOnce(() => pending.promise);
    const first = controller.redeemUsageReset("preview-reset-credit", "reset-request");
    await expect(
      controller.redeemUsageReset("preview-reset-credit", "second-request"),
    ).resolves.toBeNull();
    expect(redeem).toHaveBeenCalledTimes(1);
    pending.reject(new Error("Connection interrupted."));
    await expect(first).resolves.toBeNull();
    expect(controller.usageResetsError()).toContain("Connection interrupted.");
    expect(controller.usageResetRedeemingId()).toBeNull();
    expect(controller.usageResets()?.availableCount).toBe(1);

    await controller.redeemUsageReset("preview-reset-credit", "reset-request");
    expect(redeem).toHaveBeenNthCalledWith(2, "preview-reset-credit", "reset-request");
    await vi.waitFor(() => expect(controller.usageResets()?.availableCount).toBe(0));
  });

  it("ignores old read failures after a successful reset", async () => {
    const controller = await startController();
    const pendingLimits = Promise.withResolvers<AccountRateLimitsResponse>();
    const pendingCredits = Promise.withResolvers<UsageResetCreditsResponse>();
    vi.spyOn(client, "readRateLimits").mockImplementationOnce(() => pendingLimits.promise);
    const readCredits = vi
      .spyOn(client, "readUsageResets")
      .mockImplementationOnce(() => pendingCredits.promise);
    const olderLimits = controller.refreshRateLimits();
    const olderCredits = controller.refreshUsageResets();
    await vi.waitFor(() => expect(readCredits).toHaveBeenCalledTimes(1));
    await controller.redeemUsageReset("preview-reset-credit", "reset-request");
    pendingLimits.reject(new Error("Old limits request failed."));
    pendingCredits.reject(new Error("Old credits request failed."));
    await Promise.all([olderLimits, olderCredits]);

    expect(controller.rateLimitsError()).toBeNull();
    expect(controller.usageResetsError()).toBeNull();
    expect(controller.rateLimits()?.rateLimits.primary?.usedPercent).toBe(0);
    expect(controller.usageResets()?.availableCount).toBe(0);
  });

  it.each(["logout", "dispose"] as const)(
    "ignores a redemption completed after %s",
    async (transition) => {
      const controller = await startController();
      const pending = Promise.withResolvers<UsageResetRedemptionResponse>();
      vi.spyOn(client, "redeemUsageReset").mockImplementationOnce(() => pending.promise);
      const readLimits = vi.spyOn(client, "readRateLimits");
      const readCredits = vi.spyOn(client, "readUsageResets");
      const redemption = controller.redeemUsageReset("preview-reset-credit", "reset-request");
      if (transition === "logout") {
        vi.spyOn(client, "logout").mockResolvedValue({
          localCredentialsRemoved: true,
          remoteRevocation: "succeeded",
          remoteRevocationError: null,
        });
        await expect(controller.logout()).resolves.toBe(true);
        expect(controller.signedIn()).toBe(false);
      } else {
        dispose?.();
      }
      pending.resolve({ code: "reset", creditId: "preview-reset-credit" });

      await expect(redemption).resolves.toBeNull();
      expect(readLimits).not.toHaveBeenCalled();
      expect(readCredits).not.toHaveBeenCalled();
    },
  );
});
