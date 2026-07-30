export type AccountPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "self_serve_business_prolite"
  | "self_serve_business_usage_based"
  | "business"
  | "ent26"
  | "enterprise_cbp_usage_based"
  | "enterprise"
  | "edu"
  | "unknown";

export type RateLimitReachedType =
  | "rate_limit_reached"
  | "workspace_owner_credits_depleted"
  | "workspace_member_credits_depleted"
  | "workspace_owner_usage_limit_reached"
  | "workspace_member_usage_limit_reached";

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface SpendControlLimitSnapshot {
  limit: string;
  used: string;
  remainingPercent: number;
  resetsAt: number;
}

export interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: CreditsSnapshot | null;
  individualLimit: SpendControlLimitSnapshot | null;
  spendControlReached: boolean | null;
  planType: AccountPlanType | null;
  rateLimitReachedType: RateLimitReachedType | null;
}

export type RateLimitResetType = "codexRateLimits" | "unknown";
export type RateLimitResetCreditStatus =
  | "available"
  | "redeeming"
  | "redeemed"
  | "unknown";

export interface RateLimitResetCredit {
  id: string;
  resetType: RateLimitResetType;
  status: RateLimitResetCreditStatus;
  grantedAt: number;
  expiresAt: number | null;
  title: string | null;
  description: string | null;
}

export interface RateLimitResetCreditsSummary {
  availableCount: number;
  credits: RateLimitResetCredit[] | null;
}

export interface AccountRateLimitsResponse {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null;
  rateLimitResetCredits: RateLimitResetCreditsSummary | null;
}

export interface AccountRateLimitsUpdatedNotification {
  rateLimits: RateLimitSnapshot;
}
