import type {
  AccountProfileInvocation,
  AccountProfileResponse,
  AccountRateLimitsResponse,
  AccountReadResponse,
  AuthRefreshResult,
  AutoTopUpSettingsSnapshot,
  CancelLoginResponse,
  ChatGptAccount,
  CreditsSnapshot,
  LoginResponse,
  LogoutResponse,
  PlanPriceSnapshot,
  RateLimitSnapshot,
  RateLimitUpdateSnapshot,
  RateLimitWindow,
  SpendControlLimitSnapshot,
  UsageResetCredit,
  UsageResetCreditsResponse,
  UsageResetRedemptionResponse,
} from "../types";
import { PLAN_TYPES, RATE_LIMIT_REACHED_TYPES, REASONING_EFFORTS } from "./constants";
import {
  ACCOUNT_PROFILE_DAILY_USAGE_MAXIMUM_ENTRIES,
  array,
  booleanValue,
  ContractError,
  exactRecord,
  field,
  finiteNumber,
  identifier,
  integer,
  isoDate,
  literal,
  nullableFiniteNumber,
  nullableSafeInteger,
  nullableText,
  record,
  text,
  urlText,
} from "./primitives";

export function decodeAccountReadResponse(value: unknown): AccountReadResponse {
  const object = exactRecord(value, "$", ["account", "refresh", "requiresOpenaiAuth"]);
  return {
    account: object.account === null ? null : decodeAccount(object.account, "$.account"),
    requiresOpenaiAuth: literal(object.requiresOpenaiAuth, "$.requiresOpenaiAuth", [true] as const),
    refresh: decodeRefresh(object.refresh, "$.refresh"),
  };
}

export function decodeAccountProfileResponse(value: unknown): AccountProfileResponse {
  const object = exactRecord(value, "$", [
    "activityInsights",
    "dailyUsage",
    "displayName",
    "picture",
    "statisticsStatus",
    "summary",
    "username",
  ]);
  const summary = exactRecord(object.summary, "$.summary", [
    "currentStreakDays",
    "lifetimeTokens",
    "longestRunningTurnSeconds",
    "longestStreakDays",
    "peakDailyTokens",
  ]);
  const activity = exactRecord(object.activityInsights, "$.activityInsights", [
    "fastModePercent",
    "mostUsedReasoningEffort",
    "mostUsedReasoningEffortPercent",
    "topInvocations",
    "totalSkillsUsed",
    "totalThreads",
    "uniqueSkillsUsed",
  ]);
  const dailyUsage =
    object.dailyUsage === null
      ? null
      : array(
          object.dailyUsage,
          "$.dailyUsage",
          decodeAccountProfileDailyUsage,
          ACCOUNT_PROFILE_DAILY_USAGE_MAXIMUM_ENTRIES,
        );
  if (dailyUsage !== null) {
    let previousDate: string | null = null;
    for (const [index, bucket] of dailyUsage.entries()) {
      if (previousDate !== null && bucket.date <= previousDate) {
        throw new ContractError(
          `$.dailyUsage[${index}].date`,
          "daily usage dates must be unique and strictly ascending",
        );
      }
      previousDate = bucket.date;
    }
  }
  return {
    displayName:
      object.displayName === null ? null : text(object.displayName, "$.displayName", 256),
    username: object.username === null ? null : text(object.username, "$.username", 64),
    picture: object.picture === null ? null : urlText(object.picture, "$.picture", ["https:"]),
    statisticsStatus: literal(object.statisticsStatus, "$.statisticsStatus", [
      "available",
      "unavailable",
    ] as const),
    summary: {
      lifetimeTokens: nullableSafeInteger(
        summary.lifetimeTokens,
        "$.summary.lifetimeTokens",
        Number.MAX_SAFE_INTEGER,
      ),
      peakDailyTokens: nullableSafeInteger(
        summary.peakDailyTokens,
        "$.summary.peakDailyTokens",
        Number.MAX_SAFE_INTEGER,
      ),
      longestRunningTurnSeconds: nullableSafeInteger(
        summary.longestRunningTurnSeconds,
        "$.summary.longestRunningTurnSeconds",
        Number.MAX_SAFE_INTEGER,
      ),
      currentStreakDays: nullableSafeInteger(
        summary.currentStreakDays,
        "$.summary.currentStreakDays",
        1_000_000,
      ),
      longestStreakDays: nullableSafeInteger(
        summary.longestStreakDays,
        "$.summary.longestStreakDays",
        1_000_000,
      ),
    },
    dailyUsage,
    activityInsights: {
      fastModePercent: nullableFiniteNumber(
        activity.fastModePercent,
        "$.activityInsights.fastModePercent",
        0,
        100,
      ),
      mostUsedReasoningEffort:
        activity.mostUsedReasoningEffort === null
          ? null
          : literal(
              activity.mostUsedReasoningEffort,
              "$.activityInsights.mostUsedReasoningEffort",
              REASONING_EFFORTS,
            ),
      mostUsedReasoningEffortPercent: nullableFiniteNumber(
        activity.mostUsedReasoningEffortPercent,
        "$.activityInsights.mostUsedReasoningEffortPercent",
        0,
        100,
      ),
      uniqueSkillsUsed: nullableSafeInteger(
        activity.uniqueSkillsUsed,
        "$.activityInsights.uniqueSkillsUsed",
        Number.MAX_SAFE_INTEGER,
      ),
      totalSkillsUsed: nullableSafeInteger(
        activity.totalSkillsUsed,
        "$.activityInsights.totalSkillsUsed",
        Number.MAX_SAFE_INTEGER,
      ),
      totalThreads: nullableSafeInteger(
        activity.totalThreads,
        "$.activityInsights.totalThreads",
        Number.MAX_SAFE_INTEGER,
      ),
      topInvocations:
        activity.topInvocations === null
          ? null
          : array(
              activity.topInvocations,
              "$.activityInsights.topInvocations",
              decodeAccountProfileInvocation,
              100,
            ),
    },
  };
}

export function decodeAccountProfileDailyUsage(value: unknown, path: string) {
  const object = exactRecord(value, path, ["date", "tokens"]);
  return {
    date: isoDate(object.date, `${path}.date`),
    tokens: integer(object.tokens, `${path}.tokens`, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function decodeAccountProfileInvocation(
  value: unknown,
  path: string,
): AccountProfileInvocation {
  const object = record(value, path);
  const type = literal(field(object, "type"), `${path}.type`, ["plugin", "skill"] as const);
  if (type === "plugin") {
    const plugin = exactRecord(object, path, ["id", "name", "type", "usageCount"]);
    return {
      type,
      id: plugin.id === null ? null : text(plugin.id, `${path}.id`, 256),
      name: text(plugin.name, `${path}.name`, 256),
      usageCount: integer(plugin.usageCount, `${path}.usageCount`, 0, Number.MAX_SAFE_INTEGER),
    };
  }
  const skill = exactRecord(object, path, ["id", "name", "pluginName", "type", "usageCount"]);
  return {
    type,
    id: skill.id === null ? null : text(skill.id, `${path}.id`, 256),
    name: text(skill.name, `${path}.name`, 256),
    pluginName:
      skill.pluginName === null ? null : text(skill.pluginName, `${path}.pluginName`, 256),
    usageCount: integer(skill.usageCount, `${path}.usageCount`, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function decodeLoginResponse(value: unknown): LoginResponse {
  const object = exactRecord(value, "$", ["authUrl", "loginId", "type"]);
  return {
    type: literal(object.type, "$.type", ["chatgpt"] as const),
    loginId: identifier(object.loginId, "$.loginId"),
    authUrl: urlText(object.authUrl, "$.authUrl", ["https:"]),
  };
}

export function decodeCancelLoginResponse(value: unknown): CancelLoginResponse {
  const object = exactRecord(value, "$", ["status"]);
  return { status: literal(object.status, "$.status", ["canceled", "notFound"] as const) };
}

export function decodeLogoutResponse(value: unknown): LogoutResponse {
  const object = exactRecord(value, "$", [
    "localCredentialsRemoved",
    "remoteRevocation",
    "remoteRevocationError",
  ]);
  return {
    localCredentialsRemoved: booleanValue(
      object.localCredentialsRemoved,
      "$.localCredentialsRemoved",
    ),
    remoteRevocation: literal(object.remoteRevocation, "$.remoteRevocation", [
      "failed",
      "notApplicable",
      "succeeded",
    ] as const),
    remoteRevocationError: nullableText(object.remoteRevocationError, "$.remoteRevocationError"),
  };
}

export function decodeAccountRateLimitsResponse(value: unknown): AccountRateLimitsResponse {
  const object = exactRecord(value, "$", [
    "additionalRateLimitsByLimitId",
    "generalRateLimit",
    "lunaReserveAvailable",
    "planPrice",
  ]);
  const byId = record(object.additionalRateLimitsByLimitId, "$.additionalRateLimitsByLimitId");
  const additionalRateLimitsByLimitId: Record<string, RateLimitSnapshot> = {};
  for (const [key, entry] of Object.entries(byId)) {
    if (key.length === 0 || key.length > 128) {
      throw new ContractError("$.additionalRateLimitsByLimitId", "contains an invalid bucket id");
    }
    const snapshot = decodeRateLimitSnapshot(entry, `$.additionalRateLimitsByLimitId.${key}`);
    if (key === "codex" || snapshot.limitId !== key) {
      throw new ContractError(
        `$.additionalRateLimitsByLimitId.${key}.limitId`,
        "must identify its additional bucket",
      );
    }
    additionalRateLimitsByLimitId[key] = snapshot;
  }
  const generalRateLimit = decodeRateLimitSnapshot(object.generalRateLimit, "$.generalRateLimit");
  if (generalRateLimit.limitId !== "codex") {
    throw new ContractError(
      "$.generalRateLimit.limitId",
      "must identify the canonical codex bucket",
    );
  }
  return {
    generalRateLimit,
    additionalRateLimitsByLimitId,
    lunaReserveAvailable: booleanValue(object.lunaReserveAvailable, "$.lunaReserveAvailable"),
    planPrice:
      object.planPrice === null ? null : decodePlanPriceSnapshot(object.planPrice, "$.planPrice"),
  };
}

export function decodeUsageResetCreditsResponse(value: unknown): UsageResetCreditsResponse {
  const object = exactRecord(value, "$", [
    "availableCount",
    "credits",
    "immediateResetPurchaseEligible",
  ]);
  return {
    credits: array(object.credits, "$.credits", decodeUsageResetCredit, 100),
    availableCount: integer(object.availableCount, "$.availableCount", 0, 1_000_000),
    immediateResetPurchaseEligible: booleanValue(
      object.immediateResetPurchaseEligible,
      "$.immediateResetPurchaseEligible",
    ),
  };
}

export function decodeUsageResetRedemptionResponse(value: unknown): UsageResetRedemptionResponse {
  const object = exactRecord(value, "$", ["code", "creditId"]);
  return {
    code: text(object.code, "$.code", 128),
    creditId: nullableText(object.creditId, "$.creditId", 256),
  };
}

export function decodeAutoTopUpSettingsSnapshot(value: unknown): AutoTopUpSettingsSnapshot {
  const object = exactRecord(value, "$", [
    "autoReloadCreditDiscountPolicy",
    "available",
    "hasPaymentMethod",
    "isEnabled",
    "maximumDiscountPercent",
    "rechargeMonthlyLimit",
    "rechargeTarget",
    "rechargeThreshold",
  ]);
  return {
    available: booleanValue(object.available, "$.available"),
    isEnabled: booleanValue(object.isEnabled, "$.isEnabled"),
    hasPaymentMethod: booleanValue(object.hasPaymentMethod, "$.hasPaymentMethod"),
    rechargeThreshold: nullableText(object.rechargeThreshold, "$.rechargeThreshold", 32),
    rechargeTarget: nullableText(object.rechargeTarget, "$.rechargeTarget", 32),
    rechargeMonthlyLimit: nullableText(object.rechargeMonthlyLimit, "$.rechargeMonthlyLimit", 32),
    autoReloadCreditDiscountPolicy: nullableText(
      object.autoReloadCreditDiscountPolicy,
      "$.autoReloadCreditDiscountPolicy",
      128,
    ),
    maximumDiscountPercent:
      object.maximumDiscountPercent === null
        ? null
        : integer(object.maximumDiscountPercent, "$.maximumDiscountPercent", 0, 100),
  };
}

export function decodeAccount(value: unknown, path: string): ChatGptAccount {
  const object = exactRecord(value, path, ["email", "name", "picture", "planType", "type"]);
  return {
    type: literal(object.type, `${path}.type`, ["chatgpt"] as const),
    email: nullableText(object.email, `${path}.email`),
    name: object.name === null ? null : text(object.name, `${path}.name`, 256),
    picture:
      object.picture === null
        ? null
        : urlText(object.picture, `${path}.picture`, ["data:", "https:"]),
    planType:
      object.planType === null ? null : literal(object.planType, `${path}.planType`, PLAN_TYPES),
  };
}

export function decodeRefresh(value: unknown, path: string): AuthRefreshResult {
  const object = exactRecord(value, path, ["error", "status"]);
  return {
    status: literal(object.status, `${path}.status`, [
      "failed",
      "notRequired",
      "succeeded",
      "superseded",
    ] as const),
    error: nullableText(object.error, `${path}.error`),
  };
}

export function decodeRateLimitSnapshot(value: unknown, path: string): RateLimitSnapshot {
  const object = exactRecord(value, path, [
    "credits",
    "individualLimit",
    "limitId",
    "limitName",
    "planType",
    "primary",
    "rateLimitReachedType",
    "secondary",
    "spendControlReached",
  ]);
  return {
    limitId: nullableText(object.limitId, `${path}.limitId`),
    limitName: nullableText(object.limitName, `${path}.limitName`),
    primary:
      object.primary === null ? null : decodeRateLimitWindow(object.primary, `${path}.primary`),
    secondary:
      object.secondary === null
        ? null
        : decodeRateLimitWindow(object.secondary, `${path}.secondary`),
    credits: object.credits === null ? null : decodeCredits(object.credits, `${path}.credits`),
    individualLimit:
      object.individualLimit === null
        ? null
        : decodeSpendControl(object.individualLimit, `${path}.individualLimit`),
    spendControlReached:
      object.spendControlReached === null
        ? null
        : booleanValue(object.spendControlReached, `${path}.spendControlReached`),
    planType:
      object.planType === null ? null : literal(object.planType, `${path}.planType`, PLAN_TYPES),
    rateLimitReachedType:
      object.rateLimitReachedType === null
        ? null
        : literal(
            object.rateLimitReachedType,
            `${path}.rateLimitReachedType`,
            RATE_LIMIT_REACHED_TYPES,
          ),
  };
}

export function decodeRateLimitUpdate(value: unknown, path: string): RateLimitUpdateSnapshot {
  const snapshot = decodeRateLimitSnapshot(value, path);
  if (snapshot.limitId === null) {
    throw new ContractError(`${path}.limitId`, "rolling updates require a bucket id");
  }
  return { ...snapshot, limitId: snapshot.limitId };
}

export function decodeRateLimitWindow(value: unknown, path: string): RateLimitWindow {
  const object = exactRecord(value, path, ["resetsAt", "usedPercent", "windowDurationMins"]);
  return {
    usedPercent: finiteNumber(object.usedPercent, `${path}.usedPercent`, 0, 100),
    windowDurationMins:
      object.windowDurationMins === null
        ? null
        : integer(
            object.windowDurationMins,
            `${path}.windowDurationMins`,
            1,
            Number.MAX_SAFE_INTEGER,
          ),
    resetsAt:
      object.resetsAt === null
        ? null
        : integer(object.resetsAt, `${path}.resetsAt`, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function decodePlanPriceSnapshot(value: unknown, path: string): PlanPriceSnapshot {
  const object = exactRecord(value, path, ["amount", "currency", "minorUnitExponent"]);
  const currency = text(object.currency, `${path}.currency`, 3);
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw new ContractError(`${path}.currency`, "must be a three-letter ISO currency code");
  }
  return {
    amount: integer(object.amount, `${path}.amount`, 1, Number.MAX_SAFE_INTEGER),
    currency,
    minorUnitExponent: integer(object.minorUnitExponent, `${path}.minorUnitExponent`, 0, 6),
  };
}

export function decodeCredits(value: unknown, path: string): CreditsSnapshot {
  const object = exactRecord(value, path, ["balance", "hasCredits", "unlimited"]);
  return {
    hasCredits: booleanValue(object.hasCredits, `${path}.hasCredits`),
    unlimited: booleanValue(object.unlimited, `${path}.unlimited`),
    balance: nullableText(object.balance, `${path}.balance`),
  };
}

export function decodeSpendControl(value: unknown, path: string): SpendControlLimitSnapshot {
  const object = exactRecord(value, path, ["limit", "remainingPercent", "resetsAt", "used"]);
  return {
    limit: text(object.limit, `${path}.limit`),
    used: text(object.used, `${path}.used`),
    remainingPercent: integer(object.remainingPercent, `${path}.remainingPercent`, 0, 100),
    resetsAt: integer(object.resetsAt, `${path}.resetsAt`, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function decodeUsageResetCredit(value: unknown, path: string): UsageResetCredit {
  const object = exactRecord(value, path, ["expiresAt", "id", "status", "title"]);
  return {
    id: identifier(object.id, `${path}.id`),
    title: nullableText(object.title, `${path}.title`, 512),
    status: text(object.status, `${path}.status`, 64),
    expiresAt:
      object.expiresAt === null
        ? null
        : integer(object.expiresAt, `${path}.expiresAt`, 0, Number.MAX_SAFE_INTEGER),
  };
}
