export const RUNTIME_STATES = ["failed", "ready", "starting", "stopped"] as const;
export const CONVERSATION_MODES = ["chat", "work", "codex"] as const;
export const ENGINE_TRANSPORTS = ["httpsSse"] as const;
export const ENGINE_STORAGES = ["sqlite"] as const;
export const ENGINE_CAPABILITIES = [
  "browserUse",
  "chatGptOauth",
  "explicitApprovals",
  "localThreads",
  "modelStreaming",
  "nativeTools",
  "scheduledAutomations",
] as const;
export const SANDBOX_MODES = ["danger-full-access", "read-only", "workspace-write"] as const;
export const APPROVAL_POLICIES = ["never", "on-request", "untrusted"] as const;
export const REASONING_EFFORTS = [
  "high",
  "low",
  "max",
  "medium",
  "minimal",
  "none",
  "ultra",
  "xhigh",
] as const;
export const MODEL_RUNTIME_CAPABILITIES = ["multiAgent"] as const;
export const CHAT_THINKING_EFFORTS = [
  "extended",
  "max",
  "min",
  "standard",
  "ultra",
  "xhigh",
  "zero",
] as const;
export const CHAT_MODEL_LANES = ["auto", "instant", "pro", "thinking", "thinking_mini"] as const;
export const TURN_STATUSES = ["completed", "failed", "inProgress", "interrupted"] as const;
export const TERMINAL_TURN_STATUSES = ["completed", "failed", "interrupted"] as const;
export const ACTIVITY_STATUSES = ["completed", "declined", "failed", "inProgress"] as const;
export const PLAN_STEP_STATUSES = ["completed", "inProgress", "pending"] as const;
export const MESSAGE_PHASES = ["commentary", "finalAnswer"] as const;
export const IMAGE_DETAILS = ["auto", "high", "low", "original"] as const;
export const WEB_SEARCH_MODES = ["disabled", "live"] as const;
export const MODEL_VERBOSITIES = ["high", "low", "medium"] as const;
export const STORED_MODEL_CONTEXT_WINDOW_PREFERENCES = ["maximum"] as const;
export const PERSONALITIES = ["friendly", "none", "pragmatic"] as const;
export const MOTION_PREFERENCES = ["full", "reduced"] as const;
export const DIFF_DISPLAYS = ["split", "unified"] as const;
export const PLAN_TYPES = [
  "business",
  "edu",
  "ent26",
  "enterprise",
  "enterprise_cbp_usage_based",
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "self_serve_business_prolite",
  "self_serve_business_usage_based",
  "team",
] as const;
export const RATE_LIMIT_REACHED_TYPES = [
  "rate_limit_reached",
  "workspace_member_credits_depleted",
  "workspace_member_usage_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_owner_usage_limit_reached",
] as const;
export const MODEL_REROUTE_REASONS = ["highRiskCyberActivity"] as const;
export const MODEL_VERIFICATIONS = ["trustedAccessForCyber"] as const;
export const MODEL_CONTEXT_WINDOW_PREFERENCES = ["default", "maximum"] as const;
