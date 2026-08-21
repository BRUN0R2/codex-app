export type RuntimeState = "failed" | "ready" | "starting" | "stopped";
export type AppProduct = "chatgpt" | "codex";
export type ChatGptMode = "chat" | "work";
export type ConversationMode = ChatGptMode | "codex";
export type DiagnosticStream = "runtime";
export type EngineTransport = "httpsSse";
export type EngineStorage = "sqlite";
export type EngineCapability =
  | "chatGptOauth"
  | "explicitApprovals"
  | "localThreads"
  | "modelStreaming"
  | "nativeTools"
  | "scheduledAutomations";

export interface RuntimeStatus {
  readonly state: RuntimeState;
  readonly message: string | null;
}

export interface RuntimeDiagnostic {
  readonly stream: DiagnosticStream;
  readonly message: string;
}

export interface EngineDescriptor {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly auth: string;
  readonly transport: EngineTransport;
  readonly storage: EngineStorage;
  readonly capabilities: readonly EngineCapability[];
}

export type SandboxMode = "danger-full-access" | "read-only" | "workspace-write";
export type ApprovalPolicy = "never" | "on-request" | "untrusted";

export interface PermissionProfile {
  readonly sandbox: SandboxMode;
  readonly approvals: ApprovalPolicy;
}

export interface EngineStartResponse {
  readonly engine: EngineDescriptor;
  readonly schemaVersion: 13;
  readonly diagnosticLogPath: string;
  readonly config: ConfigReadResponse;
  readonly permissionProfiles: readonly PermissionProfile[];
}

export type AuthRefreshStatus = "failed" | "notRequired" | "succeeded" | "superseded";

export interface AuthRefreshResult {
  readonly status: AuthRefreshStatus;
  readonly error: string | null;
}

export interface ChatGptAccount {
  readonly type: "chatgpt";
  readonly email: string | null;
  readonly name: string | null;
  readonly picture: string | null;
  readonly planType: string | null;
}

export interface AccountReadResponse {
  readonly account: ChatGptAccount | null;
  readonly requiresOpenaiAuth: true;
  readonly refresh: AuthRefreshResult;
}

export interface AccountProfileResponse {
  readonly name: string | null;
  readonly picture: string | null;
}

export interface LoginResponse {
  readonly type: "chatgpt";
  readonly loginId: string;
  readonly authUrl: string;
}

export interface CancelLoginResponse {
  readonly status: "canceled" | "notFound";
}

export interface LogoutResponse {
  readonly localCredentialsRemoved: boolean;
  readonly remoteRevocation: "failed" | "notApplicable" | "succeeded";
  readonly remoteRevocationError: string | null;
}

export type ReasoningEffort =
  | "high"
  | "low"
  | "max"
  | "medium"
  | "minimal"
  | "none"
  | "ultra"
  | "xhigh";

export interface ReasoningEffortOption {
  readonly reasoningEffort: ReasoningEffort;
  readonly description: string;
}

export interface ModelServiceTier {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface ModelContextWindow {
  readonly tokens: number;
  readonly usableTokens: number;
  readonly usablePercent: number;
  readonly maximumTokens: number | null;
}

export type ModelContextWindowPreference = "default" | "maximum";

export interface CodexModel {
  readonly id: string;
  readonly model: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly hidden: boolean;
  readonly supportedReasoningEfforts: readonly ReasoningEffortOption[];
  readonly defaultReasoningEffort: ReasoningEffort | null;
  readonly serviceTiers: readonly ModelServiceTier[];
  readonly defaultServiceTier: string | null;
  readonly contextWindow: ModelContextWindow | null;
  readonly isDefault: boolean;
}

export interface ModelListResponse {
  readonly data: readonly CodexModel[];
}

export type ChatThinkingEffort =
  | "extended"
  | "max"
  | "min"
  | "standard"
  | "ultra"
  | "xhigh"
  | "zero";

export type ChatModelLane = "auto" | "instant" | "pro" | "thinking" | "thinking_mini";

export interface ChatModelOption {
  readonly id: string;
  readonly model: string;
  readonly title: string;
  readonly description: string | null;
  readonly lane: ChatModelLane | null;
  readonly thinkingEffort: ChatThinkingEffort | null;
  readonly versionId: string | null;
  readonly selectedLabel: string | null;
  readonly isDefault: boolean;
}

export interface ChatModelListResponse {
  readonly data: readonly ChatModelOption[];
}

export type TurnStatus = "completed" | "failed" | "inProgress" | "interrupted";
export type ActivityStatus = "completed" | "declined" | "failed" | "inProgress";
export type MessagePhase = "commentary" | "finalAnswer";
export type ImageDetail = "auto" | "high" | "low";

export type UserContent =
  | { readonly type: "localImage"; readonly path: string; readonly detail: ImageDetail | null }
  | { readonly type: "mention"; readonly name: string; readonly path: string }
  | { readonly type: "text"; readonly text: string };

export type FileChangeKind =
  | { readonly type: "add" }
  | { readonly type: "delete" }
  | { readonly type: "update"; readonly movePath: string | null };

export interface FileChange {
  readonly path: string;
  readonly kind: FileChangeKind;
  readonly diff: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

export interface ContextUsageItem {
  readonly type: "contextUsage";
  readonly id: string;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly contextWindow: ModelContextWindow | null;
}

export type PlanStepStatus = "completed" | "inProgress" | "pending";

export interface PlanStep {
  readonly step: string;
  readonly status: PlanStepStatus;
}

export interface PlanItem {
  readonly type: "plan";
  readonly id: string;
  readonly explanation: string | null;
  readonly steps: readonly PlanStep[];
}

export interface ThreadOutput {
  readonly id: string;
  readonly preview: string;
  readonly byteLength: number;
  readonly nextCursor: string | null;
}

export interface OutputReadResponse {
  readonly outputId: string;
  readonly chunk: string;
  readonly byteLength: number;
  readonly nextCursor: string | null;
}

export type ThreadItem =
  | ContextUsageItem
  | PlanItem
  | {
      readonly type: "contextCompaction";
      readonly id: string;
    }
  | {
      readonly type: "agentMessage";
      readonly id: string;
      readonly text: string;
      readonly phase: MessagePhase | null;
    }
  | {
      readonly type: "commandExecution";
      readonly id: string;
      readonly command: string;
      readonly cwd: string;
      readonly processId: string | null;
      readonly startedAt: number | null;
      readonly source: "agent";
      readonly status: ActivityStatus;
      readonly aggregatedOutput: ThreadOutput | null;
      readonly exitCode: number | null;
      readonly durationMs: number | null;
    }
  | {
      readonly type: "fileChange";
      readonly id: string;
      readonly changes: readonly FileChange[];
      readonly status: ActivityStatus;
    }
  | {
      readonly type: "reasoning";
      readonly id: string;
      readonly summary: readonly string[];
      readonly content: readonly string[];
    }
  | {
      readonly type: "toolExecution";
      readonly id: string;
      readonly name: string;
      readonly description: string;
      readonly status: ActivityStatus;
      readonly output: ThreadOutput | null;
    }
  | {
      readonly type: "userMessage";
      readonly id: string;
      readonly content: readonly UserContent[];
    };

export type VisibleThreadItem = Exclude<ThreadItem, ContextUsageItem>;

export interface ThreadTurn {
  readonly id: string;
  readonly items: readonly ThreadItem[];
  readonly status: TurnStatus;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type ThreadStatus =
  | { readonly type: "active"; readonly activeFlags: readonly "waitingOnApproval"[] }
  | { readonly type: "idle" | "systemError" };

export interface ThreadSummary {
  readonly id: string;
  readonly mode: ConversationMode;
  readonly preview: string;
  readonly name: string | null;
  readonly cwd: string;
  readonly projectPath: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly recencyAt: number | null;
  readonly status: ThreadStatus;
}

export interface CodexThread extends ThreadSummary {
  readonly turns: readonly ThreadTurn[];
}

export interface ThreadStartResponse {
  readonly thread: CodexThread;
  readonly nextCursor: string | null;
}

export interface ThreadForkResponse {
  readonly thread: CodexThread;
  readonly nextCursor: string | null;
}

export interface ThreadUnarchiveResponse {
  readonly thread: CodexThread;
  readonly nextCursor: string | null;
}

export interface ThreadListResponse {
  readonly data: readonly ThreadSummary[];
  readonly nextCursor: string | null;
}

export interface ThreadReadResponse {
  readonly thread: CodexThread;
  readonly nextCursor: string | null;
}

export interface ThreadResumeResponse {
  readonly thread: CodexThread;
  readonly cwd: string;
  readonly nextCursor: string | null;
}

export interface TurnSummary {
  readonly id: string;
  readonly status: TurnStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CompletedTurn {
  readonly id: string;
  readonly status: Exclude<TurnStatus, "inProgress">;
  readonly error: string | null;
  readonly updatedAt: number;
}

export interface TurnStartResponse {
  readonly turn: TurnSummary;
}

export interface OperationAck {
  readonly applied: true;
}

export interface AutomationInput {
  readonly name: string;
  readonly prompt: string;
  readonly projectPath: string | null;
  readonly enabled: boolean;
  readonly intervalMinutes: number;
}

export interface Automation {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly projectPath: string | null;
  readonly enabled: boolean;
  readonly intervalMinutes: number;
  readonly timezone: string;
  readonly timezoneOffsetMin: number;
  readonly nextRunAt: number | null;
  readonly lastRunAt: number | null;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type AutomationRunTrigger = "manual" | "scheduled";
export type AutomationRunStatus = "completed" | "failed" | "interrupted" | "queued" | "running";

export interface AutomationRun {
  readonly id: string;
  readonly automationId: string;
  readonly trigger: AutomationRunTrigger;
  readonly status: AutomationRunStatus;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly error: string | null;
  readonly reviewed: boolean;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
}

export interface AutomationListResponse {
  readonly data: readonly Automation[];
  readonly runs: readonly AutomationRun[];
}

export type WebSearchMode = "disabled" | "live";
export type ModelVerbosity = "high" | "low" | "medium";
export type Personality = "friendly" | "none" | "pragmatic";
export type MotionPreference = "full" | "reduced";
export type DiffDisplay = "split" | "unified";

export interface ApplicationPreferences {
  readonly schemaVersion: 1;
  readonly startWithWindows: boolean;
  readonly startMinimized: boolean;
  readonly closeToTray: boolean;
}

export interface DesktopPreferences {
  readonly uiFontSize: number;
  readonly motion: MotionPreference;
  readonly pointerCursor: boolean;
  readonly diffDisplay: DiffDisplay;
}

export interface AppConfig {
  readonly model: string | null;
  readonly modelReasoningEffort: ReasoningEffort | null;
  readonly serviceTier: string | null;
  readonly modelContextWindowPreferences: Readonly<Record<string, ModelContextWindowPreference>>;
  readonly permissionProfile: PermissionProfile;
  readonly webSearch: WebSearchMode;
  readonly modelVerbosity: ModelVerbosity | null;
  readonly personality: Personality;
  readonly developerInstructions: string | null;
  readonly desktop: DesktopPreferences;
}

export interface ConfigReadResponse {
  readonly config: AppConfig;
  readonly version: number;
}

export type ConfigUpdate =
  | { readonly type: "desktop"; readonly value: DesktopPreferences }
  | { readonly type: "developerInstructions"; readonly value: string | null }
  | {
      readonly type: "modelContextWindow";
      readonly model: string;
      readonly value: ModelContextWindowPreference;
    }
  | { readonly type: "modelVerbosity"; readonly value: ModelVerbosity | null }
  | { readonly type: "permissionProfile"; readonly value: PermissionProfile }
  | { readonly type: "personality"; readonly value: Personality }
  | { readonly type: "webSearch"; readonly value: WebSearchMode };

export interface ConfigUpdateResponse {
  readonly config: AppConfig;
  readonly version: number;
}

export interface RateLimitWindow {
  readonly usedPercent: number;
  readonly windowDurationMins: number | null;
  readonly resetsAt: number | null;
}

export interface CreditsSnapshot {
  readonly hasCredits: boolean;
  readonly unlimited: boolean;
  readonly balance: string | null;
}

export interface SpendControlLimitSnapshot {
  readonly limit: string;
  readonly used: string;
  readonly remainingPercent: number;
  readonly resetsAt: number;
}

export type AccountPlanType =
  | "business"
  | "edu"
  | "ent26"
  | "enterprise"
  | "enterprise_cbp_usage_based"
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "self_serve_business_prolite"
  | "self_serve_business_usage_based"
  | "team";

export type RateLimitReachedType =
  | "rate_limit_reached"
  | "workspace_member_credits_depleted"
  | "workspace_member_usage_limit_reached"
  | "workspace_owner_credits_depleted"
  | "workspace_owner_usage_limit_reached";

export interface RateLimitSnapshot {
  readonly limitId: string | null;
  readonly limitName: string | null;
  readonly primary: RateLimitWindow | null;
  readonly secondary: RateLimitWindow | null;
  readonly credits: CreditsSnapshot | null;
  readonly individualLimit: SpendControlLimitSnapshot | null;
  readonly spendControlReached: boolean | null;
  readonly planType: AccountPlanType | null;
  readonly rateLimitReachedType: RateLimitReachedType | null;
}

export interface AccountRateLimitsResponse {
  readonly rateLimits: RateLimitSnapshot;
  readonly rateLimitsByLimitId: Readonly<Record<string, RateLimitSnapshot>>;
}

export type AttachmentKind = "file" | "image";

export interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly kind: AttachmentKind;
  readonly size: number;
  readonly mediaType: string | null;
}

export interface AttachmentImageResponse {
  readonly dataUrl: string;
}

export interface AuthLoginCompletedNotification {
  readonly method: "auth.loginCompleted";
  readonly params: {
    readonly loginId: string;
    readonly success: boolean;
    readonly error: string | null;
  };
}

export interface AuthSessionChangedNotification {
  readonly method: "auth.sessionChanged";
  readonly params: { readonly signedIn: boolean };
}

export interface ThreadNotification {
  readonly method: "thread.created" | "thread.updated";
  readonly params: { readonly thread: ThreadSummary };
}

export interface ThreadArchivedNotification {
  readonly method: "thread.archived";
  readonly params: { readonly threadId: string };
}

export interface ThreadUnarchivedNotification {
  readonly method: "thread.unarchived";
  readonly params: { readonly threadId: string };
}

export interface ThreadDeletedNotification {
  readonly method: "thread.deleted";
  readonly params: { readonly threadId: string };
}

export interface TurnNotification {
  readonly method: "turn.started";
  readonly params: { readonly threadId: string; readonly turn: TurnSummary };
}

export interface TurnCompletedNotification {
  readonly method: "turn.completed";
  readonly params: {
    readonly threadId: string;
    readonly turn: CompletedTurn;
    readonly error: { readonly code: string; readonly message: string } | null;
  };
}

export interface ItemNotification {
  readonly method: "item.completed" | "item.started";
  readonly params: {
    readonly threadId: string;
    readonly turnId: string;
    readonly item: ThreadItem;
  };
}

export type StreamDeltaPayload =
  | {
      readonly kind: "agentText";
      readonly itemId: string;
      readonly delta: string;
    }
  | {
      readonly kind: "reasoningSummary" | "reasoningText";
      readonly itemId: string;
      readonly index: number;
      readonly delta: string;
    };

export interface StreamDeltasNotification {
  readonly method: "item.streamDeltas";
  readonly params: {
    readonly threadId: string;
    readonly turnId: string;
    readonly deltas: readonly StreamDeltaPayload[];
  };
}

export type ModelRerouteReason = "highRiskCyberActivity";
export type ModelVerification = "trustedAccessForCyber";

export interface ModelReroutedNotification {
  readonly method: "model.rerouted";
  readonly params: {
    readonly threadId: string;
    readonly turnId: string;
    readonly fromModel: string;
    readonly toModel: string;
    readonly reason: ModelRerouteReason;
  };
}

export interface ModelVerificationNotification {
  readonly method: "model.verification";
  readonly params: {
    readonly threadId: string;
    readonly turnId: string;
    readonly verifications: readonly ModelVerification[];
  };
}

export interface ModelSafetyBufferingUpdatedNotification {
  readonly method: "model.safetyBufferingUpdated";
  readonly params: {
    readonly threadId: string;
    readonly turnId: string;
    readonly model: string;
    readonly useCases: readonly string[];
    readonly reasons: readonly string[];
    readonly showBufferingUi: boolean;
    readonly fasterModel: string | null;
  };
}

export interface AutomationChangedNotification {
  readonly method: "automation.changed";
  readonly params: { readonly automation: Automation };
}

export interface AutomationDeletedNotification {
  readonly method: "automation.deleted";
  readonly params: { readonly automationId: string };
}

export interface AutomationRunUpdatedNotification {
  readonly method: "automation.runUpdated";
  readonly params: { readonly run: AutomationRun };
}

export type EngineNotification =
  | AutomationChangedNotification
  | AutomationDeletedNotification
  | AutomationRunUpdatedNotification
  | AuthLoginCompletedNotification
  | AuthSessionChangedNotification
  | ItemNotification
  | ModelReroutedNotification
  | ModelSafetyBufferingUpdatedNotification
  | ModelVerificationNotification
  | StreamDeltasNotification
  | ThreadArchivedNotification
  | ThreadDeletedNotification
  | ThreadNotification
  | ThreadUnarchivedNotification
  | TurnCompletedNotification
  | TurnNotification;

export interface CommandApprovalServerRequest {
  readonly id: string;
  readonly method: "approval.command";
  readonly params: {
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly command: string;
    readonly cwd: string;
    readonly reason: string;
  };
}

export type EngineServerRequest = CommandApprovalServerRequest;
export type ApprovalDecision = "accept" | "cancel" | "decline";

export interface CommandError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ProjectRecord {
  readonly name: string;
  readonly path: string;
  readonly icon?: string | undefined;
  readonly color?: string | undefined;
}
