import { createEffect, createSignal, For, onMount, Show } from "solid-js";

import type {
  AutoTopUpSettingsSnapshot,
  CreditsSnapshot,
  SpendControlLimitSnapshot,
  UsageResetCredit,
} from "../contracts/types";
import { useI18n } from "../i18n/context";
import { formatMessage } from "../i18n/messages";
import { generalRateLimitSnapshot } from "../state/rateLimits";

import { accountPlanLabel } from "./accountPresentation";
import { formatShortDate, formatShortDateWithTimeZone } from "./dateFormat";
import { useExternalNavigation } from "./ExternalNavigation";
import { Icon } from "./Icon";
import { SettingsHeading, SettingsSection } from "./SettingsPrimitives";
import {
  AUTO_TOP_UP_DEFAULT_RECHARGE_TARGET,
  AUTO_TOP_UP_DEFAULT_RECHARGE_THRESHOLD,
  type SettingsDialogController,
  type SettingsMessages,
} from "./settingsShared";
import { presentUsageLimits, type UsageLimitEntry, usagePercentLabel } from "./usagePresentation";

export function UsageSettings(props: { readonly controller: SettingsDialogController }) {
  const i18n = useI18n();
  const openExternalUrl = useExternalNavigation();
  const messages = () => i18n.messages().settings;
  const rateLimits = () => props.controller.rateLimits();
  const snapshot = () => generalRateLimitSnapshot(rateLimits());
  const autoTopUp = () => props.controller.autoTopUpSettings();
  const [autoTopUpEditing, setAutoTopUpEditing] = createSignal(false);
  const [rechargeThreshold, setRechargeThreshold] = createSignal(
    AUTO_TOP_UP_DEFAULT_RECHARGE_THRESHOLD,
  );
  const [rechargeTarget, setRechargeTarget] = createSignal(AUTO_TOP_UP_DEFAULT_RECHARGE_TARGET);
  const [rechargeMonthlyLimit, setRechargeMonthlyLimit] = createSignal("");
  const [confirmReset, setConfirmReset] = createSignal<{
    readonly key: string;
    readonly requestId: string;
  } | null>(null);
  const [resetSuccess, setResetSuccess] = createSignal<string | null>(null);

  onMount(() => {
    void Promise.all([
      props.controller.refreshRateLimitsIfStale(),
      props.controller.refreshUsageResets(),
      props.controller.refreshAutoTopUpSettings(),
    ]);
  });
  createEffect(() => {
    const settings = autoTopUp();
    if (settings === null || autoTopUpEditing()) {
      return;
    }
    setRechargeThreshold(settings.rechargeThreshold ?? AUTO_TOP_UP_DEFAULT_RECHARGE_THRESHOLD);
    setRechargeTarget(settings.rechargeTarget ?? AUTO_TOP_UP_DEFAULT_RECHARGE_TARGET);
    setRechargeMonthlyLimit(settings.rechargeMonthlyLimit ?? "");
  });

  const limitGroups = () => presentUsageLimits(rateLimits(), messages(), i18n.locale());
  const credits = () => snapshot()?.credits ?? null;
  const planPrice = () => rateLimits()?.planPrice ?? null;
  const spendControl = () => snapshot()?.individualLimit ?? null;
  const availableResetCredits = () =>
    props.controller.usageResets()?.credits.filter((credit) => credit.status === "available") ?? [];
  const resetRows = (): readonly (UsageResetCredit | null)[] => {
    const credits = availableResetCredits();
    if (credits.length > 0) {
      return credits;
    }
    return (props.controller.usageResets()?.availableCount ?? 0) > 0 ? [null] : [];
  };

  async function useReset(credit: UsageResetCredit | null): Promise<void> {
    const key = credit?.id ?? "automatic";
    const confirmation = confirmReset();
    if (confirmation?.key !== key) {
      setConfirmReset({ key, requestId: crypto.randomUUID() });
      setResetSuccess(null);
      return;
    }
    const response = await props.controller.redeemUsageReset(
      credit?.id ?? null,
      confirmation.requestId,
    );
    if (response?.code === "reset" || response?.code === "already_redeemed") {
      setConfirmReset(null);
      setResetSuccess(messages().resetSuccess);
    }
  }

  async function toggleAutoTopUp(): Promise<void> {
    const settings = autoTopUp();
    if (settings?.isEnabled) {
      if (await props.controller.disableAutoTopUp()) {
        setAutoTopUpEditing(false);
      }
      return;
    }
    await props.controller.enableAutoTopUp(
      rechargeThreshold(),
      rechargeTarget(),
      normalizedOptionalCreditValue(rechargeMonthlyLimit()),
    );
  }

  async function saveAutoTopUpSettings(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const settings = autoTopUp();
    const operation = settings?.isEnabled
      ? props.controller.updateAutoTopUp
      : props.controller.enableAutoTopUp;
    if (
      await operation(
        rechargeThreshold(),
        rechargeTarget(),
        normalizedOptionalCreditValue(rechargeMonthlyLimit()),
      )
    ) {
      setAutoTopUpEditing(false);
    }
  }

  return (
    <div class="settings-page">
      <SettingsHeading title={messages().usageBilling} description={messages().usageDescription} />
      <Show when={snapshot()}>
        {(current) => (
          <SettingsSection title={messages().yourPlan}>
            <div class="usage-plan">
              <span>
                <strong>{accountPlanLabel(current().planType, i18n.messages().account)}</strong>
                <small>
                  {planPriceLabel(planPrice(), i18n.locale(), messages()) ?? messages().currentPlan}
                </small>
              </span>
              <button
                class="usage-credits-button"
                onClick={() => void openExternalUrl("https://chatgpt.com/membership/plans")}
                type="button"
              >
                {messages().viewPlans}
              </button>
            </div>
          </SettingsSection>
        )}
      </Show>
      <Show when={credits() !== null || autoTopUp() !== null || props.controller.autoTopUpError()}>
        <SettingsSection
          description={messages().creditBalanceDescription}
          title={messages().creditBalance}
        >
          <Show when={credits()}>
            {(snap) => (
              <div class="usage-credits usage-credit-balance">
                <span>
                  <strong>{creditsLabel(snap(), messages())}</strong>
                  <small>{messages().balance}</small>
                </span>
                <button
                  class="usage-credits-button"
                  onClick={() => void openExternalUrl("https://chatgpt.com/settings/billing")}
                  type="button"
                >
                  {messages().buyCredits}
                </button>
              </div>
            )}
          </Show>
          <Show
            when={autoTopUp()}
            fallback={
              <div class="usage-auto-top-up-state">
                <span>
                  {props.controller.autoTopUpLoading()
                    ? messages().loadingAutoTopUp
                    : (props.controller.autoTopUpError() ?? messages().autoTopUpUnavailable)}
                </span>
                <Show when={!props.controller.autoTopUpLoading()}>
                  <button
                    class="usage-inline-action"
                    onClick={() => void props.controller.refreshAutoTopUpSettings()}
                    type="button"
                  >
                    {i18n.messages().common.tryAgain}
                  </button>
                </Show>
              </div>
            }
          >
            {(settings) => (
              <>
                <div class="usage-auto-top-up-row">
                  <span class="usage-auto-top-up-copy">
                    <strong>{messages().autoTopUp}</strong>
                    <small>{autoTopUpDescription(settings(), messages())}</small>
                  </span>
                  <span class="usage-auto-top-up-actions">
                    <Show when={settings().maximumDiscountPercent}>
                      {(discount) => (
                        <span class="usage-discount-badge">
                          {formatMessage(messages().discount, { percent: discount() })}
                        </span>
                      )}
                    </Show>
                    <Show when={settings().isEnabled}>
                      <button
                        class="usage-inline-action"
                        onClick={() => setAutoTopUpEditing((value) => !value)}
                        type="button"
                      >
                        {messages().manage}
                      </button>
                    </Show>
                    <button
                      aria-checked={settings().isEnabled}
                      aria-label={messages().toggleAutoTopUp}
                      class="usage-switch"
                      classList={{ checked: settings().isEnabled }}
                      disabled={props.controller.autoTopUpLoading()}
                      onClick={() => void toggleAutoTopUp()}
                      role="switch"
                      type="button"
                    >
                      <span />
                    </button>
                  </span>
                </div>
                <Show when={autoTopUpEditing()}>
                  <form class="usage-auto-top-up-editor" onSubmit={saveAutoTopUpSettings}>
                    <label>
                      <span>{messages().rechargeThreshold}</span>
                      <input
                        min="125"
                        onInput={(event) => setRechargeThreshold(event.currentTarget.value)}
                        required
                        step="1"
                        type="number"
                        value={rechargeThreshold()}
                      />
                    </label>
                    <label>
                      <span>{messages().rechargeTarget}</span>
                      <input
                        max="250000"
                        min="250"
                        onInput={(event) => setRechargeTarget(event.currentTarget.value)}
                        required
                        step="1"
                        type="number"
                        value={rechargeTarget()}
                      />
                    </label>
                    <label>
                      <span>{messages().optionalMonthlyLimit}</span>
                      <input
                        min="250"
                        onInput={(event) => setRechargeMonthlyLimit(event.currentTarget.value)}
                        placeholder={messages().noLimit}
                        step="1"
                        type="number"
                        value={rechargeMonthlyLimit()}
                      />
                    </label>
                    <div class="usage-auto-top-up-editor-actions">
                      <button
                        class="usage-inline-action"
                        onClick={() => setAutoTopUpEditing(false)}
                        type="button"
                      >
                        {i18n.messages().common.cancel}
                      </button>
                      <button
                        class="usage-credits-button"
                        disabled={props.controller.autoTopUpLoading()}
                        type="submit"
                      >
                        {props.controller.autoTopUpLoading() ? messages().saving : messages().save}
                      </button>
                    </div>
                  </form>
                </Show>
                <Show when={props.controller.autoTopUpError()}>
                  {(message) => <p class="usage-inline-error">{message()}</p>}
                </Show>
              </>
            )}
          </Show>
        </SettingsSection>
      </Show>
      <Show
        when={limitGroups().length > 0}
        fallback={
          <SettingsSection
            busy={props.controller.rateLimitsLoading()}
            title={messages().generalLimits}
          >
            <div
              aria-live="polite"
              class="usage-empty"
              classList={{ "usage-empty-error": props.controller.rateLimitsError() !== null }}
            >
              <span class="usage-empty-icon">
                <Icon
                  name={props.controller.rateLimitsError() === null ? "creditCard" : "helpCircle"}
                  size={18}
                />
              </span>
              <div>
                <strong>
                  {props.controller.rateLimitsLoading()
                    ? messages().usageDetailsLoading
                    : props.controller.rateLimitsError() === null
                      ? messages().usageDetailsUnavailable
                      : messages().usageDetailsFailure}
                </strong>
                <p>
                  {props.controller.rateLimitsLoading()
                    ? messages().usageDetailsWait
                    : (props.controller.rateLimitsError() ?? messages().usageDetailsRefresh)}
                </p>
              </div>
            </div>
          </SettingsSection>
        }
      >
        <For each={limitGroups()}>
          {(group) => (
            <SettingsSection
              busy={props.controller.rateLimitsLoading()}
              title={
                group.label === null
                  ? messages().generalLimits
                  : formatMessage(messages().namedLimits, { name: group.label })
              }
            >
              <section class="usage-limit-group">
                <For each={group.limits}>
                  {(limit) => (
                    <UsageMeter
                      limit={limit}
                      locale={i18n.locale()}
                      messages={messages()}
                      soonLabel={i18n.messages().common.soon}
                    />
                  )}
                </For>
              </section>
            </SettingsSection>
          )}
        </For>
      </Show>
      <Show when={spendControl()}>
        {(limit) => (
          <SettingsSection title={messages().spendLimit}>
            <SpendControlMeter
              limit={limit()}
              locale={i18n.locale()}
              messages={messages()}
              soonLabel={i18n.messages().common.soon}
            />
          </SettingsSection>
        )}
      </Show>
      <SettingsSection busy={props.controller.usageResetsLoading()} title={messages().usageResets}>
        <Show
          when={
            !props.controller.usageResetsLoading() ||
            props.controller.usageResets() !== null ||
            props.controller.usageResetsError() !== null
          }
          fallback={<div class="usage-reset-state">{messages().loadingResets}</div>}
        >
          <Show
            when={props.controller.usageResetsError() === null || resetRows().length > 0}
            fallback={
              <div class="usage-reset-state">
                <span>{props.controller.usageResetsError()}</span>
                <button
                  class="usage-inline-action"
                  onClick={() => void props.controller.refreshUsageResets()}
                  type="button"
                >
                  {i18n.messages().common.tryAgain}
                </button>
              </div>
            }
          >
            <Show
              when={resetRows().length > 0}
              fallback={
                <div class="usage-reset-state usage-reset-empty">{messages().noResets}</div>
              }
            >
              <For each={resetRows()}>
                {(credit) => {
                  const key = () => credit?.id ?? "automatic";
                  const confirming = () => confirmReset()?.key === key();
                  const resetting = () => props.controller.usageResetRedeemingId() === key();
                  return (
                    <div class="usage-reset-row">
                      <span>
                        <strong>{credit?.title?.trim() || messages().fullReset}</strong>
                        <Show when={credit?.expiresAt}>
                          {(expiration) => (
                            <small>
                              {formatMessage(messages().expires, {
                                date: formatShortDateWithTimeZone(
                                  expiration(),
                                  i18n.locale(),
                                  i18n.messages().common.soon,
                                ),
                              })}
                            </small>
                          )}
                        </Show>
                      </span>
                      <button
                        class="usage-reset-button"
                        disabled={props.controller.usageResetRedeemingId() !== null && !resetting()}
                        onClick={() => void useReset(credit)}
                        type="button"
                      >
                        {resetting()
                          ? messages().resetting
                          : confirming()
                            ? messages().confirm
                            : messages().useReset}
                      </button>
                    </div>
                  );
                }}
              </For>
            </Show>
          </Show>
        </Show>
        <Show when={resetSuccess()}>
          {(message) => <p class="usage-inline-success">{message()}</p>}
        </Show>
        <Show when={props.controller.usageResetsError() !== null && resetRows().length > 0}>
          <p class="usage-inline-error">{props.controller.usageResetsError()}</p>
        </Show>
        <Show when={props.controller.usageResets()?.immediateResetPurchaseEligible}>
          <button
            class="usage-inline-action usage-buy-reset"
            onClick={() => void openExternalUrl("https://chatgpt.com/settings/usage")}
            type="button"
          >
            {messages().buyInstantReset}
          </button>
        </Show>
      </SettingsSection>
    </div>
  );
}

export function normalizedOptionalCreditValue(value: string): string | null {
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

export function planPriceLabel(
  price: NonNullable<ReturnType<SettingsDialogController["rateLimits"]>>["planPrice"],
  locale: string,
  messages: SettingsMessages,
): string | null {
  if (price === null) {
    return null;
  }
  const amount = price.amount / 10 ** price.minorUnitExponent;
  const formattedPrice = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: price.currency,
  }).format(amount);
  return formatMessage(messages.perMonth, { price: formattedPrice });
}

export function autoTopUpDescription(
  settings: AutoTopUpSettingsSnapshot,
  messages: SettingsMessages,
): string {
  if (!settings.isEnabled) {
    return messages.autoTopUpDisabledDescription;
  }
  const threshold = settings.rechargeThreshold ?? "—";
  const target = settings.rechargeTarget ?? "—";
  const monthly =
    settings.rechargeMonthlyLimit === null
      ? ""
      : formatMessage(messages.autoTopUpMonthlyLimit, {
          limit: settings.rechargeMonthlyLimit,
        });
  return formatMessage(messages.autoTopUpEnabledDescription, { monthly, target, threshold });
}

export function UsageMeter(props: {
  readonly limit: UsageLimitEntry;
  readonly locale: string;
  readonly messages: SettingsMessages;
  readonly soonLabel: string;
}) {
  const remaining = () => usagePercentLabel(props.limit.remainingPercent);
  const remainingLabel = () => formatMessage(props.messages.remaining, { value: remaining() });
  const resetLabel = () =>
    usageResetLabel(props.limit, props.locale, props.soonLabel, props.messages);
  return (
    <div class="usage-meter-row">
      <span class="usage-meter-copy">
        <strong>{props.limit.label}</strong>
        <Show when={resetLabel()}>{(label) => <small>{label()}</small>}</Show>
      </span>
      <div class="usage-meter-status">
        <progress
          aria-label={`${props.limit.label}: ${remainingLabel()}`}
          class="usage-meter usage-limit-meter"
          max={100}
          value={props.limit.remainingPercent}
        >
          {remaining()}
        </progress>
        <strong>{remainingLabel()}</strong>
      </div>
    </div>
  );
}

export function usageResetLabel(
  limit: UsageLimitEntry,
  locale: string,
  soonLabel: string,
  messages: SettingsMessages,
): string | null {
  if (limit.resetAt === null) {
    return null;
  }
  if (limit.windowDurationMins !== null && limit.windowDurationMins < 24 * 60) {
    return formatMessage(messages.resetsAt, {
      date: formatShortDate(limit.resetAt, locale, soonLabel),
    });
  }
  return formatMessage(messages.resetAt, {
    date: formatShortDate(limit.resetAt, locale, soonLabel),
  });
}

export function SpendControlMeter(props: {
  readonly limit: SpendControlLimitSnapshot;
  readonly locale: string;
  readonly messages: SettingsMessages;
  readonly soonLabel: string;
}) {
  const usedPercent = () => Math.max(0, Math.min(100, 100 - props.limit.remainingPercent));
  return (
    <div class="usage-meter-row">
      <span class="usage-meter-copy">
        <strong>{props.messages.spendLimit}</strong>
        <small>
          {formatMessage(props.messages.usedOf, {
            used: props.limit.used,
            limit: props.limit.limit,
          })}
          <i>
            {" · "}
            {formatMessage(props.messages.resetsAt, {
              date: formatShortDate(props.limit.resetsAt, props.locale, props.soonLabel),
            })}
          </i>
        </small>
      </span>
      <progress class="usage-meter" max={100} value={usedPercent()}>
        {usedPercent()}%
      </progress>
    </div>
  );
}

export function creditsLabel(credits: CreditsSnapshot, messages: SettingsMessages): string {
  if (credits.unlimited) {
    return messages.unlimited;
  }
  return credits.balance ?? "—";
}
