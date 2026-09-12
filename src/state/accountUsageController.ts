import { type Accessor, batch, createEffect, createSignal } from "solid-js";

import type {
  AccountProfileResponse,
  AccountRateLimitsResponse,
  AccountReadResponse,
  AutoTopUpSettingsSnapshot,
  RateLimitUpdateSnapshot,
  RuntimeDiagnostic,
  UsageResetCreditsResponse,
  UsageResetRedemptionResponse,
} from "../contracts/types";
import { formatMessage, type TranslationMessages } from "../i18n/messages";
import {
  describeError,
  disableAutoTopUp as disableAutoTopUpCommand,
  enableAutoTopUp as enableAutoTopUpCommand,
  readAccountProfile,
  readAutoTopUpSettings,
  readRateLimits,
  readUsageResets,
  redeemUsageReset as redeemUsageResetCommand,
  updateAutoTopUp as updateAutoTopUpCommand,
} from "../infrastructure/codexClient";
import { createAccountProfileRefreshCoordinator } from "./accountProfileRefresh";
import {
  createAccountUsageRefreshCoordinator,
  createBrowserAccountUsageRefreshHost,
} from "./accountUsageRefresh";
import type { AppNotificationInput } from "./appNotifications";
import type { SessionControllerHost } from "./controllerSupport";
import { findUsageLimitReset } from "./notificationTransitions";
import { mergeRateLimitUpdate } from "./rateLimits";

export interface AccountUsageController {
  readonly accountProfile: Accessor<AccountProfileResponse | null>;
  readonly accountProfileError: Accessor<string | null>;
  readonly accountProfileLoading: Accessor<boolean>;
  readonly autoTopUpError: Accessor<string | null>;
  readonly autoTopUpLoading: Accessor<boolean>;
  readonly autoTopUpSettings: Accessor<AutoTopUpSettingsSnapshot | null>;
  readonly rateLimits: Accessor<AccountRateLimitsResponse | null>;
  readonly rateLimitsError: Accessor<string | null>;
  readonly rateLimitsLoading: Accessor<boolean>;
  readonly usageResetRedeemingId: Accessor<string | null>;
  readonly usageResets: Accessor<UsageResetCreditsResponse | null>;
  readonly usageResetsError: Accessor<string | null>;
  readonly usageResetsLoading: Accessor<boolean>;
  readonly applyRateLimitNotification: (rateLimits: RateLimitUpdateSnapshot) => void;
  readonly applySignedOut: () => void;
  readonly disableAutoTopUp: () => Promise<boolean>;
  readonly dispose: () => void;
  readonly enableAutoTopUp: (
    rechargeThreshold: string,
    rechargeTarget: string,
    rechargeMonthlyLimit: string | null,
  ) => Promise<boolean>;
  readonly invalidateProfileSession: () => void;
  readonly invalidateUsageSession: () => void;
  readonly redeemUsageReset: (
    creditId: string | null,
    redeemRequestId: string,
  ) => Promise<UsageResetRedemptionResponse | null>;
  readonly refreshAccountProfile: () => Promise<boolean>;
  readonly refreshAutoTopUpSettings: () => Promise<boolean>;
  readonly refreshRateLimits: () => Promise<boolean>;
  readonly refreshRateLimitsIfStale: () => Promise<boolean>;
  readonly refreshUsageResets: () => Promise<boolean>;
  readonly refreshUsageResetsIfStale: () => Promise<boolean>;
  readonly start: () => void;
  readonly updateAutoTopUp: (
    rechargeThreshold: string,
    rechargeTarget: string,
    rechargeMonthlyLimit: string | null,
  ) => Promise<boolean>;
}

export interface AccountUsageDependencies {
  readonly account: Accessor<AccountReadResponse | undefined>;
  readonly addDiagnostic: (diagnostic: RuntimeDiagnostic) => void;
  readonly applyAccountProfile: (profile: AccountProfileResponse) => void;
  readonly enqueueNotification: (input: AppNotificationInput) => boolean;
  readonly host: SessionControllerHost;
  readonly isSignedIn: () => boolean;
  readonly localization: {
    readonly notifications: Accessor<TranslationMessages["notifications"]>;
  };
  readonly onLunaReserveChanged: () => void;
}

export function createAccountUsageController(
  dependencies: AccountUsageDependencies,
): AccountUsageController {
  const {
    account,
    addDiagnostic,
    applyAccountProfile,
    enqueueNotification,
    host,
    isSignedIn,
    localization,
    onLunaReserveChanged,
  } = dependencies;

  const [accountProfile, setAccountProfile] = createSignal<AccountProfileResponse | null>(null);
  const [accountProfileError, setAccountProfileError] = createSignal<string | null>(null);
  const [accountProfileLoading, setAccountProfileLoading] = createSignal(false);
  const [rateLimits, setRateLimits] = createSignal<AccountRateLimitsResponse | null>(null);
  const [rateLimitsError, setRateLimitsError] = createSignal<string | null>(null);
  const [rateLimitsLoading, setRateLimitsLoading] = createSignal(false);
  const [usageResets, setUsageResets] = createSignal<UsageResetCreditsResponse | null>(null);
  const [usageResetsError, setUsageResetsError] = createSignal<string | null>(null);
  const [usageResetsLoading, setUsageResetsLoading] = createSignal(false);
  const [usageResetRedeemingId, setUsageResetRedeemingId] = createSignal<string | null>(null);
  const [autoTopUpSettings, setAutoTopUpSettings] = createSignal<AutoTopUpSettingsSnapshot | null>(
    null,
  );
  const [autoTopUpError, setAutoTopUpError] = createSignal<string | null>(null);
  const [autoTopUpLoading, setAutoTopUpLoading] = createSignal(false);

  let pendingAccountProfileReads = 0;
  let accountUsageSessionRevision = 0;
  let manualUsageResetNotificationPending = false;

  createEffect(() => {
    if (isSignedIn()) {
      return;
    }
    batch(() => {
      setUsageResets(null);
      setUsageResetsError(null);
      setUsageResetsLoading(false);
      setUsageResetRedeemingId(null);
      setAutoTopUpSettings(null);
      setAutoTopUpError(null);
      setAutoTopUpLoading(false);
    });
  });

  const refreshHost = createBrowserAccountUsageRefreshHost();
  const rateLimitRefresh = createAccountUsageRefreshCoordinator({
    getSessionKey: () => accountSessionKey(account()),
    read: () => {
      setRateLimitsError(null);
      return readRateLimits();
    },
    apply: applyRateLimits,
    setLoading: setRateLimitsLoading,
    reportError: (reason) => {
      setRateLimitsError(describeError(reason));
      addDiagnostic({ stream: "runtime", message: describeError(reason) });
    },
    host: refreshHost,
  });

  const usageResetRefresh = createAccountUsageRefreshCoordinator({
    getSessionKey: () => accountSessionKey(account()),
    read: () => {
      setUsageResetsError(null);
      return readUsageResets();
    },
    apply: applyUsageResets,
    setLoading: setUsageResetsLoading,
    reportError: (reason) => {
      const message = describeError(reason);
      setUsageResetsError(message);
      addDiagnostic({ stream: "runtime", message });
    },
    host: refreshHost,
  });

  const accountProfileRefresh = createAccountProfileRefreshCoordinator({
    getSessionKey: () => accountSessionKey(account()),
    read: readAccountProfileWithStatus,
    apply: (profile) => {
      setAccountProfile(profile);
      setAccountProfileError(null);
      applyAccountProfile(profile);
    },
    reportError: (reason) => {
      const message = describeError(reason);
      setAccountProfileError(message);
      addDiagnostic({ stream: "runtime", message });
    },
  });

  function invalidateUsageSession(): void {
    accountUsageSessionRevision += 1;
    manualUsageResetNotificationPending = false;
    usageResetRefresh.invalidate();
    rateLimitRefresh.invalidate();
    setUsageResetRedeemingId(null);
  }

  function invalidateProfileSession(): void {
    accountProfileRefresh.invalidateSession();
    pendingAccountProfileReads = 0;
    batch(() => {
      setAccountProfile(null);
      setAccountProfileError(null);
      setAccountProfileLoading(false);
    });
  }

  function applyRateLimits(value: AccountRateLimitsResponse): void {
    const previous = rateLimits();
    const reset = previous === null ? null : findUsageLimitReset(previous, value);
    if (reset !== null) {
      if (!manualUsageResetNotificationPending) {
        enqueueNotification({
          approval: null,
          id: `usage-limit-reset:${reset.limitId}:${reset.resetsAt}`,
          event: "usageLimitReset",
          tone: "success",
          title: localization.notifications().usageLimitResetTitle,
          message: formatMessage(localization.notifications().usageLimitResetMessage, {
            percent: reset.availablePercent,
          }),
          target: { type: "settings", page: "usage" },
        });
      }
      manualUsageResetNotificationPending = false;
    }
    if (previous?.lunaReserveAvailable !== true && value.lunaReserveAvailable) {
      enqueueNotification({
        approval: null,
        id: `luna-reserve-available:${value.generalRateLimit.primary?.resetsAt ?? "current"}`,
        event: "lunaReserveAvailable",
        tone: "attention",
        title: localization.notifications().lunaReserveAvailableTitle,
        message: localization.notifications().lunaReserveAvailableMessage,
        target: { type: "settings", page: "usage" },
      });
    }
    const previousAvailability = previous?.lunaReserveAvailable ?? false;
    batch(() => {
      setRateLimits(value);
      setRateLimitsError(null);
    });
    if (previousAvailability !== value.lunaReserveAvailable) {
      onLunaReserveChanged();
    }
    void usageResetRefresh.refreshIfStale();
  }

  function applyRateLimitNotification(update: RateLimitUpdateSnapshot): void {
    const current = rateLimits();
    if (current === null) {
      void rateLimitRefresh.refresh();
      return;
    }
    applyRateLimits(mergeRateLimitUpdate(current, update));
  }

  function applySignedOut(): void {
    setRateLimits(null);
    setRateLimitsError(null);
  }

  async function readAccountProfileWithStatus(): Promise<AccountProfileResponse> {
    pendingAccountProfileReads += 1;
    batch(() => {
      setAccountProfileLoading(true);
      setAccountProfileError(null);
    });
    try {
      return await readAccountProfile();
    } finally {
      pendingAccountProfileReads = Math.max(0, pendingAccountProfileReads - 1);
      setAccountProfileLoading(pendingAccountProfileReads > 0);
    }
  }

  function applyUsageResets(value: UsageResetCreditsResponse): void {
    const previous = usageResets();
    const previousAvailableIds = new Set(
      previous?.credits
        .filter((credit) => credit.status === "available")
        .map((credit) => credit.id) ?? [],
    );
    const available = value.credits.filter((credit) => credit.status === "available");
    const added = available.filter((credit) => !previousAvailableIds.has(credit.id));
    const countIncreased = value.availableCount > (previous?.availableCount ?? 0);
    setUsageResets(value);
    const identity = added[0]?.id ?? (countIncreased ? `count-${value.availableCount}` : null);
    if (value.availableCount === 0 || identity === null) return;

    enqueueNotification({
      approval: null,
      id: `usage-reset-available:${identity}`,
      event: "usageResetAvailable",
      tone: "attention",
      title: localization.notifications().usageResetAvailableTitle,
      message: formatMessage(
        value.availableCount === 1
          ? localization.notifications().usageResetAvailableMessage
          : localization.notifications().usageResetsAvailableMessage,
        { count: value.availableCount },
      ),
      target: { type: "settings", page: "usage" },
    });
  }

  async function redeemUsageReset(
    creditId: string | null,
    redeemRequestId: string,
  ): Promise<UsageResetRedemptionResponse | null> {
    const sessionRevision = accountUsageSessionRevision;
    const sessionKey = accountSessionKey(account());
    const isCurrentSession = () =>
      !host.isDisposed() &&
      sessionRevision === accountUsageSessionRevision &&
      sessionKey === accountSessionKey(account());
    if (host.isDisposed() || sessionKey === null || usageResetRedeemingId() !== null) {
      return null;
    }
    let synchronizationContinues = false;
    setUsageResetRedeemingId(creditId ?? "automatic");
    setUsageResetsError(null);
    try {
      const response = await redeemUsageResetCommand(creditId, redeemRequestId);
      if (!isCurrentSession()) return null;
      if (response.code === "reset" || response.code === "already_redeemed") {
        manualUsageResetNotificationPending = enqueueNotification({
          approval: null,
          id: `usage-limit-reset:manual:${redeemRequestId}`,
          event: "usageLimitReset",
          tone: "success",
          title: localization.notifications().usageLimitResetTitle,
          message: localization.notifications().usageResetRedeemedMessage,
          target: { type: "settings", page: "usage" },
        });
        usageResetRefresh.invalidate();
        rateLimitRefresh.invalidate();
        const synchronization = Promise.all([
          usageResetRefresh.refresh(),
          rateLimitRefresh.refresh(),
        ]);
        synchronizationContinues = true;
        void synchronization.then(
          () => {
            if (isCurrentSession()) setUsageResetRedeemingId(null);
          },
          (reason: unknown) => {
            if (!isCurrentSession()) return;
            setUsageResetRedeemingId(null);
            host.reportError(reason);
          },
        );
      } else {
        setUsageResetsError(usageResetRedemptionError(response.code));
      }
      return response;
    } catch (reason) {
      if (!isCurrentSession()) return null;
      const message = describeError(reason);
      setUsageResetsError(message);
      addDiagnostic({ stream: "runtime", message });
      return null;
    } finally {
      if (!synchronizationContinues && isCurrentSession()) setUsageResetRedeemingId(null);
    }
  }

  async function refreshAutoTopUpSettings(): Promise<boolean> {
    if (!isSignedIn()) {
      return false;
    }
    setAutoTopUpLoading(true);
    setAutoTopUpError(null);
    try {
      setAutoTopUpSettings(await readAutoTopUpSettings());
      return true;
    } catch (reason) {
      const message = describeError(reason);
      setAutoTopUpError(message);
      addDiagnostic({ stream: "runtime", message });
      return false;
    } finally {
      setAutoTopUpLoading(false);
    }
  }

  async function enableAutoTopUp(
    rechargeThreshold: string,
    rechargeTarget: string,
    rechargeMonthlyLimit: string | null,
  ): Promise<boolean> {
    return mutateAutoTopUp(() =>
      enableAutoTopUpCommand(rechargeThreshold, rechargeTarget, rechargeMonthlyLimit),
    );
  }

  async function updateAutoTopUp(
    rechargeThreshold: string,
    rechargeTarget: string,
    rechargeMonthlyLimit: string | null,
  ): Promise<boolean> {
    return mutateAutoTopUp(() =>
      updateAutoTopUpCommand(rechargeThreshold, rechargeTarget, rechargeMonthlyLimit),
    );
  }

  async function disableAutoTopUp(): Promise<boolean> {
    return mutateAutoTopUp(disableAutoTopUpCommand);
  }

  async function mutateAutoTopUp(
    operation: () => Promise<AutoTopUpSettingsSnapshot>,
  ): Promise<boolean> {
    if (!isSignedIn() || autoTopUpLoading()) {
      return false;
    }
    setAutoTopUpLoading(true);
    setAutoTopUpError(null);
    try {
      setAutoTopUpSettings(await operation());
      void rateLimitRefresh.refresh();
      return true;
    } catch (reason) {
      const message = describeError(reason);
      setAutoTopUpError(message);
      addDiagnostic({ stream: "runtime", message });
      return false;
    } finally {
      setAutoTopUpLoading(false);
    }
  }

  return {
    accountProfile,
    accountProfileError,
    accountProfileLoading,
    autoTopUpError,
    autoTopUpLoading,
    autoTopUpSettings,
    rateLimits,
    rateLimitsError,
    rateLimitsLoading,
    usageResetRedeemingId,
    usageResets,
    usageResetsError,
    usageResetsLoading,
    applyRateLimitNotification,
    applySignedOut,
    disableAutoTopUp,
    dispose: () => {
      accountProfileRefresh.dispose();
      rateLimitRefresh.dispose();
      usageResetRefresh.dispose();
    },
    enableAutoTopUp,
    invalidateProfileSession,
    invalidateUsageSession,
    redeemUsageReset,
    refreshAccountProfile: () => accountProfileRefresh.refreshIfStale(),
    refreshAutoTopUpSettings,
    refreshRateLimits: () => rateLimitRefresh.refresh(),
    refreshRateLimitsIfStale: () => rateLimitRefresh.refreshIfStale(),
    refreshUsageResets: () => usageResetRefresh.refresh(),
    refreshUsageResetsIfStale: () => usageResetRefresh.refreshIfStale(),
    start: () => {
      rateLimitRefresh.start();
      usageResetRefresh.start();
    },
    updateAutoTopUp,
  };
}

function accountSessionKey(value: AccountReadResponse | undefined): string | null {
  const currentAccount = value?.account;
  return currentAccount === null || currentAccount === undefined
    ? null
    : (currentAccount.email ?? "chatgpt");
}

function usageResetRedemptionError(code: string): string {
  switch (code) {
    case "expired":
    case "credit_expired":
      return "This reset has expired and can no longer be used.";
    case "not_available":
    case "no_credits_available":
      return "No reset is available to use.";
    case "ineligible":
    case "not_eligible":
      return "This account is not eligible to use the reset.";
    default:
      return `The account reset could not be used (${code}).`;
  }
}
