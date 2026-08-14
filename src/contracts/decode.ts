import type {
  AccountPlanType,
  AccountProfileResponse,
  AccountRateLimitsResponse,
  AccountReadResponse,
  ActivityStatus,
  AppConfig,
  ApprovalPolicy,
  Attachment,
  AttachmentImageResponse,
  AuthRefreshResult,
  CancelLoginResponse,
  ChatGptAccount,
  ChatModelListResponse,
  ChatModelOption,
  CodexModel,
  CodexThread,
  CommandError,
  ConfigReadResponse,
  ConfigUpdateResponse,
  CreditsSnapshot,
  DesktopPreferences,
  EngineCapability,
  EngineNotification,
  EngineServerRequest,
  EngineStartResponse,
  EngineStorage,
  EngineTransport,
  FileChange,
  FileChangeKind,
  ImageDetail,
  LoginResponse,
  LogoutResponse,
  MessagePhase,
  ModelContextWindow,
  ModelListResponse,
  ModelServiceTier,
  ModelVerbosity,
  MotionPreference,
  OperationAck,
  PermissionProfile,
  Personality,
  PlanStepStatus,
  RateLimitReachedType,
  RateLimitSnapshot,
  RateLimitWindow,
  ReasoningEffort,
  ReasoningEffortOption,
  RuntimeDiagnostic,
  RuntimeState,
  RuntimeStatus,
  SandboxMode,
  SpendControlLimitSnapshot,
  ThreadCompactStartResponse,
  ThreadForkResponse,
  ThreadItem,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  ThreadStatus,
  ThreadSummary,
  ThreadTurn,
  ThreadUnarchiveResponse,
  TokenUsage,
  TurnStartResponse,
  TurnStatus,
  UserContent,
  WebSearchMode,
} from "./types";

type UnknownRecord = Record<string, unknown>;

const MAX_STRING_BYTES = 4 * 1_048_576;
const MAX_TOOL_OUTPUT_BYTES = 1_048_576;
const MAX_COLLECTION_LENGTH = 10_000;

const RUNTIME_STATES = ["failed", "ready", "starting", "stopped"] as const;
const CONVERSATION_MODES = ["chat", "work", "codex"] as const;
const ENGINE_TRANSPORTS = ["httpsSse"] as const;
const ENGINE_STORAGES = ["sqlite"] as const;
const ENGINE_CAPABILITIES = [
  "chatGptOauth",
  "explicitApprovals",
  "localThreads",
  "modelStreaming",
  "nativeTools",
] as const;
const SANDBOX_MODES = ["danger-full-access", "read-only", "workspace-write"] as const;
const APPROVAL_POLICIES = ["never", "on-request", "untrusted"] as const;
const REASONING_EFFORTS = [
  "high",
  "low",
  "max",
  "medium",
  "minimal",
  "none",
  "ultra",
  "xhigh",
] as const;
const CHAT_THINKING_EFFORTS = [
  "extended",
  "max",
  "min",
  "standard",
  "ultra",
  "xhigh",
  "zero",
] as const;
const CHAT_MODEL_LANES = ["auto", "instant", "pro", "thinking", "thinking_mini"] as const;
const TURN_STATUSES = ["completed", "failed", "inProgress", "interrupted"] as const;
const TERMINAL_TURN_STATUSES = ["completed", "failed", "interrupted"] as const;
const ACTIVITY_STATUSES = ["completed", "declined", "failed", "inProgress"] as const;
const PLAN_STEP_STATUSES = ["completed", "inProgress", "pending"] as const;
const MESSAGE_PHASES = ["commentary", "finalAnswer"] as const;
const IMAGE_DETAILS = ["auto", "high", "low"] as const;
const WEB_SEARCH_MODES = ["disabled", "live"] as const;
const MODEL_VERBOSITIES = ["high", "low", "medium"] as const;
const PERSONALITIES = ["friendly", "none", "pragmatic"] as const;
const MOTION_PREFERENCES = ["full", "reduced"] as const;
const DIFF_DISPLAYS = ["split", "unified"] as const;
const PLAN_TYPES = [
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
const RATE_LIMIT_REACHED_TYPES = [
  "rate_limit_reached",
  "workspace_member_credits_depleted",
  "workspace_member_usage_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_owner_usage_limit_reached",
] as const;
const MODEL_REROUTE_REASONS = ["highRiskCyberActivity"] as const;
const MODEL_VERIFICATIONS = ["trustedAccessForCyber"] as const;

export class ContractError extends Error {
  public readonly path: string;

  public constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ContractError";
    this.path = path;
  }
}

export function decodeEngineStartResponse(value: unknown): EngineStartResponse {
  const object = exactRecord(value, "$", [
    "engine",
    "permissionProfile",
    "permissionProfiles",
    "schemaVersion",
  ]);
  const engine = exactRecord(object.engine, "$.engine", [
    "auth",
    "capabilities",
    "id",
    "name",
    "provider",
    "storage",
    "transport",
  ]);
  const schemaVersion = literal(object.schemaVersion, "$.schemaVersion", [5] as const);
  return {
    engine: {
      id: text(engine.id, "$.engine.id"),
      name: text(engine.name, "$.engine.name"),
      provider: text(engine.provider, "$.engine.provider"),
      auth: text(engine.auth, "$.engine.auth"),
      transport: literal(engine.transport, "$.engine.transport", ENGINE_TRANSPORTS),
      storage: literal(engine.storage, "$.engine.storage", ENGINE_STORAGES),
      capabilities: array(engine.capabilities, "$.engine.capabilities", (entry, path) =>
        literal(entry, path, ENGINE_CAPABILITIES),
      ),
    },
    schemaVersion,
    permissionProfile: decodePermissionProfile(object.permissionProfile, "$.permissionProfile"),
    permissionProfiles: array(
      object.permissionProfiles,
      "$.permissionProfiles",
      decodePermissionProfile,
    ),
  };
}

export function decodeRuntimeStatus(value: unknown): RuntimeStatus {
  const object = exactRecord(value, "$", ["message", "state"]);
  return {
    state: literal(object.state, "$.state", RUNTIME_STATES),
    message: nullableText(object.message, "$.message"),
  };
}

export function decodeRuntimeDiagnostic(value: unknown): RuntimeDiagnostic {
  const object = exactRecord(value, "$", ["message", "stream"]);
  return {
    stream: literal(object.stream, "$.stream", ["runtime"] as const),
    message: text(object.message, "$.message"),
  };
}

export function decodeAccountReadResponse(value: unknown): AccountReadResponse {
  const object = exactRecord(value, "$", ["account", "refresh", "requiresOpenaiAuth"]);
  return {
    account: object.account === null ? null : decodeAccount(object.account, "$.account"),
    requiresOpenaiAuth: literal(object.requiresOpenaiAuth, "$.requiresOpenaiAuth", [true] as const),
    refresh: decodeRefresh(object.refresh, "$.refresh"),
  };
}

export function decodeAccountProfileResponse(value: unknown): AccountProfileResponse {
  const object = exactRecord(value, "$", ["name", "picture"]);
  return {
    name: object.name === null ? null : text(object.name, "$.name", 256),
    picture: object.picture === null ? null : urlText(object.picture, "$.picture", ["https:"]),
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

export function decodeModelListResponse(value: unknown): ModelListResponse {
  const object = exactRecord(value, "$", ["data"]);
  const data = array(object.data, "$.data", decodeModel, 100);
  if (data.length === 0) {
    throw new ContractError("$.data", "model catalog cannot be empty");
  }
  const identifiers = new Set<string>();
  for (const model of data) {
    if (identifiers.has(model.id)) {
      throw new ContractError("$.data", `duplicate model id ${JSON.stringify(model.id)}`);
    }
    identifiers.add(model.id);
  }
  const defaults = data.filter((model) => model.isDefault);
  if (defaults.length !== 1 || defaults[0]?.hidden === true) {
    throw new ContractError("$.data", "model catalog must contain one visible default model");
  }
  return { data };
}

export function decodeChatModelListResponse(value: unknown): ChatModelListResponse {
  const object = exactRecord(value, "$", ["data"]);
  const data = array(object.data, "$.data", decodeChatModelOption, 100);
  if (data.length === 0) {
    throw new ContractError("$.data", "ChatGPT model catalog cannot be empty");
  }
  const identifiers = new Set<string>();
  for (const model of data) {
    if (identifiers.has(model.id)) {
      throw new ContractError(
        "$.data",
        `duplicate ChatGPT model option ${JSON.stringify(model.id)}`,
      );
    }
    identifiers.add(model.id);
  }
  if (data.filter((model) => model.isDefault).length !== 1) {
    throw new ContractError("$.data", "ChatGPT model catalog must have exactly one default option");
  }
  return { data };
}

export function decodeThreadStartResponse(value: unknown): ThreadStartResponse {
  const object = exactRecord(value, "$", ["nextCursor", "thread"]);
  return decodeThreadPage(object);
}

export function decodeThreadForkResponse(value: unknown): ThreadForkResponse {
  const object = exactRecord(value, "$", ["nextCursor", "thread"]);
  return decodeThreadPage(object);
}

export function decodeThreadUnarchiveResponse(value: unknown): ThreadUnarchiveResponse {
  const object = exactRecord(value, "$", ["nextCursor", "thread"]);
  return decodeThreadPage(object);
}

export function decodeThreadCompactStartResponse(value: unknown): ThreadCompactStartResponse {
  exactRecord(value, "$", []);
  return {};
}

export function decodeThreadListResponse(value: unknown): ThreadListResponse {
  const object = exactRecord(value, "$", ["data", "nextCursor"]);
  return {
    data: array(object.data, "$.data", decodeThreadSummary),
    nextCursor: nullableText(object.nextCursor, "$.nextCursor"),
  };
}

export function decodeThreadReadResponse(value: unknown): ThreadReadResponse {
  const object = exactRecord(value, "$", ["nextCursor", "thread"]);
  return decodeThreadPage(object);
}

export function decodeThreadResumeResponse(value: unknown): ThreadResumeResponse {
  const object = exactRecord(value, "$", ["cwd", "nextCursor", "thread"]);
  return {
    thread: decodeThread(object.thread, "$.thread"),
    cwd: text(object.cwd, "$.cwd"),
    nextCursor: nullableText(object.nextCursor, "$.nextCursor"),
  };
}

function decodeThreadPage(value: {
  readonly nextCursor: unknown;
  readonly thread: unknown;
}): ThreadReadResponse {
  return {
    thread: decodeThread(value.thread, "$.thread"),
    nextCursor: nullableText(value.nextCursor, "$.nextCursor"),
  };
}

export function decodeTurnStartResponse(value: unknown): TurnStartResponse {
  const object = exactRecord(value, "$", ["turn"]);
  return { turn: decodeTurnSummary(object.turn, "$.turn") };
}

export function decodeOperationAck(value: unknown): OperationAck {
  const object = exactRecord(value, "$", ["applied"]);
  return { applied: literal(object.applied, "$.applied", [true] as const) };
}

export function decodeConfigReadResponse(value: unknown): ConfigReadResponse {
  const object = exactRecord(value, "$", ["config", "version"]);
  return {
    config: decodeAppConfig(object.config, "$.config"),
    version: integer(object.version, "$.version", 1, Number.MAX_SAFE_INTEGER),
  };
}

export function decodeConfigUpdateResponse(value: unknown): ConfigUpdateResponse {
  return decodeConfigReadResponse(value);
}

export function decodeAccountRateLimitsResponse(value: unknown): AccountRateLimitsResponse {
  const object = exactRecord(value, "$", ["rateLimits", "rateLimitsByLimitId"]);
  const byId = record(object.rateLimitsByLimitId, "$.rateLimitsByLimitId");
  const decodedById: Record<string, RateLimitSnapshot> = {};
  for (const [key, entry] of Object.entries(byId)) {
    if (key.length === 0 || key.length > 128) {
      throw new ContractError("$.rateLimitsByLimitId", "contains an invalid bucket id");
    }
    decodedById[key] = decodeRateLimitSnapshot(entry, `$.rateLimitsByLimitId.${key}`);
  }
  return {
    rateLimits: decodeRateLimitSnapshot(object.rateLimits, "$.rateLimits"),
    rateLimitsByLimitId: decodedById,
  };
}

export function decodeAttachments(value: unknown): readonly Attachment[] {
  return array(value, "$", decodeAttachment, 12);
}

export function decodeAttachment(value: unknown): Attachment {
  return decodeAttachmentAt(value, "$");
}

export function decodeAttachmentImageResponse(value: unknown): AttachmentImageResponse {
  const object = exactRecord(value, "$", ["dataUrl"]);
  return {
    dataUrl: text(object.dataUrl, "$.dataUrl", 36 * 1_048_576),
  };
}

export function decodeEngineNotification(value: unknown): EngineNotification {
  const root = exactRecord(value, "$", ["method", "params"]);
  const method = text(root.method, "$.method", 128);
  switch (method) {
    case "auth.loginCompleted": {
      exactKeys(root, "$", ["method", "params"]);
      const params = exactRecord(root.params, "$.params", ["error", "loginId", "success"]);
      return {
        method,
        params: {
          loginId: identifier(params.loginId, "$.params.loginId"),
          success: booleanValue(params.success, "$.params.success"),
          error: nullableText(params.error, "$.params.error"),
        },
      };
    }
    case "auth.sessionChanged": {
      exactKeys(root, "$", ["method", "params"]);
      const params = exactRecord(root.params, "$.params", ["signedIn"]);
      return {
        method,
        params: { signedIn: booleanValue(params.signedIn, "$.params.signedIn") },
      };
    }
    case "thread.created":
    case "thread.updated": {
      exactKeys(root, "$", ["method", "params"]);
      const params = exactRecord(root.params, "$.params", ["thread"]);
      return {
        method,
        params: { thread: decodeThreadSummary(params.thread, "$.params.thread") },
      };
    }
    case "thread.archived":
    case "thread.deleted":
    case "thread.unarchived": {
      exactKeys(root, "$", ["method", "params"]);
      const params = exactRecord(root.params, "$.params", ["threadId"]);
      return { method, params: { threadId: identifier(params.threadId, "$.params.threadId") } };
    }
    case "turn.started": {
      exactKeys(root, "$", ["method", "params"]);
      const params = exactRecord(root.params, "$.params", ["threadId", "turn"]);
      return {
        method,
        params: {
          threadId: identifier(params.threadId, "$.params.threadId"),
          turn: decodeTurnSummary(params.turn, "$.params.turn"),
        },
      };
    }
    case "turn.completed": {
      exactKeys(root, "$", ["method", "params"]);
      const params = exactRecord(root.params, "$.params", ["error", "threadId", "turn"]);
      return {
        method,
        params: {
          threadId: identifier(params.threadId, "$.params.threadId"),
          turn: decodeCompletedTurn(params.turn, "$.params.turn"),
          error:
            params.error === null ? null : decodeOperationFailure(params.error, "$.params.error"),
        },
      };
    }
    case "model.rerouted": {
      const params = exactRecord(root.params, "$.params", [
        "fromModel",
        "reason",
        "threadId",
        "toModel",
        "turnId",
      ]);
      return {
        method,
        params: {
          threadId: identifier(params.threadId, "$.params.threadId"),
          turnId: identifier(params.turnId, "$.params.turnId"),
          fromModel: identifier(params.fromModel, "$.params.fromModel"),
          toModel: identifier(params.toModel, "$.params.toModel"),
          reason: literal(params.reason, "$.params.reason", MODEL_REROUTE_REASONS),
        },
      };
    }
    case "model.verification": {
      const params = exactRecord(root.params, "$.params", ["threadId", "turnId", "verifications"]);
      return {
        method,
        params: {
          threadId: identifier(params.threadId, "$.params.threadId"),
          turnId: identifier(params.turnId, "$.params.turnId"),
          verifications: array(
            params.verifications,
            "$.params.verifications",
            (value, path) => literal(value, path, MODEL_VERIFICATIONS),
            64,
          ),
        },
      };
    }
    case "turn.moderationMetadata": {
      const params = exactRecord(root.params, "$.params", ["metadata", "threadId", "turnId"]);
      return {
        method,
        params: {
          threadId: identifier(params.threadId, "$.params.threadId"),
          turnId: identifier(params.turnId, "$.params.turnId"),
          metadata: boundedJsonValue(params.metadata, "$.params.metadata"),
        },
      };
    }
    case "model.safetyBufferingUpdated": {
      const params = exactRecord(root.params, "$.params", [
        "fasterModel",
        "model",
        "reasons",
        "showBufferingUi",
        "threadId",
        "turnId",
        "useCases",
      ]);
      return {
        method,
        params: {
          threadId: identifier(params.threadId, "$.params.threadId"),
          turnId: identifier(params.turnId, "$.params.turnId"),
          model: identifier(params.model, "$.params.model"),
          useCases: array(
            params.useCases,
            "$.params.useCases",
            (value, path) => text(value, path, 1_024),
            64,
          ),
          reasons: array(
            params.reasons,
            "$.params.reasons",
            (value, path) => text(value, path, 1_024),
            64,
          ),
          showBufferingUi: booleanValue(params.showBufferingUi, "$.params.showBufferingUi"),
          fasterModel:
            params.fasterModel === null
              ? null
              : identifier(params.fasterModel, "$.params.fasterModel"),
        },
      };
    }
    case "item.completed":
    case "item.started": {
      exactKeys(root, "$", ["method", "params"]);
      const params = exactRecord(root.params, "$.params", ["item", "threadId", "turnId"]);
      return {
        method,
        params: {
          threadId: identifier(params.threadId, "$.params.threadId"),
          turnId: identifier(params.turnId, "$.params.turnId"),
          item: decodeThreadItem(params.item, "$.params.item"),
        },
      };
    }
    case "item.streamDeltas": {
      exactKeys(root, "$", ["method", "params"]);
      const params = exactRecord(root.params, "$.params", ["deltas", "threadId", "turnId"]);
      return {
        method,
        params: {
          threadId: identifier(params.threadId, "$.params.threadId"),
          turnId: identifier(params.turnId, "$.params.turnId"),
          deltas: array(params.deltas, "$.params.deltas", decodeStreamDeltaPayload, 128),
        },
      };
    }
    default:
      throw new ContractError("$.method", `unsupported notification ${JSON.stringify(method)}`);
  }
}

export function decodeEngineServerRequest(value: unknown): EngineServerRequest {
  const root = exactRecord(value, "$", ["id", "method", "params"]);
  const method = literal(root.method, "$.method", ["approval.command"] as const);
  const params = exactRecord(root.params, "$.params", [
    "command",
    "cwd",
    "itemId",
    "reason",
    "threadId",
    "turnId",
  ]);
  return {
    id: identifier(root.id, "$.id"),
    method,
    params: {
      threadId: identifier(params.threadId, "$.params.threadId"),
      turnId: identifier(params.turnId, "$.params.turnId"),
      itemId: identifier(params.itemId, "$.params.itemId"),
      command: text(params.command, "$.params.command", 16_384),
      cwd: text(params.cwd, "$.params.cwd", 4_096),
      reason: text(params.reason, "$.params.reason", 1_024),
    },
  };
}

export function decodeCommandError(value: unknown): CommandError | null {
  try {
    const object = exactRecord(value, "$", ["code", "message", "retryable"]);
    return {
      code: text(object.code, "$.code", 128),
      message: text(object.message, "$.message"),
      retryable: booleanValue(object.retryable, "$.retryable"),
    };
  } catch {
    return null;
  }
}

function decodePermissionProfile(value: unknown, path: string): PermissionProfile {
  const object = exactRecord(value, path, ["approvals", "sandbox"]);
  const profile = {
    sandbox: literal(object.sandbox, `${path}.sandbox`, SANDBOX_MODES),
    approvals: literal(object.approvals, `${path}.approvals`, APPROVAL_POLICIES),
  } satisfies PermissionProfile;
  const supported =
    (profile.sandbox === "read-only" && profile.approvals === "untrusted") ||
    (profile.sandbox === "workspace-write" && profile.approvals === "on-request") ||
    (profile.sandbox === "danger-full-access" && profile.approvals === "never");
  if (!supported) {
    throw new ContractError(path, "contains an unsupported permission pairing");
  }
  return profile;
}

function decodeAccount(value: unknown, path: string): ChatGptAccount {
  const object = exactRecord(value, path, ["email", "name", "picture", "planType", "type"]);
  return {
    type: literal(object.type, `${path}.type`, ["chatgpt"] as const),
    email: nullableText(object.email, `${path}.email`),
    name: object.name === null ? null : text(object.name, `${path}.name`, 256),
    picture:
      object.picture === null
        ? null
        : urlText(object.picture, `${path}.picture`, ["data:", "https:"]),
    planType: nullableText(object.planType, `${path}.planType`),
  };
}

function decodeRefresh(value: unknown, path: string): AuthRefreshResult {
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

function decodeModel(value: unknown, path: string): CodexModel {
  const object = exactRecord(value, path, [
    "defaultReasoningEffort",
    "defaultServiceTier",
    "description",
    "displayName",
    "hidden",
    "id",
    "isDefault",
    "model",
    "contextWindow",
    "serviceTiers",
    "supportedReasoningEfforts",
  ]);
  const id = identifier(object.id, `${path}.id`);
  const model = identifier(object.model, `${path}.model`);
  if (model !== id) {
    throw new ContractError(`${path}.model`, "must equal the canonical model id");
  }
  const supportedReasoningEfforts = array(
    object.supportedReasoningEfforts,
    `${path}.supportedReasoningEfforts`,
    decodeReasoningOption,
    32,
  );
  const reasoningEffortNames = new Set(
    supportedReasoningEfforts.map((option) => option.reasoningEffort),
  );
  if (
    supportedReasoningEfforts.length === 0 ||
    reasoningEffortNames.size !== supportedReasoningEfforts.length
  ) {
    throw new ContractError(
      `${path}.supportedReasoningEfforts`,
      "must contain unique reasoning efforts",
    );
  }
  const defaultReasoningEffort =
    object.defaultReasoningEffort === null
      ? null
      : literal(object.defaultReasoningEffort, `${path}.defaultReasoningEffort`, REASONING_EFFORTS);
  if (defaultReasoningEffort !== null && !reasoningEffortNames.has(defaultReasoningEffort)) {
    throw new ContractError(
      `${path}.defaultReasoningEffort`,
      "must be one of the supported reasoning efforts",
    );
  }
  const serviceTiers = array(object.serviceTiers, `${path}.serviceTiers`, decodeServiceTier, 32);
  const serviceTierIds = new Set(serviceTiers.map((tier) => tier.id));
  if (serviceTierIds.size !== serviceTiers.length) {
    throw new ContractError(`${path}.serviceTiers`, "must contain unique service tier ids");
  }
  const defaultServiceTier = nullableText(object.defaultServiceTier, `${path}.defaultServiceTier`);
  if (defaultServiceTier !== null && !serviceTierIds.has(defaultServiceTier)) {
    throw new ContractError(
      `${path}.defaultServiceTier`,
      "must be one of the advertised service tiers",
    );
  }
  return {
    id,
    model,
    displayName: text(object.displayName, `${path}.displayName`),
    description:
      object.description === null
        ? null
        : text(object.description, `${path}.description`, 16_384, true),
    hidden: booleanValue(object.hidden, `${path}.hidden`),
    supportedReasoningEfforts,
    defaultReasoningEffort,
    serviceTiers,
    defaultServiceTier,
    contextWindow:
      object.contextWindow === null
        ? null
        : decodeModelContextWindow(object.contextWindow, `${path}.contextWindow`),
    isDefault: booleanValue(object.isDefault, `${path}.isDefault`),
  };
}

function decodeChatModelOption(value: unknown, path: string): ChatModelOption {
  const object = exactRecord(value, path, [
    "description",
    "id",
    "isDefault",
    "lane",
    "model",
    "selectedLabel",
    "thinkingEffort",
    "title",
    "versionId",
  ]);
  return {
    id: identifier(object.id, `${path}.id`),
    model: identifier(object.model, `${path}.model`),
    title: text(object.title, `${path}.title`, 16_384),
    description:
      object.description === null
        ? null
        : text(object.description, `${path}.description`, 16_384, true),
    lane: object.lane === null ? null : literal(object.lane, `${path}.lane`, CHAT_MODEL_LANES),
    thinkingEffort:
      object.thinkingEffort === null
        ? null
        : literal(object.thinkingEffort, `${path}.thinkingEffort`, CHAT_THINKING_EFFORTS),
    versionId: object.versionId === null ? null : identifier(object.versionId, `${path}.versionId`),
    selectedLabel:
      object.selectedLabel === null
        ? null
        : text(object.selectedLabel, `${path}.selectedLabel`, 16_384),
    isDefault: booleanValue(object.isDefault, `${path}.isDefault`),
  };
}

function decodeModelContextWindow(value: unknown, path: string): ModelContextWindow {
  const object = exactRecord(value, path, [
    "maximumTokens",
    "tokens",
    "usablePercent",
    "usableTokens",
  ]);
  const tokens = integer(object.tokens, `${path}.tokens`, 1, 1_000_000_000);
  const usablePercent = integer(object.usablePercent, `${path}.usablePercent`, 1, 100);
  const usableTokens = integer(object.usableTokens, `${path}.usableTokens`, 1, tokens);
  const expectedUsableTokens = Math.floor((tokens * usablePercent) / 100);
  if (usableTokens !== expectedUsableTokens) {
    throw new ContractError(`${path}.usableTokens`, "does not match tokens and usablePercent");
  }
  const maximumTokens =
    object.maximumTokens === null
      ? null
      : integer(object.maximumTokens, `${path}.maximumTokens`, tokens, 1_000_000_000);
  return { tokens, usableTokens, usablePercent, maximumTokens };
}

function decodeReasoningOption(value: unknown, path: string): ReasoningEffortOption {
  const object = exactRecord(value, path, ["description", "reasoningEffort"]);
  return {
    reasoningEffort: literal(object.reasoningEffort, `${path}.reasoningEffort`, REASONING_EFFORTS),
    description: text(object.description, `${path}.description`, 16_384, true),
  };
}

function decodeServiceTier(value: unknown, path: string): ModelServiceTier {
  const object = exactRecord(value, path, ["description", "id", "name"]);
  return {
    id: identifier(object.id, `${path}.id`),
    name: text(object.name, `${path}.name`),
    description: text(object.description, `${path}.description`, 16_384, true),
  };
}

const THREAD_SUMMARY_KEYS = [
  "createdAt",
  "cwd",
  "id",
  "mode",
  "name",
  "preview",
  "projectPath",
  "recencyAt",
  "status",
  "updatedAt",
] as const;

function decodeThreadSummary(value: unknown, path: string): ThreadSummary {
  return decodeThreadSummaryRecord(exactRecord(value, path, THREAD_SUMMARY_KEYS), path);
}

function decodeThread(value: unknown, path: string): CodexThread {
  const object = exactRecord(value, path, [...THREAD_SUMMARY_KEYS, "turns"]);
  return {
    ...decodeThreadSummaryRecord(object, path),
    turns: array(object.turns, `${path}.turns`, decodeThreadTurn),
  };
}

function decodeThreadSummaryRecord(
  object: Record<(typeof THREAD_SUMMARY_KEYS)[number], unknown>,
  path: string,
): ThreadSummary {
  const createdAt = integer(object.createdAt, `${path}.createdAt`, 0, Number.MAX_SAFE_INTEGER);
  const updatedAt = integer(object.updatedAt, `${path}.updatedAt`, 0, Number.MAX_SAFE_INTEGER);
  if (updatedAt < createdAt) {
    throw new ContractError(path, "thread updatedAt must not precede createdAt");
  }
  const recencyAt =
    object.recencyAt === null
      ? null
      : integer(object.recencyAt, `${path}.recencyAt`, 0, Number.MAX_SAFE_INTEGER);
  if (recencyAt !== null && recencyAt < createdAt) {
    throw new ContractError(path, "thread recencyAt must not precede createdAt");
  }
  return {
    id: identifier(object.id, `${path}.id`),
    mode: literal(object.mode, `${path}.mode`, CONVERSATION_MODES),
    preview: text(object.preview, `${path}.preview`, 512, true),
    name: nullableText(object.name, `${path}.name`),
    cwd: text(object.cwd, `${path}.cwd`, 4_096),
    projectPath: nullableText(object.projectPath, `${path}.projectPath`),
    createdAt,
    updatedAt,
    recencyAt,
    status: decodeThreadStatus(object.status, `${path}.status`),
  };
}

function decodeThreadStatus(value: unknown, path: string): ThreadStatus {
  const object = record(value, path);
  const type = text(field(object, "type"), `${path}.type`, 32);
  switch (type) {
    case "active": {
      const active = exactRecord(object, path, ["activeFlags", "type"]);
      return {
        type,
        activeFlags: array(active.activeFlags, `${path}.activeFlags`, (entry, entryPath) =>
          literal(entry, entryPath, ["waitingOnApproval"] as const),
        ),
      };
    }
    case "idle":
    case "systemError": {
      exactRecord(object, path, ["type"]);
      return { type };
    }
    default:
      throw new ContractError(`${path}.type`, `unsupported thread status ${JSON.stringify(type)}`);
  }
}

function decodeThreadTurn(value: unknown, path: string): ThreadTurn {
  const object = exactRecord(value, path, [
    "createdAt",
    "error",
    "id",
    "items",
    "status",
    "updatedAt",
  ]);
  const status = literal(object.status, `${path}.status`, TURN_STATUSES);
  const error = nullableText(object.error, `${path}.error`);
  if ((status === "failed") !== (error !== null)) {
    throw new ContractError(
      path,
      "failed turns require an error and all other turn states must not contain one",
    );
  }
  const createdAt = integer(object.createdAt, `${path}.createdAt`, 0, Number.MAX_SAFE_INTEGER);
  const updatedAt = integer(object.updatedAt, `${path}.updatedAt`, 0, Number.MAX_SAFE_INTEGER);
  if (updatedAt < createdAt) {
    throw new ContractError(path, "turn updatedAt must not precede createdAt");
  }
  return {
    id: identifier(object.id, `${path}.id`),
    items: array(object.items, `${path}.items`, decodeThreadItem),
    status,
    error,
    createdAt,
    updatedAt,
  };
}

function decodeThreadItem(value: unknown, path: string): ThreadItem {
  const object = record(value, path);
  const type = text(field(object, "type"), `${path}.type`, 64);
  switch (type) {
    case "contextUsage": {
      const item = exactRecord(object, path, ["contextWindow", "id", "model", "type", "usage"]);
      return {
        type,
        id: identifier(item.id, `${path}.id`),
        model: identifier(item.model, `${path}.model`),
        usage: decodeTokenUsage(item.usage, `${path}.usage`),
        contextWindow:
          item.contextWindow === null
            ? null
            : decodeModelContextWindow(item.contextWindow, `${path}.contextWindow`),
      };
    }
    case "contextCompaction": {
      const item = exactRecord(object, path, ["id", "type"]);
      return {
        type,
        id: identifier(item.id, `${path}.id`),
      };
    }
    case "userMessage": {
      const item = exactRecord(object, path, ["content", "id", "type"]);
      return {
        type,
        id: identifier(item.id, `${path}.id`),
        content: array(item.content, `${path}.content`, decodeUserContent, 12),
      };
    }
    case "agentMessage": {
      const item = exactRecord(object, path, ["id", "phase", "text", "type"]);
      return {
        type,
        id: identifier(item.id, `${path}.id`),
        text: text(item.text, `${path}.text`, MAX_STRING_BYTES, true),
        phase: item.phase === null ? null : literal(item.phase, `${path}.phase`, MESSAGE_PHASES),
      };
    }
    case "reasoning": {
      const item = exactRecord(object, path, ["content", "id", "summary", "type"]);
      return {
        type,
        id: identifier(item.id, `${path}.id`),
        summary: array(item.summary, `${path}.summary`, (entry, entryPath) =>
          text(entry, entryPath, MAX_STRING_BYTES, true),
        ),
        content: array(item.content, `${path}.content`, (entry, entryPath) =>
          text(entry, entryPath, MAX_STRING_BYTES, true),
        ),
      };
    }
    case "plan": {
      const item = exactRecord(object, path, ["explanation", "id", "steps", "type"]);
      const steps = array(
        item.steps,
        `${path}.steps`,
        (value, stepPath) => {
          const step = exactRecord(value, stepPath, ["status", "step"]);
          return {
            step: text(step.step, `${stepPath}.step`, 1_024),
            status: literal(
              step.status,
              `${stepPath}.status`,
              PLAN_STEP_STATUSES,
            ) satisfies PlanStepStatus,
          };
        },
        20,
      );
      if (steps.length === 0) {
        throw new ContractError(`${path}.steps`, "plan must contain at least one step");
      }
      if (steps.filter((step) => step.status === "inProgress").length > 1) {
        throw new ContractError(
          `${path}.steps`,
          "plan must not contain more than one in-progress step",
        );
      }
      const uniqueSteps = new Set(steps.map((step) => step.step.toLowerCase()));
      if (uniqueSteps.size !== steps.length) {
        throw new ContractError(`${path}.steps`, "plan steps must be unique");
      }
      return {
        type,
        id: identifier(item.id, `${path}.id`),
        explanation:
          item.explanation === null ? null : text(item.explanation, `${path}.explanation`, 4_096),
        steps,
      };
    }
    case "commandExecution": {
      const item = exactRecord(object, path, [
        "aggregatedOutput",
        "command",
        "cwd",
        "durationMs",
        "exitCode",
        "id",
        "processId",
        "source",
        "status",
        "type",
      ]);
      return {
        type,
        id: identifier(item.id, `${path}.id`),
        command: text(item.command, `${path}.command`, 16_384),
        cwd: text(item.cwd, `${path}.cwd`, 4_096),
        processId: nullableText(item.processId, `${path}.processId`),
        source: literal(item.source, `${path}.source`, ["agent"] as const),
        status: literal(item.status, `${path}.status`, ACTIVITY_STATUSES),
        aggregatedOutput: nullableText(
          item.aggregatedOutput,
          `${path}.aggregatedOutput`,
          MAX_TOOL_OUTPUT_BYTES,
        ),
        exitCode:
          item.exitCode === null
            ? null
            : integer(item.exitCode, `${path}.exitCode`, -2_147_483_648, 2_147_483_647),
        durationMs:
          item.durationMs === null
            ? null
            : integer(item.durationMs, `${path}.durationMs`, 0, Number.MAX_SAFE_INTEGER),
      };
    }
    case "fileChange": {
      const item = exactRecord(object, path, ["changes", "id", "status", "type"]);
      return {
        type,
        id: identifier(item.id, `${path}.id`),
        changes: array(item.changes, `${path}.changes`, decodeFileChange, 1_000),
        status: literal(item.status, `${path}.status`, ACTIVITY_STATUSES),
      };
    }
    case "toolExecution": {
      const item = exactRecord(object, path, [
        "description",
        "id",
        "name",
        "output",
        "status",
        "type",
      ]);
      return {
        type,
        id: identifier(item.id, `${path}.id`),
        name: identifier(item.name, `${path}.name`),
        description: text(item.description, `${path}.description`, 4_096),
        status: literal(item.status, `${path}.status`, ACTIVITY_STATUSES),
        output: nullableText(item.output, `${path}.output`, MAX_TOOL_OUTPUT_BYTES),
      };
    }
    default:
      throw new ContractError(`${path}.type`, `unsupported item ${JSON.stringify(type)}`);
  }
}

function decodeTokenUsage(value: unknown, path: string): TokenUsage {
  const object = exactRecord(value, path, [
    "cachedInputTokens",
    "inputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ]);
  const inputTokens = integer(object.inputTokens, `${path}.inputTokens`, 0, 1_000_000_000);
  const cachedInputTokens = integer(
    object.cachedInputTokens,
    `${path}.cachedInputTokens`,
    0,
    inputTokens,
  );
  const outputTokens = integer(object.outputTokens, `${path}.outputTokens`, 0, 1_000_000_000);
  const reasoningOutputTokens = integer(
    object.reasoningOutputTokens,
    `${path}.reasoningOutputTokens`,
    0,
    outputTokens,
  );
  const totalTokens = integer(object.totalTokens, `${path}.totalTokens`, 0, 1_000_000_000);
  if (totalTokens !== inputTokens + outputTokens) {
    throw new ContractError(`${path}.totalTokens`, "must equal inputTokens plus outputTokens");
  }
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function decodeUserContent(value: unknown, path: string): UserContent {
  const object = record(value, path);
  const type = text(field(object, "type"), `${path}.type`, 32);
  switch (type) {
    case "text": {
      const content = exactRecord(object, path, ["text", "type"]);
      return { type, text: text(content.text, `${path}.text`, MAX_STRING_BYTES) };
    }
    case "localImage": {
      const content = exactRecord(object, path, ["detail", "path", "type"]);
      return {
        type,
        path: text(content.path, `${path}.path`, 4_096),
        detail:
          content.detail === null ? null : literal(content.detail, `${path}.detail`, IMAGE_DETAILS),
      };
    }
    case "mention": {
      const content = exactRecord(object, path, ["name", "path", "type"]);
      return {
        type,
        name: text(content.name, `${path}.name`, 1_024),
        path: text(content.path, `${path}.path`, 4_096),
      };
    }
    default:
      throw new ContractError(`${path}.type`, `unsupported user content ${JSON.stringify(type)}`);
  }
}

function decodeFileChange(value: unknown, path: string): FileChange {
  const object = exactRecord(value, path, ["diff", "kind", "path"]);
  return {
    path: text(object.path, `${path}.path`, 4_096),
    kind: decodeFileChangeKind(object.kind, `${path}.kind`),
    diff: text(object.diff, `${path}.diff`, MAX_STRING_BYTES, true),
  };
}

function decodeFileChangeKind(value: unknown, path: string): FileChangeKind {
  const object = record(value, path);
  const type = text(field(object, "type"), `${path}.type`, 16);
  switch (type) {
    case "add":
    case "delete": {
      exactRecord(object, path, ["type"]);
      return { type };
    }
    case "update": {
      const change = exactRecord(object, path, ["movePath", "type"]);
      return { type, movePath: nullableText(change.movePath, `${path}.movePath`) };
    }
    default:
      throw new ContractError(`${path}.type`, `unsupported file change ${JSON.stringify(type)}`);
  }
}

function decodeTurnSummary(value: unknown, path: string) {
  const object = exactRecord(value, path, ["createdAt", "id", "status", "updatedAt"]);
  const createdAt = integer(object.createdAt, `${path}.createdAt`, 0, Number.MAX_SAFE_INTEGER);
  const updatedAt = integer(object.updatedAt, `${path}.updatedAt`, 0, Number.MAX_SAFE_INTEGER);
  if (updatedAt < createdAt) {
    throw new ContractError(path, "turn updatedAt must not precede createdAt");
  }
  return {
    id: identifier(object.id, `${path}.id`),
    status: literal(object.status, `${path}.status`, TURN_STATUSES),
    createdAt,
    updatedAt,
  };
}

function decodeCompletedTurn(value: unknown, path: string) {
  const object = exactRecord(value, path, ["error", "id", "status", "updatedAt"]);
  return {
    id: identifier(object.id, `${path}.id`),
    status: literal(object.status, `${path}.status`, TERMINAL_TURN_STATUSES),
    error: nullableText(object.error, `${path}.error`),
    updatedAt: integer(object.updatedAt, `${path}.updatedAt`, 0, Number.MAX_SAFE_INTEGER),
  };
}

function decodeAppConfig(value: unknown, path: string): AppConfig {
  const object = exactRecord(value, path, [
    "desktop",
    "developerInstructions",
    "model",
    "modelReasoningEffort",
    "modelVerbosity",
    "permissionProfile",
    "personality",
    "serviceTier",
    "webSearch",
  ]);
  return {
    model: nullableText(object.model, `${path}.model`),
    modelReasoningEffort:
      object.modelReasoningEffort === null
        ? null
        : literal(object.modelReasoningEffort, `${path}.modelReasoningEffort`, REASONING_EFFORTS),
    serviceTier: nullableText(object.serviceTier, `${path}.serviceTier`),
    permissionProfile: decodePermissionProfile(
      object.permissionProfile,
      `${path}.permissionProfile`,
    ),
    webSearch: literal(object.webSearch, `${path}.webSearch`, WEB_SEARCH_MODES),
    modelVerbosity:
      object.modelVerbosity === null
        ? null
        : literal(object.modelVerbosity, `${path}.modelVerbosity`, MODEL_VERBOSITIES),
    personality: literal(object.personality, `${path}.personality`, PERSONALITIES),
    developerInstructions: nullableText(
      object.developerInstructions,
      `${path}.developerInstructions`,
    ),
    desktop: decodeDesktopPreferences(object.desktop, `${path}.desktop`),
  };
}

function decodeDesktopPreferences(value: unknown, path: string): DesktopPreferences {
  const object = exactRecord(value, path, ["diffDisplay", "motion", "pointerCursor", "uiFontSize"]);
  return {
    uiFontSize: integer(object.uiFontSize, `${path}.uiFontSize`, 12, 24),
    motion: literal(object.motion, `${path}.motion`, MOTION_PREFERENCES),
    pointerCursor: booleanValue(object.pointerCursor, `${path}.pointerCursor`),
    diffDisplay: literal(object.diffDisplay, `${path}.diffDisplay`, DIFF_DISPLAYS),
  };
}

function decodeRateLimitSnapshot(value: unknown, path: string): RateLimitSnapshot {
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

function decodeRateLimitWindow(value: unknown, path: string): RateLimitWindow {
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

function decodeCredits(value: unknown, path: string): CreditsSnapshot {
  const object = exactRecord(value, path, ["balance", "hasCredits", "unlimited"]);
  return {
    hasCredits: booleanValue(object.hasCredits, `${path}.hasCredits`),
    unlimited: booleanValue(object.unlimited, `${path}.unlimited`),
    balance: nullableText(object.balance, `${path}.balance`),
  };
}

function decodeSpendControl(value: unknown, path: string): SpendControlLimitSnapshot {
  const object = exactRecord(value, path, ["limit", "remainingPercent", "resetsAt", "used"]);
  return {
    limit: text(object.limit, `${path}.limit`),
    used: text(object.used, `${path}.used`),
    remainingPercent: integer(object.remainingPercent, `${path}.remainingPercent`, 0, 100),
    resetsAt: integer(object.resetsAt, `${path}.resetsAt`, 0, Number.MAX_SAFE_INTEGER),
  };
}

function decodeAttachmentAt(value: unknown, path: string): Attachment {
  const object = exactRecord(value, path, ["id", "kind", "mediaType", "name", "path", "size"]);
  return {
    id: identifier(object.id, `${path}.id`),
    name: text(object.name, `${path}.name`, 1_024),
    path: text(object.path, `${path}.path`, 4_096),
    kind: literal(object.kind, `${path}.kind`, ["file", "image"] as const),
    size: integer(object.size, `${path}.size`, 0, 25 * 1_048_576),
    mediaType: nullableText(object.mediaType, `${path}.mediaType`),
  };
}

function decodeOperationFailure(value: unknown, path: string) {
  const object = exactRecord(value, path, ["code", "message"]);
  return {
    code: text(object.code, `${path}.code`, 128),
    message: text(object.message, `${path}.message`),
  };
}

function decodeStreamDeltaPayload(value: unknown, path: string) {
  const object = record(value, path);
  const kind = text(field(object, "kind"), `${path}.kind`, 32);
  switch (kind) {
    case "agentText": {
      const delta = exactRecord(object, path, ["delta", "itemId", "kind"]);
      return {
        kind,
        itemId: identifier(delta.itemId, `${path}.itemId`),
        delta: text(delta.delta, `${path}.delta`, 262_144, true),
      };
    }
    case "reasoningSummary":
    case "reasoningText": {
      const delta = exactRecord(object, path, ["delta", "index", "itemId", "kind"]);
      return {
        kind,
        itemId: identifier(delta.itemId, `${path}.itemId`),
        index: integer(delta.index, `${path}.index`, 0, 1_024),
        delta: text(delta.delta, `${path}.delta`, 262_144, true),
      };
    }
    default:
      throw new ContractError(`${path}.kind`, `unsupported stream delta ${JSON.stringify(kind)}`);
  }
}

function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  path: string,
  keys: Keys,
): Record<Keys[number], unknown> {
  const object = record(value, path);
  exactKeys(object, path, keys);
  return object as Record<Keys[number], unknown>;
}

function boundedJsonValue(value: unknown, path: string, depth = 0): unknown {
  if (depth > 32) {
    throw new ContractError(path, "JSON nesting exceeds 32 levels");
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return text(value, path, 1_048_576, true);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ContractError(path, "expected a finite JSON number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return array(
      value,
      path,
      (entry, entryPath) => boundedJsonValue(entry, entryPath, depth + 1),
      MAX_COLLECTION_LENGTH,
    );
  }
  const object = record(value, path);
  const entries = Object.entries(object);
  if (entries.length > MAX_COLLECTION_LENGTH) {
    throw new ContractError(path, `object exceeds ${MAX_COLLECTION_LENGTH} entries`);
  }
  return Object.fromEntries(
    entries.map(([key, entry]) => [
      text(key, `${path} key`, 1_024),
      boundedJsonValue(entry, `${path}.${key}`, depth + 1),
    ]),
  );
}

function field(object: UnknownRecord, key: string): unknown {
  return object[key];
}

function record(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractError(path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ContractError(path, "expected a plain object");
  }
  return value as UnknownRecord;
}

function exactKeys(object: UnknownRecord, path: string, expected: readonly string[]): void {
  const actual = Object.keys(object).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new ContractError(
      path,
      `expected keys ${sortedExpected.join(", ")}; received ${actual.join(", ")}`,
    );
  }
}

function array<T>(
  value: unknown,
  path: string,
  decode: (entry: unknown, path: string) => T,
  maximumLength = MAX_COLLECTION_LENGTH,
): readonly T[] {
  if (!Array.isArray(value)) {
    throw new ContractError(path, "expected an array");
  }
  if (value.length > maximumLength) {
    throw new ContractError(path, `array exceeds ${maximumLength} entries`);
  }
  return value.map((entry, index) => decode(entry, `${path}[${index}]`));
}

function text(
  value: unknown,
  path: string,
  maximumBytes = MAX_STRING_BYTES,
  allowEmpty = false,
): string {
  if (typeof value !== "string") {
    throw new ContractError(path, "expected a string");
  }
  if (
    (!allowEmpty && value.length === 0) ||
    new TextEncoder().encode(value).length > maximumBytes
  ) {
    throw new ContractError(path, `string must contain at most ${maximumBytes} UTF-8 bytes`);
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  const decoded = text(value, path, 256);
  if (/\p{Cc}/u.test(decoded)) {
    throw new ContractError(path, "identifier contains control characters");
  }
  return decoded;
}

function nullableText(
  value: unknown,
  path: string,
  maximumBytes = MAX_STRING_BYTES,
): string | null {
  return value === null ? null : text(value, path, maximumBytes);
}

function urlText(value: unknown, path: string, protocols: readonly string[]): string {
  const decoded = text(value, path, 8_192);
  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    throw new ContractError(path, "expected an absolute URL");
  }
  if (!protocols.includes(url.protocol)) {
    throw new ContractError(path, `URL protocol ${url.protocol} is not allowed`);
  }
  return decoded;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ContractError(path, "expected a boolean");
  }
  return value;
}

function finiteNumber(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ContractError(path, `expected a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  const decoded = finiteNumber(value, path, minimum, maximum);
  if (!Number.isSafeInteger(decoded)) {
    throw new ContractError(path, "expected a safe integer");
  }
  return decoded;
}

function literal<const T>(value: unknown, path: string, values: readonly T[]): T {
  for (const candidate of values) {
    if (value === candidate) {
      return candidate;
    }
  }
  throw new ContractError(path, `expected one of ${values.map(String).join(", ")}`);
}

export type {
  AccountPlanType,
  ActivityStatus,
  ApprovalPolicy,
  EngineCapability,
  EngineStorage,
  EngineTransport,
  ImageDetail,
  MessagePhase,
  ModelVerbosity,
  MotionPreference,
  Personality,
  RateLimitReachedType,
  ReasoningEffort,
  RuntimeState,
  SandboxMode,
  TurnStatus,
  WebSearchMode,
};
