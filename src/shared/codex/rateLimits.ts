import { isJsonObject, type JsonObject, type JsonValue } from "./types";
import type {
  AccountPlanType,
  AccountRateLimitsResponse,
  AccountRateLimitsUpdatedNotification,
  CreditsSnapshot,
  RateLimitReachedType,
  RateLimitResetCredit,
  RateLimitResetCreditsSummary,
  RateLimitResetCreditStatus,
  RateLimitResetType,
  RateLimitSnapshot,
  RateLimitWindow,
  SpendControlLimitSnapshot,
} from "./rateLimitTypes";

const ACCOUNT_PLAN_TYPES = new Set<AccountPlanType>([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_prolite",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
]);

const RATE_LIMIT_REACHED_TYPES = new Set<RateLimitReachedType>([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

const RESET_TYPES = new Set<RateLimitResetType>(["codexRateLimits", "unknown"]);
const RESET_STATUSES = new Set<RateLimitResetCreditStatus>([
  "available",
  "redeeming",
  "redeemed",
  "unknown",
]);

export function parseAccountRateLimitsResponse(
  value: JsonValue,
): AccountRateLimitsResponse {
  const response = requireObject(value, "account/rateLimits/read");
  const rawByLimitId = response.rateLimitsByLimitId;

  return {
    rateLimits: parseRateLimitSnapshot(
      response.rateLimits,
      "account/rateLimits/read.rateLimits",
    ),
    rateLimitsByLimitId:
      rawByLimitId === null
        ? null
        : parseSnapshotsByLimitId(
            requireObject(
              rawByLimitId,
              "account/rateLimits/read.rateLimitsByLimitId",
            ),
          ),
    rateLimitResetCredits: parseNullableResetCredits(
      response.rateLimitResetCredits,
      "account/rateLimits/read.rateLimitResetCredits",
    ),
  };
}

export function parseAccountRateLimitsUpdatedNotification(
  value: JsonValue,
): AccountRateLimitsUpdatedNotification {
  const notification = requireObject(value, "account/rateLimits/updated");
  return {
    rateLimits: parseRateLimitSnapshot(
      notification.rateLimits,
      "account/rateLimits/updated.rateLimits",
    ),
  };
}

export function mergeAccountRateLimitsUpdate(
  current: AccountRateLimitsResponse,
  update: RateLimitSnapshot,
): AccountRateLimitsResponse {
  const limitId = update.limitId ?? "codex";
  const currentById = current.rateLimitsByLimitId ?? {};
  const currentPrimary = current.rateLimits;
  const primaryId = currentPrimary.limitId ?? "codex";
  const previous = currentById[limitId]
    ?? (primaryId === limitId ? currentPrimary : undefined);
  const merged = mergeRateLimitSnapshot(previous, update, limitId);

  return {
    rateLimits:
      primaryId === limitId
        ? merged
        : currentPrimary,
    rateLimitsByLimitId: {
      ...currentById,
      [limitId]: merged,
    },
    rateLimitResetCredits: current.rateLimitResetCredits,
  };
}

function mergeRateLimitSnapshot(
  previous: RateLimitSnapshot | undefined,
  update: RateLimitSnapshot,
  limitId: string,
): RateLimitSnapshot {
  return {
    limitId: update.limitId ?? previous?.limitId ?? limitId,
    limitName: update.limitName ?? previous?.limitName ?? null,
    // Rolling snapshots authoritatively replace usage windows. Account metadata
    // is nullable and must retain the value learned from the full read.
    primary: update.primary,
    secondary: update.secondary,
    credits: update.credits ?? previous?.credits ?? null,
    individualLimit: update.individualLimit ?? previous?.individualLimit ?? null,
    spendControlReached:
      update.spendControlReached ?? previous?.spendControlReached ?? null,
    planType: update.planType ?? previous?.planType ?? null,
    rateLimitReachedType:
      update.rateLimitReachedType ?? previous?.rateLimitReachedType ?? null,
  };
}

function parseSnapshotsByLimitId(
  value: JsonObject,
): Record<string, RateLimitSnapshot> {
  return Object.fromEntries(
    Object.entries(value).map(([limitId, snapshot]) => [
      limitId,
      parseRateLimitSnapshot(
        snapshot,
        `account/rateLimits/read.rateLimitsByLimitId.${limitId}`,
      ),
    ]),
  );
}

function parseRateLimitSnapshot(
  value: JsonValue | undefined,
  context: string,
): RateLimitSnapshot {
  const snapshot = requireObject(value, context);
  return {
    limitId: requireNullableString(snapshot, "limitId", context),
    limitName: requireNullableString(snapshot, "limitName", context),
    primary: parseNullableWindow(snapshot.primary, `${context}.primary`),
    secondary: parseNullableWindow(snapshot.secondary, `${context}.secondary`),
    credits: parseNullableCredits(snapshot.credits, `${context}.credits`),
    individualLimit: parseNullableIndividualLimit(
      snapshot.individualLimit,
      `${context}.individualLimit`,
    ),
    spendControlReached: requireNullableBoolean(
      snapshot,
      "spendControlReached",
      context,
    ),
    planType: requireNullableEnum(
      snapshot,
      "planType",
      context,
      ACCOUNT_PLAN_TYPES,
    ),
    rateLimitReachedType: requireNullableEnum(
      snapshot,
      "rateLimitReachedType",
      context,
      RATE_LIMIT_REACHED_TYPES,
    ),
  };
}

function parseNullableWindow(
  value: JsonValue | undefined,
  context: string,
): RateLimitWindow | null {
  if (value === null) {
    return null;
  }
  const window = requireObject(value, context);
  return {
    usedPercent: requireInteger(window, "usedPercent", context),
    windowDurationMins: requireNullableInteger(
      window,
      "windowDurationMins",
      context,
    ),
    resetsAt: requireNullableInteger(window, "resetsAt", context),
  };
}

function parseNullableCredits(
  value: JsonValue | undefined,
  context: string,
): CreditsSnapshot | null {
  if (value === null) {
    return null;
  }
  const credits = requireObject(value, context);
  return {
    hasCredits: requireBoolean(credits, "hasCredits", context),
    unlimited: requireBoolean(credits, "unlimited", context),
    balance: requireNullableString(credits, "balance", context),
  };
}

function parseNullableIndividualLimit(
  value: JsonValue | undefined,
  context: string,
): SpendControlLimitSnapshot | null {
  if (value === null) {
    return null;
  }
  const limit = requireObject(value, context);
  return {
    limit: requireString(limit, "limit", context),
    used: requireString(limit, "used", context),
    remainingPercent: requireInteger(limit, "remainingPercent", context),
    resetsAt: requireInteger(limit, "resetsAt", context),
  };
}

function parseNullableResetCredits(
  value: JsonValue | undefined,
  context: string,
): RateLimitResetCreditsSummary | null {
  if (value === null) {
    return null;
  }
  const summary = requireObject(value, context);
  const credits = summary.credits;
  if (credits !== null && !Array.isArray(credits)) {
    throw invalidContract(`${context}.credits`);
  }
  return {
    availableCount: requireInteger(summary, "availableCount", context),
    credits:
      credits === null
        ? null
        : credits.map((credit, index) =>
            parseResetCredit(credit, `${context}.credits[${index}]`),
          ),
  };
}

function parseResetCredit(
  value: JsonValue,
  context: string,
): RateLimitResetCredit {
  const credit = requireObject(value, context);
  return {
    id: requireString(credit, "id", context),
    resetType: requireEnum(credit, "resetType", context, RESET_TYPES),
    status: requireEnum(credit, "status", context, RESET_STATUSES),
    grantedAt: requireInteger(credit, "grantedAt", context),
    expiresAt: requireNullableInteger(credit, "expiresAt", context),
    title: requireNullableString(credit, "title", context),
    description: requireNullableString(credit, "description", context),
  };
}

function requireObject(
  value: JsonValue | undefined,
  context: string,
): JsonObject {
  if (!isJsonObject(value)) {
    throw invalidContract(context);
  }
  return value;
}

function requireString(
  object: JsonObject,
  key: string,
  context: string,
): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw invalidContract(`${context}.${key}`);
  }
  return value;
}

function requireNullableString(
  object: JsonObject,
  key: string,
  context: string,
): string | null {
  const value = object[key];
  if (value !== null && typeof value !== "string") {
    throw invalidContract(`${context}.${key}`);
  }
  return value;
}

function requireBoolean(
  object: JsonObject,
  key: string,
  context: string,
): boolean {
  const value = object[key];
  if (typeof value !== "boolean") {
    throw invalidContract(`${context}.${key}`);
  }
  return value;
}

function requireNullableBoolean(
  object: JsonObject,
  key: string,
  context: string,
): boolean | null {
  const value = object[key];
  if (value !== null && typeof value !== "boolean") {
    throw invalidContract(`${context}.${key}`);
  }
  return value;
}

function requireInteger(
  object: JsonObject,
  key: string,
  context: string,
): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalidContract(`${context}.${key}`);
  }
  return value;
}

function requireNullableInteger(
  object: JsonObject,
  key: string,
  context: string,
): number | null {
  const value = object[key];
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw invalidContract(`${context}.${key}`);
  }
  return value;
}

function requireEnum<T extends string>(
  object: JsonObject,
  key: string,
  context: string,
  values: ReadonlySet<T>,
): T {
  const value = object[key];
  if (typeof value !== "string" || !values.has(value as T)) {
    throw invalidContract(`${context}.${key}`);
  }
  return value as T;
}

function requireNullableEnum<T extends string>(
  object: JsonObject,
  key: string,
  context: string,
  values: ReadonlySet<T>,
): T | null {
  const value = object[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !values.has(value as T)) {
    throw invalidContract(`${context}.${key}`);
  }
  return value as T;
}

function invalidContract(path: string): Error {
  return new Error(`Resposta incompatível do Codex em ${path}.`);
}
