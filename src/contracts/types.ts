export type RuntimeState = "failed" | "ready" | "starting" | "stopped";
export type DiagnosticStream = "runtime";
export type EngineTransport = "httpsSse";
export type EngineStorage = "sqlite";
export type EngineCapability =
  | "chatGptOauth"
  | "explicitApprovals"
  | "localThreads"
  | "modelStreaming"
  | "nativeTools";

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
  readonly schemaVersion: 1;
  readonly permissionProfile: PermissionProfile;
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
  readonly planType: string | null;
}

export interface AccountReadResponse {
  readonly account: ChatGptAccount | null;
  readonly requiresOpenaiAuth: true;
  readonly refresh: AuthRefreshResult;
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
  readonly isDefault: boolean;
}

export interface ModelListResponse {
  readonly data: readonly CodexModel[];
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

export type ThreadItem =
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
      readonly source: "agent";
      readonly status: ActivityStatus;
      readonly aggregatedOutput: string | null;
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
      readonly output: string | null;
    }
  | {
      readonly type: "userMessage";
      readonly id: string;
      readonly content: readonly UserContent[];
    };

export interface ThreadTurn {
  readonly id: string;
  readonly items: readonly ThreadItem[];
  readonly status: TurnStatus;
}

export type ThreadStatus =
  | { readonly type: "active"; readonly activeFlags: readonly "waitingOnApproval"[] }
  | { readonly type: "idle" | "systemError" };

export interface CodexThread {
  readonly id: string;
  readonly preview: string;
  readonly name: string | null;
  readonly cwd: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly recencyAt: number | null;
  readonly status: ThreadStatus;
  readonly turns: readonly ThreadTurn[];
}

export interface ThreadStartResponse {
  readonly thread: CodexThread;
}

export interface ThreadListResponse {
  readonly data: readonly CodexThread[];
  readonly nextCursor: string | null;
}

export interface ThreadReadResponse {
  readonly thread: CodexThread;
}

export interface ThreadResumeResponse {
  readonly thread: CodexThread;
  readonly cwd: string;
}

export interface TurnSummary {
  readonly id: string;
  readonly status: TurnStatus;
}

export interface TurnStartResponse {
  readonly turn: TurnSummary;
}

export interface OperationAck {
  readonly applied: true;
}

export type WebSearchMode = "disabled" | "live";
export type ModelVerbosity = "high" | "low" | "medium";
export type Personality = "friendly" | "none" | "pragmatic";
export type MotionPreference = "full" | "reduced";
export type DiffDisplay = "split" | "unified";

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
      readonly type: "modelDefaults";
      readonly value: {
        readonly model: string | null;
        readonly reasoningEffort: ReasoningEffort | null;
        readonly serviceTier: string | null;
      };
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
  readonly params: { readonly thread: CodexThread };
}

export interface ThreadArchivedNotification {
  readonly method: "thread.archived";
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
    readonly turn: TurnSummary;
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

export interface TextDeltaNotification {
  readonly method: "item.agentTextDelta";
  readonly params: {
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly delta: string;
  };
}

export interface IndexedTextDeltaNotification {
  readonly method: "item.reasoningSummaryDelta" | "item.reasoningTextDelta";
  readonly params: {
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly index: number;
    readonly delta: string;
  };
}

export type EngineNotification =
  | AuthLoginCompletedNotification
  | AuthSessionChangedNotification
  | IndexedTextDeltaNotification
  | ItemNotification
  | TextDeltaNotification
  | ThreadArchivedNotification
  | ThreadNotification
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
}
