use std::collections::BTreeMap;

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineTransport {
    HttpsSse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineStorage {
    Sqlite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineCapability {
    ChatGptOauth,
    LocalThreads,
    ModelStreaming,
    NativeTools,
    ExplicitApprovals,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineDescriptor {
    pub id: &'static str,
    pub name: &'static str,
    pub provider: &'static str,
    pub auth: &'static str,
    pub transport: EngineTransport,
    pub storage: EngineStorage,
    pub capabilities: Vec<EngineCapability>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStartResponse {
    pub engine: EngineDescriptor,
    pub schema_version: u32,
    pub permission_profile: PermissionProfile,
    pub permission_profiles: Vec<PermissionProfile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "method", content = "params")]
pub enum EngineNotification {
    #[serde(rename = "auth.loginCompleted")]
    AuthLoginCompleted(AuthLoginCompleted),
    #[serde(rename = "auth.sessionChanged")]
    AuthSessionChanged(AuthSessionChanged),
    #[serde(rename = "thread.created")]
    ThreadCreated(ThreadNotification),
    #[serde(rename = "thread.updated")]
    ThreadUpdated(ThreadNotification),
    #[serde(rename = "thread.archived")]
    ThreadArchived(ThreadArchivedNotification),
    #[serde(rename = "thread.unarchived")]
    ThreadUnarchived(ThreadUnarchivedNotification),
    #[serde(rename = "thread.deleted")]
    ThreadDeleted(ThreadDeletedNotification),
    #[serde(rename = "turn.started")]
    TurnStarted(TurnNotification),
    #[serde(rename = "turn.completed")]
    TurnCompleted(TurnCompletedNotification),
    #[serde(rename = "item.started")]
    ItemStarted(ItemNotification),
    #[serde(rename = "item.completed")]
    ItemCompleted(ItemNotification),
    #[serde(rename = "item.agentTextDelta")]
    AgentTextDelta(TextDeltaNotification),
    #[serde(rename = "item.reasoningSummaryDelta")]
    ReasoningSummaryDelta(IndexedTextDeltaNotification),
    #[serde(rename = "item.reasoningTextDelta")]
    ReasoningTextDelta(IndexedTextDeltaNotification),
    #[serde(rename = "model.rerouted")]
    ModelRerouted(ModelReroutedNotification),
    #[serde(rename = "model.verification")]
    ModelVerification(ModelVerificationNotification),
    #[serde(rename = "turn.moderationMetadata")]
    TurnModerationMetadata(TurnModerationMetadataNotification),
    #[serde(rename = "model.safetyBufferingUpdated")]
    ModelSafetyBufferingUpdated(ModelSafetyBufferingUpdatedNotification),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthLoginCompleted {
    pub login_id: String,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSessionChanged {
    pub signed_in: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadNotification {
    pub thread: CodexThread,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadArchivedNotification {
    pub thread_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUnarchivedNotification {
    pub thread_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDeletedNotification {
    pub thread_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnNotification {
    pub thread_id: String,
    pub turn: TurnSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCompletedNotification {
    pub thread_id: String,
    pub turn: CompletedTurn,
    pub error: Option<OperationFailure>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationFailure {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub item: ThreadItem,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDeltaNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedTextDeltaNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub index: usize,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelReroutedNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub from_model: String,
    pub to_model: String,
    pub reason: ModelRerouteReason,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelRerouteReason {
    HighRiskCyberActivity,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelVerificationNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub verifications: Vec<ModelVerification>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelVerification {
    TrustedAccessForCyber,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnModerationMetadataNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSafetyBufferingUpdatedNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub model: String,
    pub use_cases: Vec<String>,
    pub reasons: Vec<String>,
    pub show_buffering_ui: bool,
    pub faster_model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineServerRequest {
    pub id: String,
    #[serde(flatten)]
    pub request: ServerRequest,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "method", content = "params")]
pub enum ServerRequest {
    #[serde(rename = "approval.command")]
    ApproveCommand(CommandApprovalRequest),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandApprovalRequest {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub command: String,
    pub cwd: String,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerResponse {
    pub decision: ApprovalDecision,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    Accept,
    Decline,
    Cancel,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeState {
    Starting,
    Ready,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub state: RuntimeState,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiagnostic {
    pub stream: DiagnosticStream,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticStream {
    Runtime,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationAck {
    pub applied: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalPolicy {
    Untrusted,
    OnRequest,
    Never,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionProfile {
    pub sandbox: SandboxMode,
    pub approvals: ApprovalPolicy,
}

impl PermissionProfile {
    pub const fn read_only() -> Self {
        Self {
            sandbox: SandboxMode::ReadOnly,
            approvals: ApprovalPolicy::Untrusted,
        }
    }

    pub const fn workspace_write() -> Self {
        Self {
            sandbox: SandboxMode::WorkspaceWrite,
            approvals: ApprovalPolicy::OnRequest,
        }
    }

    pub const fn full_access() -> Self {
        Self {
            sandbox: SandboxMode::DangerFullAccess,
            approvals: ApprovalPolicy::Never,
        }
    }

    pub const fn is_supported(self) -> bool {
        matches!(
            (self.sandbox, self.approvals),
            (SandboxMode::ReadOnly, ApprovalPolicy::Untrusted)
                | (SandboxMode::WorkspaceWrite, ApprovalPolicy::OnRequest)
                | (SandboxMode::DangerFullAccess, ApprovalPolicy::Never)
        )
    }
}

impl Default for PermissionProfile {
    fn default() -> Self {
        Self::workspace_write()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
    Max,
    Ultra,
}

impl ReasoningEffort {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::XHigh => "xhigh",
            Self::Max => "max",
            Self::Ultra => "ultra",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningEffortOption {
    pub reasoning_effort: ReasoningEffort,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelServiceTier {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelContextWindow {
    pub tokens: u64,
    pub usable_tokens: u64,
    pub usable_percent: u8,
    pub maximum_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModel {
    pub id: String,
    pub model: String,
    pub display_name: String,
    pub description: Option<String>,
    pub hidden: bool,
    pub supported_reasoning_efforts: Vec<ReasoningEffortOption>,
    pub default_reasoning_effort: Option<ReasoningEffort>,
    pub service_tiers: Vec<ModelServiceTier>,
    pub default_service_tier: Option<String>,
    pub context_window: Option<ModelContextWindow>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelListResponse {
    pub data: Vec<CodexModel>,
}

#[derive(Debug, Clone)]
pub enum TurnInput {
    Text(String),
    LocalImage { path: String },
    Mention { name: String, path: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatus {
    Completed,
    Failed,
    InProgress,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityStatus {
    Completed,
    Declined,
    Failed,
    InProgress,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MessagePhase {
    Commentary,
    FinalAnswer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum UserContent {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "localImage")]
    LocalImage {
        path: String,
        detail: Option<ImageDetail>,
    },
    #[serde(rename = "mention")]
    Mention { name: String, path: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageDetail {
    Auto,
    Low,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileChange {
    pub path: String,
    pub kind: FileChangeKind,
    pub diff: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FileChangeKind {
    Add,
    Delete,
    Update { move_path: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum ThreadItem {
    #[serde(rename = "contextUsage")]
    ContextUsage {
        id: String,
        model: String,
        usage: TokenUsage,
        #[serde(rename = "contextWindow")]
        context_window: Option<ModelContextWindow>,
    },
    #[serde(rename = "contextCompaction")]
    ContextCompaction { id: String },
    #[serde(rename = "userMessage")]
    UserMessage {
        id: String,
        content: Vec<UserContent>,
    },
    #[serde(rename = "agentMessage")]
    AgentMessage {
        id: String,
        text: String,
        phase: Option<MessagePhase>,
    },
    #[serde(rename = "reasoning")]
    Reasoning {
        id: String,
        summary: Vec<String>,
        content: Vec<String>,
    },
    #[serde(rename = "commandExecution")]
    CommandExecution {
        id: String,
        command: String,
        cwd: String,
        #[serde(rename = "processId")]
        process_id: Option<String>,
        source: CommandSource,
        status: ActivityStatus,
        #[serde(rename = "aggregatedOutput")]
        aggregated_output: Option<String>,
        #[serde(rename = "exitCode")]
        exit_code: Option<i32>,
        #[serde(rename = "durationMs")]
        duration_ms: Option<u64>,
    },
    #[serde(rename = "fileChange")]
    FileChange {
        id: String,
        changes: Vec<FileChange>,
        status: ActivityStatus,
    },
    #[serde(rename = "toolExecution")]
    ToolExecution {
        id: String,
        name: String,
        description: String,
        status: ActivityStatus,
        output: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandSource {
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadTurn {
    pub id: String,
    pub items: Vec<ThreadItem>,
    pub status: TurnStatus,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum ThreadStatus {
    #[serde(rename = "active")]
    Active {
        #[serde(rename = "activeFlags")]
        active_flags: Vec<ThreadActiveFlag>,
    },
    #[serde(rename = "idle")]
    Idle,
    #[serde(rename = "systemError")]
    SystemError,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThreadActiveFlag {
    WaitingOnApproval,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexThread {
    pub id: String,
    pub preview: String,
    pub name: Option<String>,
    pub cwd: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub recency_at: Option<i64>,
    pub status: ThreadStatus,
    pub turns: Vec<ThreadTurn>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadStartResponse {
    pub thread: CodexThread,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadForkResponse {
    pub thread: CodexThread,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadUnarchiveResponse {
    pub thread: CodexThread,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadCompactStartResponse {}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListResponse {
    pub data: Vec<CodexThread>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadReadResponse {
    pub thread: CodexThread,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadResumeResponse {
    pub thread: CodexThread,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TurnStartResponse {
    pub turn: TurnSummary,
}

#[derive(Debug, Clone, Serialize)]
pub struct TurnSummary {
    pub id: String,
    pub status: TurnStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedTurn {
    pub id: String,
    pub status: TurnStatus,
    pub error: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppConfig {
    pub model: Option<String>,
    pub model_reasoning_effort: Option<ReasoningEffort>,
    pub service_tier: Option<String>,
    pub permission_profile: PermissionProfile,
    pub web_search: WebSearchMode,
    pub model_verbosity: Option<ModelVerbosity>,
    pub personality: Personality,
    pub developer_instructions: Option<String>,
    pub desktop: DesktopPreferences,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelDefaults {
    pub model: Option<String>,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub service_tier: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            model: None,
            model_reasoning_effort: None,
            service_tier: None,
            permission_profile: PermissionProfile::default(),
            web_search: WebSearchMode::Disabled,
            model_verbosity: None,
            personality: Personality::Pragmatic,
            developer_instructions: None,
            desktop: DesktopPreferences::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WebSearchMode {
    Disabled,
    Live,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelVerbosity {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Personality {
    Friendly,
    Pragmatic,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopPreferences {
    pub ui_font_size: u8,
    pub motion: MotionPreference,
    pub pointer_cursor: bool,
    pub diff_display: DiffDisplay,
}

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            ui_font_size: 14,
            motion: MotionPreference::Full,
            pointer_cursor: true,
            diff_display: DiffDisplay::Unified,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MotionPreference {
    Full,
    Reduced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffDisplay {
    Split,
    Unified,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigReadResponse {
    pub config: AppConfig,
    pub version: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ConfigUpdate {
    ModelDefaults { value: ModelDefaults },
    PermissionProfile { value: PermissionProfile },
    WebSearch { value: WebSearchMode },
    ModelVerbosity { value: Option<ModelVerbosity> },
    Personality { value: Personality },
    DeveloperInstructions { value: Option<String> },
    Desktop { value: DesktopPreferences },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigUpdateResponse {
    pub config: AppConfig,
    pub version: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitWindow {
    pub used_percent: f64,
    pub window_duration_mins: Option<i64>,
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditsSnapshot {
    pub has_credits: bool,
    pub unlimited: bool,
    pub balance: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendControlLimitSnapshot {
    pub limit: String,
    pub used: String,
    pub remaining_percent: i64,
    pub resets_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountPlanType {
    Free,
    Go,
    Plus,
    Pro,
    Prolite,
    Team,
    SelfServeBusinessProlite,
    SelfServeBusinessUsageBased,
    Business,
    Ent26,
    EnterpriseCbpUsageBased,
    Enterprise,
    Edu,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RateLimitReachedType {
    RateLimitReached,
    WorkspaceOwnerCreditsDepleted,
    WorkspaceMemberCreditsDepleted,
    WorkspaceOwnerUsageLimitReached,
    WorkspaceMemberUsageLimitReached,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitSnapshot {
    pub limit_id: Option<String>,
    pub limit_name: Option<String>,
    pub primary: Option<RateLimitWindow>,
    pub secondary: Option<RateLimitWindow>,
    pub credits: Option<CreditsSnapshot>,
    pub individual_limit: Option<SpendControlLimitSnapshot>,
    pub spend_control_reached: Option<bool>,
    pub plan_type: Option<AccountPlanType>,
    pub rate_limit_reached_type: Option<RateLimitReachedType>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRateLimitsResponse {
    pub rate_limits: RateLimitSnapshot,
    pub rate_limits_by_limit_id: BTreeMap<String, RateLimitSnapshot>,
}

#[cfg(test)]
mod tests {
    use super::AppConfig;
    use super::FileChangeKind;
    use super::PermissionProfile;

    #[test]
    fn default_configuration_is_explicit_and_safe() {
        let config = AppConfig::default();
        assert_eq!(
            config.permission_profile,
            PermissionProfile::workspace_write()
        );
        assert!(config.model.is_none());
    }

    #[test]
    fn file_change_update_uses_camel_case_variant_fields() {
        let value = serde_json::to_value(FileChangeKind::Update {
            move_path: Some("src/new.rs".into()),
        })
        .expect("file change kind should serialize");

        assert_eq!(
            value,
            serde_json::json!({
                "type": "update",
                "movePath": "src/new.rs"
            })
        );
    }
}
