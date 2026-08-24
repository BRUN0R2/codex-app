use std::path::Path;
use std::sync::OnceLock;
use std::sync::Weak;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::AppHandle;
use tokio::sync::watch;

use super::apply_patch::parser::{ParsedPatch, parse_patch};
use super::apply_patch::plan::{prepare_patch, preview_changes};
use super::apply_patch::transaction::{PatchOutcome, commit_patch};
use super::approval::ApprovalBroker;
use super::file_diff::{line_stats, render_replacement_diff};
use super::output::OutputSource;
use super::output_compaction::{TextOutputKind, compact_command_output, compact_text};
use super::storage::{MAX_OUTPUT_SEARCH_QUERY_BYTES, NativeStorage};
use super::stream_notifications::StreamNotificationBatcher;
use super::text::truncate_utf8;
use crate::engine::{
    ActivityStatus, ApprovalDecision, ApprovalPolicy, CommandApprovalRequest, CommandLiveOutput,
    CommandSource, FileChange, FileChangeKind, PermissionProfile, PlanStep, PlanStepStatus,
    SandboxMode, ThreadItem, ToolOutputPresentation,
};
use crate::error::AppError;

mod browser;
mod command_output_stream;
mod command_sessions;
mod exec;
pub(super) use self::command_sessions::CommandSessionManager;
use self::command_sessions::{BackgroundCommandLease, BackgroundCommandStart, CommandStartOutcome};
mod fs;
mod read_cache;
mod ripgrep;
mod workspace;

use self::exec::{CommandOutput, command_timeout, command_yield_time};
use self::fs::{edit_file, list_files, read_file, search_text, write_file};
use self::read_cache::CachedReadOutput;
pub(super) use self::read_cache::{ReadToolCache, ReadToolCacheKey};
pub(super) use self::ripgrep::Ripgrep;
use self::workspace::{canonical_workspace, display_workspace_path, resolve_existing_directory};

pub(super) const MAX_PROVIDER_ITEM_BYTES: usize = 2 * 1_048_576;
const MAX_TOOL_ARGUMENT_BYTES: usize = 262_144;
const MAX_TOOL_DESCRIPTION_BYTES: usize = 160;
const MAX_FILE_BYTES: usize = 2 * 1_048_576;
const MAX_READ_LINES: usize = 2_000;
const MAX_LIST_RESULTS: usize = 500;
const MAX_LIST_DEPTH: usize = 12;
const MAX_SEARCH_RESULTS: usize = 200;
const MAX_SEARCH_QUERY_BYTES: usize = 1_024;
const MAX_SEARCH_LINE_BYTES: usize = 500;
const MAX_EDIT_OCCURRENCES: u16 = 100;
const MAX_COMMAND_BYTES: usize = 16_384;
const MAX_COMMAND_REASON_BYTES: usize = 1_024;
const MAX_COMMAND_STREAM_CHUNK_BYTES: usize = 8_192;
const MAX_PLAN_STEPS: usize = 20;
const MAX_PLAN_STEP_BYTES: usize = 1_024;
const MAX_PLAN_EXPLANATION_BYTES: usize = 4_096;
const MAX_TOOL_PATH_BYTES: usize = 4_096;
const DEFAULT_COMMAND_TIMEOUT_SECONDS: u64 = 60 * 60;
const MAX_COMMAND_TIMEOUT_SECONDS: u64 = 7 * 24 * 60 * 60;
const DEFAULT_COMMAND_YIELD_MILLISECONDS: u64 = 10_000;
const MIN_COMMAND_YIELD_MILLISECONDS: u64 = 250;
const MAX_COMMAND_YIELD_MILLISECONDS: u64 = 30_000;
const MAX_COMMAND_POLL_WAIT_SECONDS: u16 = 300;
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Debug, Default)]
pub struct ToolRegistry;

static TOOL_DEFINITIONS: OnceLock<Vec<Value>> = OnceLock::new();
static READ_ONLY_TOOL_DEFINITIONS: OnceLock<Vec<Value>> = OnceLock::new();

#[derive(Debug)]
pub struct PreparedTool {
    item_id: String,
    name: &'static str,
    description: String,
    operation: ToolOperation,
    started_at_ms: OnceLock<i64>,
}

#[derive(Debug)]
enum ToolOperation {
    ApplyPatch(ParsedPatch),
    Browser(browser::BrowserToolOperation),
    ReadFile(ReadFileArgs),
    ListFiles(ListFilesArgs),
    SearchText(SearchTextArgs),
    EditFile(EditFileArgs),
    WriteFile(WriteFileArgs),
    ReadOutput(ReadOutputArgs),
    ExecCommand(ExecCommandArgs),
    PollCommand(PollCommandArgs),
    UpdatePlan {
        explanation: Option<String>,
        steps: Vec<PlanStep>,
    },
}

#[derive(Debug)]
pub struct ToolExecutionResult {
    pub provider_output: String,
    pub completed_item: ThreadItem,
    pub display_output: Option<OutputSource>,
    pub background_command: Option<BackgroundCommandLease>,
    pub visual_context: Option<ToolVisualContext>,
}

#[derive(Debug)]
pub struct ToolVisualContext {
    pub image_url: String,
    pub description: String,
}

pub struct ToolExecutionContext<'a> {
    pub engine: Weak<super::NativeEngineInner>,
    pub app: &'a AppHandle,
    pub workspace: &'a Path,
    pub permissions: PermissionProfile,
    pub thread_id: &'a str,
    pub turn_id: &'a str,
    pub approvals: &'a ApprovalBroker,
    pub storage: &'a NativeStorage,
    pub ripgrep: &'a Ripgrep,
    pub command_sessions: &'a CommandSessionManager,
    pub stream_deltas: &'a StreamNotificationBatcher,
    pub(super) read_cache: &'a ReadToolCache,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadFileArgs {
    path: String,
    start_line: u32,
    end_line: u32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListFilesArgs {
    path: String,
    max_depth: u8,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchTextArgs {
    path: String,
    query: String,
    case_sensitive: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditFileArgs {
    path: String,
    old_text: String,
    new_text: String,
    expected_occurrences: u16,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteFileArgs {
    path: String,
    content: String,
    overwrite: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecCommandArgs {
    command: String,
    cwd: String,
    reason: String,
    parallel_safe: bool,
    #[serde(default)]
    yield_time_ms: Option<u64>,
    #[serde(default)]
    timeout_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PollCommandArgs {
    session_id: String,
    cursor: Option<u64>,
    wait_seconds: u16,
}

#[derive(Debug)]
struct ReadOutputArgs {
    output_id: String,
    selector: ReadOutputSelector,
}

#[derive(Debug)]
enum ReadOutputSelector {
    Page { cursor: Option<String> },
    Search { query: String },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawReadOutputArgs {
    output_id: String,
    cursor: Option<String>,
    query: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdatePlanArgs {
    explanation: Option<String>,
    plan: Vec<UpdatePlanStep>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdatePlanStep {
    step: String,
    status: UpdatePlanStatus,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum UpdatePlanStatus {
    Pending,
    InProgress,
    Completed,
}

impl ToolRegistry {
    pub fn definitions(&self) -> &'static [Value] {
        TOOL_DEFINITIONS
            .get_or_init(Self::build_definitions)
            .as_slice()
    }

    pub fn definitions_for(&self, permissions: PermissionProfile) -> &'static [Value] {
        if permissions.sandbox != SandboxMode::ReadOnly {
            return self.definitions();
        }
        READ_ONLY_TOOL_DEFINITIONS
            .get_or_init(|| {
                self.definitions()
                    .iter()
                    .filter(|definition| {
                        !matches!(
                            definition["name"].as_str(),
                            Some("apply_patch" | "edit_file" | "exec_command" | "write_file")
                        )
                    })
                    .cloned()
                    .collect()
            })
            .as_slice()
    }

    fn build_definitions() -> Vec<Value> {
        let mut definitions = vec![
            function_tool(
                "read_file",
                "Read a bounded UTF-8 range from a file inside the workspace.",
                json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Workspace-relative file path." },
                        "start_line": { "type": "integer", "minimum": 1 },
                        "end_line": { "type": "integer", "minimum": 1 }
                    },
                    "required": ["path", "start_line", "end_line"],
                    "additionalProperties": false
                }),
            ),
            function_tool(
                "list_files",
                "List workspace-relative files without following symlinks.",
                json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Workspace-relative directory, or . for the root." },
                        "max_depth": { "type": "integer", "minimum": 1, "maximum": MAX_LIST_DEPTH }
                    },
                    "required": ["path", "max_depth"],
                    "additionalProperties": false
                }),
            ),
            function_tool(
                "search_text",
                "Search UTF-8 files inside the workspace for an exact text fragment.",
                json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Workspace-relative file or directory." },
                        "query": { "type": "string", "minLength": 1 },
                        "case_sensitive": { "type": "boolean" }
                    },
                    "required": ["path", "query", "case_sensitive"],
                    "additionalProperties": false
                }),
            ),
            function_tool(
                "edit_file",
                "Replace an exact text fragment in an existing UTF-8 workspace file.",
                json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Workspace-relative file path." },
                        "old_text": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The exact existing fragment to replace. Keep unchanged surrounding lines outside this fragment unless they are needed to make the match unique."
                        },
                        "new_text": {
                            "type": "string",
                            "description": "The complete replacement for old_text. Include every intended line exactly once and do not repeat unchanged boundary lines."
                        },
                        "expected_occurrences": { "type": "integer", "minimum": 1, "maximum": MAX_EDIT_OCCURRENCES }
                    },
                    "required": ["path", "old_text", "new_text", "expected_occurrences"],
                    "additionalProperties": false
                }),
            ),
            function_tool(
                "write_file",
                "Create or explicitly replace one UTF-8 file inside the workspace.",
                json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Workspace-relative file path." },
                        "content": { "type": "string" },
                        "overwrite": { "type": "boolean" }
                    },
                    "required": ["path", "content", "overwrite"],
                    "additionalProperties": false
                }),
            ),
            function_tool(
                "exec_command",
                "Run one non-interactive PowerShell command in the workspace. Commands that outlive yield_time_ms continue in an engine-owned background session that can be checked with poll_command while other work proceeds. Full output is spooled for read_output after completion. External windows remain unsupported and child processes stay headless. Workspace-write mode asks the user first.",
                json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "minLength": 1 },
                        "cwd": { "type": "string", "description": "Workspace-relative working directory, or . for the root." },
                        "reason": { "type": "string", "minLength": 1, "description": "A concise user-facing reason." },
                        "parallel_safe": {
                            "type": "boolean",
                            "description": "Set true only when this command is independent of every other command emitted in the same response, does not mutate shared files or configuration, and does not depend on another command's output. Otherwise set false. Parallel execution is additionally restricted by the active permission profile."
                        },
                        "yield_time_ms": {
                            "type": ["integer", "null"],
                            "minimum": MIN_COMMAND_YIELD_MILLISECONDS,
                            "maximum": MAX_COMMAND_YIELD_MILLISECONDS,
                            "description": "Maximum foreground wait before a still-running command returns a session_id. Use null for the 10000 ms default. Commands that finish sooner return normally; use a shorter value for known long-running independent work."
                        },
                        "timeout_seconds": {
                            "type": ["integer", "null"],
                            "minimum": 1,
                            "maximum": MAX_COMMAND_TIMEOUT_SECONDS,
                            "description": "Execution budget in seconds, chosen by the agent from the command's expected worst-case duration. Use null for the safe one-hour default. Do not guess short limits for recursive searches, builds, tests, installs, or external tools; long-running work can request up to seven days."
                        }
                    },
                    "required": ["command", "cwd", "reason", "parallel_safe", "yield_time_ms", "timeout_seconds"],
                    "additionalProperties": false
                }),
            ),
            function_tool(
                "poll_command",
                "Wait for new output or terminal status from an engine-owned command session. Polling is read-only, serialized per session, and may run alongside unrelated tools or polls for other sessions.",
                json!({
                    "type": "object",
                    "properties": {
                        "session_id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Session identifier returned by exec_command."
                        },
                        "cursor": {
                            "type": ["integer", "null"],
                            "minimum": 0,
                            "description": "Last observed revision, or null for the first poll."
                        },
                        "wait_seconds": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": MAX_COMMAND_POLL_WAIT_SECONDS,
                            "description": "Maximum wait for output or completion. Use 0 for an immediate status check."
                        }
                    },
                    "required": ["session_id", "cursor", "wait_seconds"],
                    "additionalProperties": false
                }),
            ),
            function_tool(
                "read_output",
                "Retrieve a stored tool or command output. Set query to an exact text fragment to return only matching lines; otherwise set query to null and read one raw UTF-8 page using cursor.",
                json!({
                    "type": "object",
                    "properties": {
                        "output_id": { "type": "string", "minLength": 1 },
                        "cursor": {
                            "type": ["string", "null"],
                            "description": "Raw page cursor. Use null for the first page and whenever query is not null."
                        },
                        "query": {
                            "type": ["string", "null"],
                            "maxLength": MAX_OUTPUT_SEARCH_QUERY_BYTES,
                            "description": "Exact text fragment to search without loading unrelated pages, or null for raw paging."
                        }
                    },
                    "required": ["output_id", "cursor", "query"],
                    "additionalProperties": false
                }),
            ),
            function_tool(
                "update_plan",
                "Publish the current multi-step work plan shown in the desktop UI. Keep at most one step in progress and update statuses as work advances.",
                json!({
                    "type": "object",
                    "properties": {
                        "explanation": {
                            "type": ["string", "null"],
                            "maxLength": MAX_PLAN_EXPLANATION_BYTES,
                            "description": "Optional concise reason for changing the plan."
                        },
                        "plan": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": MAX_PLAN_STEPS,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "step": { "type": "string", "minLength": 1, "maxLength": MAX_PLAN_STEP_BYTES },
                                    "status": { "type": "string", "enum": ["pending", "in_progress", "completed"] }
                                },
                                "required": ["step", "status"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": ["explanation", "plan"],
                    "additionalProperties": false
                }),
            ),
            json!({
                "type": "custom",
                "name": "apply_patch",
                "description": "Edit files with the supplied patch grammar. Send raw patch text, never JSON. `@@` opens a change block and never closes one: before another `@@`, file marker, or `*** End Patch`, every block must contain at least one `+` or `-` line. Never emit a trailing or standalone `@@`. A valid block is `@@\\n context\\n-old\\n+new`, with no closing marker. Prefix unchanged context with one space and include boundary lines exactly once. To append, keep context and `+` lines in the same block.",
                "format": {
                    "type": "grammar",
                    "syntax": "lark",
                    "definition": include_str!("../apply_patch/apply_patch.lark")
                }
            }),
        ];
        definitions.extend(browser::definitions());
        definitions
    }

    pub fn prepare(
        &self,
        item_id: String,
        name: &str,
        arguments: &str,
    ) -> Result<PreparedTool, AppError> {
        validate_identifier("tool item id", &item_id)?;
        if arguments.len() > MAX_TOOL_ARGUMENT_BYTES {
            return Err(AppError::Tool(format!(
                "tool arguments exceed {MAX_TOOL_ARGUMENT_BYTES} bytes"
            )));
        }
        let (name, description, operation) = match name {
            "read_file" => {
                let args: ReadFileArgs = decode_arguments(name, arguments)?;
                let description = format!("Read {}", args.path);
                ("read_file", description, ToolOperation::ReadFile(args))
            }
            "list_files" => {
                let args: ListFilesArgs = decode_arguments(name, arguments)?;
                let description = format!("List {}", args.path);
                ("list_files", description, ToolOperation::ListFiles(args))
            }
            "search_text" => {
                let args: SearchTextArgs = decode_arguments(name, arguments)?;
                let description = format!("Search {}", args.path);
                ("search_text", description, ToolOperation::SearchText(args))
            }
            "edit_file" => {
                let args: EditFileArgs = decode_arguments(name, arguments)?;
                let description = format!("Edit {}", args.path);
                ("edit_file", description, ToolOperation::EditFile(args))
            }
            "write_file" => {
                let args: WriteFileArgs = decode_arguments(name, arguments)?;
                let description = format!("Write {}", args.path);
                ("write_file", description, ToolOperation::WriteFile(args))
            }
            "exec_command" => {
                let args: ExecCommandArgs = decode_arguments(name, arguments)?;
                command_timeout(&args)?;
                command_yield_time(&args)?;
                let description = format!(
                    "Run {}",
                    truncate_utf8(&args.command, MAX_TOOL_DESCRIPTION_BYTES)
                );
                (
                    "exec_command",
                    description,
                    ToolOperation::ExecCommand(args),
                )
            }
            "poll_command" => {
                let args: PollCommandArgs = decode_arguments(name, arguments)?;
                validate_identifier("command session id", &args.session_id)?;
                if args.wait_seconds > MAX_COMMAND_POLL_WAIT_SECONDS {
                    return Err(AppError::Tool(format!(
                        "command poll wait must not exceed {MAX_COMMAND_POLL_WAIT_SECONDS} seconds"
                    )));
                }
                let description = format!("Poll command {}", args.session_id);
                (
                    "poll_command",
                    description,
                    ToolOperation::PollCommand(args),
                )
            }
            "read_output" => {
                let raw: RawReadOutputArgs = decode_arguments(name, arguments)?;
                let args = normalize_read_output_args(raw)?;
                let description = match &args.selector {
                    ReadOutputSelector::Page { .. } => {
                        format!("Read stored output {}", args.output_id)
                    }
                    ReadOutputSelector::Search { .. } => {
                        format!("Search stored output {}", args.output_id)
                    }
                };
                ("read_output", description, ToolOperation::ReadOutput(args))
            }
            "update_plan" => {
                let args: UpdatePlanArgs = decode_arguments(name, arguments)?;
                let (explanation, steps) = normalize_plan(args)?;
                (
                    "update_plan",
                    "Update work plan".into(),
                    ToolOperation::UpdatePlan { explanation, steps },
                )
            }
            _ => match browser::prepare(name, arguments) {
                Some(prepared) => {
                    let (name, description, operation) = prepared?;
                    (name, description, ToolOperation::Browser(operation))
                }
                None => return Err(AppError::Tool(format!("unknown tool `{name}`"))),
            },
        };
        Ok(PreparedTool {
            item_id,
            name,
            description,
            operation,
            started_at_ms: OnceLock::new(),
        })
    }

    pub fn prepare_custom(
        &self,
        item_id: String,
        name: &str,
        input: &str,
    ) -> Result<PreparedTool, AppError> {
        validate_identifier("tool item id", &item_id)?;
        if input.len() > MAX_PROVIDER_ITEM_BYTES {
            return Err(AppError::Tool(format!(
                "custom tool input exceeds {MAX_PROVIDER_ITEM_BYTES} bytes"
            )));
        }
        match name {
            "apply_patch" => {
                let patch = parse_patch(input)?;
                let file_count = patch.hunks.len();
                let noun = if file_count == 1 { "file" } else { "files" };
                Ok(PreparedTool {
                    item_id,
                    name: "apply_patch",
                    description: format!("Apply patch to {file_count} {noun}"),
                    operation: ToolOperation::ApplyPatch(patch),
                    started_at_ms: OnceLock::new(),
                })
            }
            _ => Err(AppError::Tool(format!("unknown custom tool `{name}`"))),
        }
    }
}

struct ThreadItemParams {
    status: ActivityStatus,
    live_output: Option<CommandLiveOutput>,
    process_id: Option<String>,
    exit_code: Option<i32>,
    duration_ms: Option<u64>,
}

impl PreparedTool {
    pub fn name(&self) -> &'static str {
        self.name
    }

    pub fn supports_parallel_execution(&self, permissions: PermissionProfile) -> bool {
        match &self.operation {
            ToolOperation::ReadFile(_)
            | ToolOperation::ListFiles(_)
            | ToolOperation::SearchText(_)
            | ToolOperation::ReadOutput(_)
            | ToolOperation::PollCommand(_) => true,
            ToolOperation::ExecCommand(args) => {
                args.parallel_safe
                    && permissions.sandbox == SandboxMode::DangerFullAccess
                    && permissions.approvals == ApprovalPolicy::Never
            }
            _ => false,
        }
    }

    fn output_presentation(&self) -> ToolOutputPresentation {
        match &self.operation {
            ToolOperation::Browser(operation) if operation.presents_image() => {
                ToolOutputPresentation::Image
            }
            ToolOperation::ListFiles(_) => ToolOutputPresentation::FileList,
            ToolOperation::ReadFile(args) => ToolOutputPresentation::SourceFile {
                path: args.path.clone(),
            },
            ToolOperation::SearchText(_) => ToolOutputPresentation::SearchResults,
            _ => ToolOutputPresentation::PlainText,
        }
    }

    fn read_cache_key(
        &self,
        workspace: &Path,
        thread_id: &str,
    ) -> Result<ReadToolCacheKey, AppError> {
        ReadToolCacheKey::from_operation(workspace, thread_id, &self.operation).ok_or_else(|| {
            AppError::State(format!(
                "non-readable tool `{}` entered the read cache",
                self.name
            ))
        })
    }

    pub(super) fn read_dedup_key(
        &self,
        workspace: &Path,
        thread_id: &str,
    ) -> Option<ReadToolCacheKey> {
        ReadToolCacheKey::from_operation(workspace, thread_id, &self.operation)
    }

    pub(super) fn duplicate_read_result(
        &self,
        workspace: &Path,
        original_call_id: &str,
    ) -> ToolExecutionResult {
        ToolExecutionResult {
            provider_output: format!(
                "Duplicate read skipped; the identical result was returned by tool call `{original_call_id}`."
            ),
            completed_item: self.finish_item(workspace, ActivityStatus::Completed, None, Some(0)),
            display_output: None,
            background_command: None,
            visual_context: None,
        }
    }

    pub fn started_item(&self, workspace: &Path) -> ThreadItem {
        self.build_item(
            workspace,
            ThreadItemParams {
                status: ActivityStatus::InProgress,
                live_output: Some(CommandLiveOutput::default()),
                process_id: None,
                exit_code: None,
                duration_ms: None,
            },
        )
    }

    pub fn failed_result(&self, workspace: &Path, error: &AppError) -> ToolExecutionResult {
        let message = error.to_string();
        self.result_with_output(workspace, ActivityStatus::Failed, message, None, None)
    }

    pub async fn execute(
        &self,
        context: ToolExecutionContext<'_>,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<ToolExecutionResult, AppError> {
        if let ToolOperation::UpdatePlan { explanation, steps } = &self.operation {
            return Ok(ToolExecutionResult {
                provider_output: "Plan updated.".into(),
                completed_item: ThreadItem::Plan {
                    id: self.item_id.clone(),
                    explanation: explanation.clone(),
                    steps: steps.clone(),
                },
                display_output: None,
                background_command: None,
                visual_context: None,
            });
        }
        let workspace = canonical_workspace(context.workspace).await?;
        let started_at = Instant::now();
        let execution = match &self.operation {
            ToolOperation::Browser(operation) => {
                browser::execute(operation, &self.item_id, &context, cancellation)
                    .await
                    .map(ToolResult::Browser)
            }
            ToolOperation::ApplyPatch(patch) => execute_patch_operation(
                &workspace,
                patch.clone(),
                context.permissions,
                cancellation,
            )
            .await
            .map(ToolResult::Patch),
            ToolOperation::ReadFile(args) => context
                .read_cache
                .get_or_execute(
                    self.read_cache_key(&workspace, context.thread_id)?,
                    || async {
                        read_file(&workspace, args)
                            .await
                            .map(|output| CachedReadOutput::text(output, TextOutputKind::ReadFile))
                    },
                )
                .await
                .map(|output| ToolResult::StoredOutput(output.into_stored_output())),
            ToolOperation::ListFiles(args) => context
                .read_cache
                .get_or_execute(
                    self.read_cache_key(&workspace, context.thread_id)?,
                    || async {
                        list_files(&workspace, args)
                            .await
                            .map(|output| CachedReadOutput::text(output, TextOutputKind::ListFiles))
                    },
                )
                .await
                .map(|output| ToolResult::StoredOutput(output.into_stored_output())),
            ToolOperation::SearchText(args) => context
                .read_cache
                .get_or_execute(
                    self.read_cache_key(&workspace, context.thread_id)?,
                    || async {
                        search_text(context.ripgrep, &workspace, args, cancellation)
                            .await
                            .map(|output| {
                                CachedReadOutput::text(output, TextOutputKind::SearchText)
                            })
                    },
                )
                .await
                .map(|output| ToolResult::StoredOutput(output.into_stored_output())),
            ToolOperation::ReadOutput(args) => context
                .read_cache
                .get_or_execute(
                    self.read_cache_key(&workspace, context.thread_id)?,
                    || async {
                        match &args.selector {
                            ReadOutputSelector::Page { cursor } => context
                                .storage
                                .read_output_for_thread(
                                    context.thread_id.to_string(),
                                    args.output_id.clone(),
                                    cursor.clone(),
                                )
                                .await
                                .map(|response| {
                                    CachedReadOutput::output_page(format!(
                                        "output_id: {}\nnext_cursor: {}\nchunk:\n{}",
                                        response.output_id,
                                        response.next_cursor.as_deref().unwrap_or("null"),
                                        response.chunk
                                    ))
                                }),
                            ReadOutputSelector::Search { query } => context
                                .storage
                                .search_output_for_thread(
                                    context.thread_id.to_string(),
                                    args.output_id.clone(),
                                    query.clone(),
                                )
                                .await
                                .map(|response| {
                                    CachedReadOutput::text(
                                        response.render(),
                                        TextOutputKind::SearchOutput,
                                    )
                                }),
                        }
                    },
                )
                .await
                .map(|output| ToolResult::StoredOutput(output.into_stored_output())),
            ToolOperation::EditFile(args) => {
                require_workspace_write(context.permissions)?;
                edit_file(&workspace, args)
                    .await
                    .map(ToolResult::MutationConfirmation)
            }
            ToolOperation::WriteFile(args) => {
                require_workspace_write(context.permissions)?;
                write_file(&workspace, args)
                    .await
                    .map(ToolResult::MutationConfirmation)
            }
            ToolOperation::ExecCommand(args) => {
                if context.permissions.sandbox == SandboxMode::ReadOnly {
                    return Err(AppError::Permission(
                        "commands are disabled in read-only mode".into(),
                    ));
                }
                if context.permissions.sandbox == SandboxMode::WorkspaceWrite {
                    let cwd = resolve_existing_directory(&workspace, &args.cwd).await?;
                    let decision = context
                        .approvals
                        .request_command(
                            context.app,
                            CommandApprovalRequest {
                                thread_id: context.thread_id.into(),
                                turn_id: context.turn_id.into(),
                                item_id: self.item_id.clone(),
                                command: args.command.clone(),
                                cwd: cwd.display().to_string(),
                                reason: args.reason.clone(),
                            },
                            cancellation,
                        )
                        .await?;
                    match decision {
                        ApprovalDecision::Accept => {}
                        ApprovalDecision::Decline => {
                            let output = "The user declined this command.".to_string();
                            return Ok(self.result_with_output(
                                &workspace,
                                ActivityStatus::Declined,
                                output,
                                None,
                                Some(elapsed_millis(started_at)?),
                            ));
                        }
                        ApprovalDecision::Cancel => {
                            return Err(AppError::Cancelled(
                                "the user canceled the turn while reviewing a command".into(),
                            ));
                        }
                    }
                }
                match context
                    .command_sessions
                    .start(
                        context.engine.clone(),
                        Some(context.app.clone()),
                        workspace.clone(),
                        args.clone(),
                        context.ripgrep.clone(),
                        Some(context.stream_deltas.clone()),
                        self.item_id.clone(),
                        context.thread_id.into(),
                        context.turn_id.into(),
                        self.started_at_ms(),
                        command_yield_time(args)?,
                        cancellation,
                    )
                    .await?
                {
                    CommandStartOutcome::Completed(output) => {
                        Ok(ToolResult::StoredOutput(StoredToolOutput::Command(output)))
                    }
                    CommandStartOutcome::Running(session) => {
                        Ok(ToolResult::BackgroundCommand(session))
                    }
                }
            }
            ToolOperation::PollCommand(args) => context
                .command_sessions
                .poll(
                    context.thread_id,
                    &args.session_id,
                    args.cursor,
                    Duration::from_secs(u64::from(args.wait_seconds)),
                )
                .await
                .map(|output| ToolResult::StoredOutput(StoredToolOutput::OutputPage(output))),
            ToolOperation::UpdatePlan { .. } => {
                return Err(AppError::Tool(
                    "update_plan must complete before filesystem tool execution".into(),
                ));
            }
        };

        match execution {
            Ok(ToolResult::Browser(output)) => {
                let duration = elapsed_millis(started_at)?;
                let visual_context = match (output.visual_image_url, output.visual_description) {
                    (Some(image_url), Some(description)) => Some(ToolVisualContext {
                        image_url,
                        description,
                    }),
                    (None, None) => None,
                    _ => {
                        return Err(AppError::State(
                            "browser visual result is incomplete".into(),
                        ));
                    }
                };
                Ok(ToolExecutionResult {
                    provider_output: output.provider_output,
                    completed_item: self.finish_item(
                        &workspace,
                        output.status,
                        None,
                        Some(duration),
                    ),
                    display_output: output.display_output.map(OutputSource::text),
                    background_command: None,
                    visual_context,
                })
            }
            Ok(ToolResult::BackgroundCommand(session)) => {
                let ToolOperation::ExecCommand(args) = &self.operation else {
                    return Err(AppError::State(
                        "background command result escaped a non-command tool".into(),
                    ));
                };
                let session_id = session.lease.session_id().to_owned();
                Ok(ToolExecutionResult {
                    provider_output: session.provider_output,
                    completed_item: ThreadItem::CommandExecution {
                        id: self.item_id.clone(),
                        command: args.command.clone(),
                        cwd: display_workspace_path(&workspace, &args.cwd),
                        process_id: Some(session_id),
                        started_at: Some(self.started_at_ms()),
                        source: CommandSource::Agent,
                        status: ActivityStatus::InProgress,
                        aggregated_output: None,
                        live_output: Some(session.live_output),
                        exit_code: None,
                        duration_ms: None,
                    },
                    display_output: None,
                    background_command: Some(session.lease),
                    visual_context: None,
                })
            }
            Ok(ToolResult::Patch(outcome)) => Ok(ToolExecutionResult {
                provider_output: outcome.output,
                completed_item: ThreadItem::FileChange {
                    id: self.item_id.clone(),
                    changes: outcome.changes,
                    status: ActivityStatus::Completed,
                },
                display_output: None,
                background_command: None,
                visual_context: None,
            }),
            Ok(ToolResult::MutationConfirmation(provider_output)) => {
                self.complete_mutation_confirmation(&workspace, started_at, provider_output)
            }
            Ok(ToolResult::StoredOutput(output)) => {
                self.complete_stored_output(&workspace, started_at, output)
                    .await
            }
            Err(error) => Err(error),
        }
    }

    fn complete_mutation_confirmation(
        &self,
        workspace: &Path,
        started_at: Instant,
        provider_output: String,
    ) -> Result<ToolExecutionResult, AppError> {
        let duration = elapsed_millis(started_at)?;
        Ok(ToolExecutionResult {
            provider_output,
            completed_item: self.finish_item(
                workspace,
                ActivityStatus::Completed,
                None,
                Some(duration),
            ),
            display_output: None,
            background_command: None,
            visual_context: None,
        })
    }

    async fn complete_stored_output(
        &self,
        workspace: &Path,
        started_at: Instant,
        output: StoredToolOutput,
    ) -> Result<ToolExecutionResult, AppError> {
        let output = output.into_output().await?;
        let duration = elapsed_millis(started_at)?;
        let completed_item =
            self.finish_item(workspace, output.status, output.exit_code, Some(duration));
        Ok(ToolExecutionResult {
            provider_output: output.provider_output,
            completed_item,
            display_output: Some(output.source),
            background_command: None,
            visual_context: None,
        })
    }

    fn finish_item(
        &self,
        workspace: &Path,
        status: ActivityStatus,
        exit_code: Option<i32>,
        duration_ms: Option<u64>,
    ) -> ThreadItem {
        self.build_item(
            workspace,
            ThreadItemParams {
                status,
                live_output: None,
                process_id: None,
                exit_code,
                duration_ms,
            },
        )
    }

    fn build_item(&self, workspace: &Path, params: ThreadItemParams) -> ThreadItem {
        match &self.operation {
            ToolOperation::ApplyPatch(patch) => ThreadItem::FileChange {
                id: self.item_id.clone(),
                changes: preview_changes(patch),
                status: params.status,
            },
            ToolOperation::ExecCommand(args) => ThreadItem::CommandExecution {
                id: self.item_id.clone(),
                command: args.command.clone(),
                cwd: display_workspace_path(workspace, &args.cwd),
                process_id: params.process_id,
                started_at: Some(self.started_at_ms()),
                source: CommandSource::Agent,
                status: params.status,
                aggregated_output: None,
                live_output: params.live_output,
                exit_code: params.exit_code,
                duration_ms: params.duration_ms,
            },
            ToolOperation::EditFile(args) => ThreadItem::FileChange {
                id: self.item_id.clone(),
                changes: vec![FileChange {
                    path: args.path.clone(),
                    kind: FileChangeKind::Update { move_path: None },
                    diff: diff_preview(&args.old_text, &args.new_text),
                    line_stats: Some(line_stats(&args.old_text, &args.new_text)),
                }],
                status: params.status,
            },
            ToolOperation::WriteFile(args) => ThreadItem::FileChange {
                id: self.item_id.clone(),
                changes: vec![FileChange {
                    path: args.path.clone(),
                    kind: if args.overwrite {
                        FileChangeKind::Update { move_path: None }
                    } else {
                        FileChangeKind::Add
                    },
                    diff: diff_preview("", &args.content),
                    line_stats: Some(line_stats("", &args.content)),
                }],
                status: params.status,
            },
            ToolOperation::UpdatePlan { explanation, steps } => ThreadItem::Plan {
                id: self.item_id.clone(),
                explanation: explanation.clone(),
                steps: steps.clone(),
            },
            _ => ThreadItem::ToolExecution {
                id: self.item_id.clone(),
                name: self.name.into(),
                description: self.description.clone(),
                status: params.status,
                output_presentation: self.output_presentation(),
                output: None,
            },
        }
    }

    fn result_with_output(
        &self,
        workspace: &Path,
        status: ActivityStatus,
        output: String,
        exit_code: Option<i32>,
        duration_ms: Option<u64>,
    ) -> ToolExecutionResult {
        let display_output = self
            .can_own_stored_output()
            .then(|| OutputSource::text(output.clone()));
        ToolExecutionResult {
            provider_output: display_output
                .as_ref()
                .map_or_else(|| output.clone(), OutputSource::provider_output),
            completed_item: self.finish_item(workspace, status, exit_code, duration_ms),
            display_output,
            background_command: None,
            visual_context: None,
        }
    }

    fn started_at_ms(&self) -> i64 {
        *self
            .started_at_ms
            .get_or_init(|| chrono::Utc::now().timestamp_millis())
    }

    fn can_own_stored_output(&self) -> bool {
        matches!(
            &self.operation,
            ToolOperation::ReadFile(_)
                | ToolOperation::ListFiles(_)
                | ToolOperation::SearchText(_)
                | ToolOperation::ReadOutput(_)
                | ToolOperation::PollCommand(_)
                | ToolOperation::ExecCommand(_)
        )
    }
}

enum ToolResult {
    BackgroundCommand(BackgroundCommandStart),
    Browser(browser::BrowserToolExecution),
    StoredOutput(StoredToolOutput),
    MutationConfirmation(String),
    Patch(PatchOutcome),
}

enum StoredToolOutput {
    Text {
        output: String,
        kind: TextOutputKind,
    },
    OutputPage(String),
    Command(CommandOutput),
}

struct CompletedStoredOutput {
    source: OutputSource,
    provider_output: String,
    exit_code: Option<i32>,
    status: ActivityStatus,
}

impl StoredToolOutput {
    async fn into_output(self) -> Result<CompletedStoredOutput, AppError> {
        match self {
            Self::Text { output, kind } => {
                let compacted = compact_text(&output, kind);
                let source = OutputSource::text(output);
                let provider_output =
                    source.provider_output_with_preview(&compacted.text, compacted.complete);
                Ok(CompletedStoredOutput {
                    source,
                    provider_output,
                    exit_code: None,
                    status: ActivityStatus::Completed,
                })
            }
            Self::OutputPage(output) => {
                let provider_output = output.clone();
                Ok(CompletedStoredOutput {
                    source: OutputSource::text(output),
                    provider_output,
                    exit_code: None,
                    status: ActivityStatus::Completed,
                })
            }
            Self::Command(output) => {
                let exit_code = output.exit_code();
                let status = if output.failed() {
                    ActivityStatus::Failed
                } else {
                    activity_status_for_exit_code(exit_code)
                };
                let header = output.resource_header();
                let failure_message = output.failure_message();
                let (source, provider_output) = tokio::task::spawn_blocking(move || {
                    let mut stdout = output.stdout;
                    let mut stderr = output.stderr;
                    let compacted =
                        compact_command_output(exit_code.unwrap_or(-1), &mut stdout, &mut stderr)?;
                    let source = OutputSource::command(&header, stdout, stderr)?;
                    let mut provider_output =
                        source.provider_output_with_preview(&compacted.text, compacted.complete);
                    if let Some(message) = failure_message {
                        provider_output = format!("{message}\n\n{provider_output}");
                    }
                    Ok::<_, std::io::Error>((source, provider_output))
                })
                .await
                .map_err(|error| AppError::Tool(format!("output spool task failed: {error}")))?
                .map_err(|error| AppError::Tool(format!("could not assemble output: {error}")))?;
                Ok(CompletedStoredOutput {
                    source,
                    provider_output,
                    exit_code,
                    status,
                })
            }
        }
    }
}

async fn execute_patch_operation(
    workspace: &Path,
    patch: ParsedPatch,
    permissions: PermissionProfile,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<PatchOutcome, AppError> {
    require_workspace_write(permissions)?;
    let prepared = prepare_patch(workspace, patch).await?;
    commit_patch(prepared, cancellation).await
}
fn require_workspace_write(permissions: PermissionProfile) -> Result<(), AppError> {
    if permissions.sandbox == SandboxMode::ReadOnly {
        Err(AppError::Permission(
            "file changes are disabled in read-only mode".into(),
        ))
    } else {
        Ok(())
    }
}

fn function_tool(name: &'static str, description: &'static str, parameters: Value) -> Value {
    json!({
        "type": "function",
        "name": name,
        "description": description,
        "strict": true,
        "parameters": parameters
    })
}

fn decode_arguments<T: for<'de> Deserialize<'de>>(
    name: &str,
    arguments: &str,
) -> Result<T, AppError> {
    serde_json::from_str(arguments)
        .map_err(|error| AppError::Tool(format!("invalid `{name}` arguments: {error}")))
}

fn normalize_read_output_args(raw: RawReadOutputArgs) -> Result<ReadOutputArgs, AppError> {
    let selector = match raw.query {
        Some(query) => {
            if raw.cursor.is_some() {
                return Err(AppError::Tool(
                    "read_output cursor must be null when query is provided".into(),
                ));
            }
            if query.trim().is_empty() || query.len() > MAX_OUTPUT_SEARCH_QUERY_BYTES {
                return Err(AppError::Tool(format!(
                    "read_output query must contain between 1 and {MAX_OUTPUT_SEARCH_QUERY_BYTES} bytes"
                )));
            }
            if query.chars().any(char::is_control) {
                return Err(AppError::Tool(
                    "read_output query cannot contain control characters".into(),
                ));
            }
            ReadOutputSelector::Search { query }
        }
        None => ReadOutputSelector::Page { cursor: raw.cursor },
    };
    Ok(ReadOutputArgs {
        output_id: raw.output_id,
        selector,
    })
}

fn normalize_plan(args: UpdatePlanArgs) -> Result<(Option<String>, Vec<PlanStep>), AppError> {
    if args.plan.is_empty() || args.plan.len() > MAX_PLAN_STEPS {
        return Err(AppError::Tool(format!(
            "plan must contain between 1 and {MAX_PLAN_STEPS} steps"
        )));
    }

    let explanation = match args.explanation {
        Some(value) => {
            let value = value.trim().to_string();
            if value.len() > MAX_PLAN_EXPLANATION_BYTES {
                return Err(AppError::Tool(format!(
                    "plan explanation exceeds {MAX_PLAN_EXPLANATION_BYTES} bytes"
                )));
            }
            (!value.is_empty()).then_some(value)
        }
        None => None,
    };

    let mut in_progress = 0usize;
    let mut steps = Vec::with_capacity(args.plan.len());
    for (index, candidate) in args.plan.into_iter().enumerate() {
        let step = candidate.step.trim().to_string();
        if step.is_empty() || step.len() > MAX_PLAN_STEP_BYTES {
            return Err(AppError::Tool(format!(
                "plan step {} must contain between 1 and {MAX_PLAN_STEP_BYTES} bytes",
                index + 1
            )));
        }
        let normalized_step = step.to_lowercase();
        if steps
            .iter()
            .any(|existing: &PlanStep| existing.step.to_lowercase() == normalized_step)
        {
            return Err(AppError::Tool(format!(
                "plan step {} duplicates an earlier step",
                index + 1
            )));
        }
        let status = match candidate.status {
            UpdatePlanStatus::Pending => PlanStepStatus::Pending,
            UpdatePlanStatus::InProgress => {
                in_progress += 1;
                PlanStepStatus::InProgress
            }
            UpdatePlanStatus::Completed => PlanStepStatus::Completed,
        };
        steps.push(PlanStep { step, status });
    }
    if in_progress > 1 {
        return Err(AppError::Tool(
            "plan must not contain more than one in-progress step".into(),
        ));
    }
    Ok((explanation, steps))
}

fn validate_identifier(label: &str, value: &str) -> Result<(), AppError> {
    if crate::command_validation::identifier_is_valid(value) {
        Ok(())
    } else {
        Err(AppError::Tool(format!("{label} is invalid")))
    }
}

fn diff_preview(old: &str, new: &str) -> String {
    render_replacement_diff("before", "after", old, new)
}

fn elapsed_millis(started_at: Instant) -> Result<u64, AppError> {
    u64::try_from(started_at.elapsed().as_millis())
        .map_err(|error| AppError::Tool(format!("duration overflow: {error}")))
}

fn activity_status_for_exit_code(exit_code: Option<i32>) -> ActivityStatus {
    if exit_code.is_some_and(|code| code != 0) {
        ActivityStatus::Failed
    } else {
        ActivityStatus::Completed
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::io::Write as _;
    use std::path::Path;
    use std::time::Instant;

    use serde_json::Value;
    use tempfile::TempDir;
    use tokio::sync::watch;

    use crate::engine::{ActivityStatus, PermissionProfile, PlanStepStatus, ThreadItem};
    use crate::error::AppError;

    use super::super::output_compaction::TextOutputKind;
    use super::exec::CommandTermination;
    use super::fs::{atomic_write, edit_file, write_file};
    use super::workspace::resolve_write_target;
    use super::{
        CommandOutput, EditFileArgs, MAX_COMMAND_POLL_WAIT_SECONDS, MAX_COMMAND_TIMEOUT_SECONDS,
        ReadOutputArgs, ReadOutputSelector, Ripgrep, SearchTextArgs, StoredToolOutput,
        ToolOperation, ToolRegistry, WriteFileArgs, activity_status_for_exit_code,
        execute_patch_operation, search_text,
    };

    #[test]
    #[ignore = "performance benchmark"]
    fn benchmark_tool_catalog_token_budget() {
        let mut samples = Vec::with_capacity(101);
        let mut encoded = Vec::new();
        for _ in 0..101 {
            let started = Instant::now();
            let definitions = ToolRegistry.definitions();
            encoded = serde_json::to_vec(&definitions).expect("tool catalog should encode");
            std::hint::black_box(&encoded);
            samples.push(started.elapsed().as_secs_f64() * 1_000.0);
        }
        samples.sort_by(f64::total_cmp);
        let definitions = ToolRegistry.definitions();
        let read_only_definitions = ToolRegistry.definitions_for(PermissionProfile::read_only());
        let read_only_encoded =
            serde_json::to_vec(read_only_definitions).expect("read-only catalog should encode");
        let by_tool = definitions
            .iter()
            .map(|definition| {
                let bytes = serde_json::to_vec(definition)
                    .expect("tool definition should encode")
                    .len();
                serde_json::json!({
                    "bytes": bytes,
                    "estimatedTokens": bytes.div_ceil(4),
                    "name": definition["name"],
                })
            })
            .collect::<Vec<_>>();
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "definitions": definitions.len(),
                "encodedBytes": encoded.len(),
                "estimatedTokens": encoded.len().div_ceil(4),
                "buildAndEncodeMedianMs": samples[samples.len() / 2],
                "byTool": by_tool,
                "readOnly": {
                    "definitions": read_only_definitions.len(),
                    "encodedBytes": read_only_encoded.len(),
                    "estimatedTokens": read_only_encoded.len().div_ceil(4),
                    "tokenReductionPercent":
                        (1.0 - read_only_encoded.len() as f64 / encoded.len() as f64) * 100.0,
                },
                "samples": samples.len(),
            }))
            .expect("benchmark result should encode")
        );
    }

    #[test]
    fn read_only_catalog_does_not_advertise_impossible_mutations_or_commands() {
        let names = ToolRegistry
            .definitions_for(PermissionProfile::read_only())
            .iter()
            .filter_map(|definition| definition["name"].as_str())
            .collect::<BTreeSet<_>>();

        assert_eq!(
            names,
            BTreeSet::from([
                "browser_key",
                "browser_manage",
                "browser_metrics",
                "browser_pointer",
                "browser_snapshot",
                "browser_type",
                "browser_wait",
                "list_files",
                "poll_command",
                "read_file",
                "read_output",
                "search_text",
                "update_plan",
            ])
        );
    }

    #[test]
    fn command_exit_code_controls_the_visual_activity_status() {
        assert!(matches!(
            activity_status_for_exit_code(Some(1)),
            ActivityStatus::Failed
        ));
        assert!(matches!(
            activity_status_for_exit_code(Some(0)),
            ActivityStatus::Completed
        ));
        assert!(matches!(
            activity_status_for_exit_code(None),
            ActivityStatus::Completed
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn command_termination_preserves_spools_and_status() {
        for (termination, expected_header, expected_status, expected_exit_code) in [
            (
                CommandTermination::Exited(0),
                "exit_code: 0",
                ActivityStatus::Completed,
                Some(0),
            ),
            (
                CommandTermination::Exited(17),
                "exit_code: 17",
                ActivityStatus::Failed,
                Some(17),
            ),
            (
                CommandTermination::Cancelled,
                "status: cancelled",
                ActivityStatus::Failed,
                None,
            ),
            (
                CommandTermination::TimedOut {
                    timeout_seconds: 60,
                },
                "status: timed_out\ntimeout_seconds: 60",
                ActivityStatus::Failed,
                None,
            ),
        ] {
            let mut stdout = tempfile::tempfile().expect("stdout spool should exist");
            let mut stderr = tempfile::tempfile().expect("stderr spool should exist");
            stdout
                .write_all(b"stdout-tail")
                .expect("stdout should write");
            stderr
                .write_all(b"stderr-tail")
                .expect("stderr should write");

            let output = StoredToolOutput::Command(CommandOutput {
                termination,
                stdout,
                stderr,
            })
            .into_output()
            .await
            .expect("command output should assemble");

            assert_eq!(output.exit_code, expected_exit_code);
            assert_eq!(output.status, expected_status);
            assert!(
                output
                    .source
                    .reference()
                    .preview
                    .starts_with(expected_header)
            );
            assert!(output.source.reference().preview.contains("stdout-tail"));
            assert!(output.source.reference().preview.contains("stderr-tail"));
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn externalizes_tool_output_instead_of_rejecting_it() {
        let output = "x".repeat(2 * 1_048_576);

        let output = StoredToolOutput::Text {
            output: output.clone(),
            kind: TextOutputKind::ReadFile,
        }
        .into_output()
        .await
        .expect("large tool output should remain available as a resource");

        assert_eq!(output.source.reference().byte_length, 2 * 1_048_576);
        assert!(
            output
                .provider_output
                .contains(&output.source.reference().id)
        );
        assert!(output.provider_output.len() < 12 * 1_024);
        assert_eq!(output.exit_code, None);
        assert!(matches!(output.status, ActivityStatus::Completed));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn returns_a_requested_output_page_directly_to_the_provider() {
        let output_page = format!(
            "output_id: output-1\nnext_cursor: 2\nchunk:\n{}",
            "x".repeat(64 * 1_024)
        );

        let output = StoredToolOutput::OutputPage(output_page.clone())
            .into_output()
            .await
            .expect("an output page should remain directly readable");

        assert_eq!(output.provider_output, output_page);
        assert!(output.source.reference().next_cursor.is_some());
        assert_eq!(output.exit_code, None);
        assert!(matches!(output.status, ActivityStatus::Completed));
    }

    #[test]
    fn apply_patch_tool_definition_is_freeform_and_grammar_constrained() {
        let tool = ToolRegistry
            .definitions()
            .iter()
            .find(|tool| tool["name"] == "apply_patch")
            .expect("apply_patch should be advertised");

        assert_eq!(tool["type"], "custom");
        assert_eq!(tool["name"], "apply_patch");
        assert!(
            tool["description"]
                .as_str()
                .is_some_and(|description| description.contains("`@@` opens a change block"))
        );
        assert!(
            tool["description"]
                .as_str()
                .is_some_and(|description| description.contains("Never emit a trailing"))
        );
        assert_eq!(tool["format"]["type"], "grammar");
        assert_eq!(tool["format"]["syntax"], "lark");
        assert_eq!(
            tool["format"]["definition"],
            include_str!("../apply_patch/apply_patch.lark")
        );
    }

    #[test]
    fn tool_arguments_are_closed_and_unknown_tools_fail() {
        let registry = ToolRegistry;
        assert!(
            registry
                .prepare(
                    "call-1".into(),
                    "read_file",
                    r#"{"path":"a","start_line":1,"end_line":1,"future":true}"#,
                )
                .is_err()
        );
        assert!(
            registry
                .prepare("call-2".into(), "future_tool", "{}")
                .is_err()
        );
    }

    #[test]
    fn stored_output_retrieval_selects_search_or_raw_paging_explicitly() {
        let registry = ToolRegistry;
        let page = registry
            .prepare(
                "output-page".into(),
                "read_output",
                r#"{"output_id":"output-1","cursor":null,"query":null}"#,
            )
            .expect("raw output paging should prepare");
        let search = registry
            .prepare(
                "output-search".into(),
                "read_output",
                r#"{"output_id":"output-1","cursor":null,"query":"error"}"#,
            )
            .expect("targeted output search should prepare");

        assert!(matches!(
            page.operation,
            ToolOperation::ReadOutput(ReadOutputArgs {
                selector: ReadOutputSelector::Page { cursor: None },
                ..
            })
        ));
        assert!(matches!(
            search.operation,
            ToolOperation::ReadOutput(ReadOutputArgs {
                selector: ReadOutputSelector::Search { ref query },
                ..
            }) if query == "error"
        ));
        assert!(
            registry
                .prepare(
                    "output-invalid".into(),
                    "read_output",
                    r#"{"output_id":"output-1","cursor":"2","query":"error"}"#,
                )
                .is_err()
        );
    }

    #[test]
    fn parallel_execution_requires_an_explicitly_safe_operation_and_profile() {
        let registry = ToolRegistry;
        let read = registry
            .prepare(
                "read-1".into(),
                "read_file",
                r#"{"path":"a","start_line":1,"end_line":1}"#,
            )
            .expect("read_file should prepare");
        let search = registry
            .prepare(
                "search-1".into(),
                "search_text",
                r#"{"path":".","query":"needle","case_sensitive":true}"#,
            )
            .expect("search_text should prepare");
        let command = registry
            .prepare(
                "command-1".into(),
                "exec_command",
                r#"{"command":"Get-Date","cwd":".","reason":"test","parallel_safe":true,"yield_time_ms":null,"timeout_seconds":null}"#,
            )
            .expect("exec_command should prepare");
        let exclusive_command = registry
            .prepare(
                "command-2".into(),
                "exec_command",
                r#"{"command":"Get-Date","cwd":".","reason":"test","parallel_safe":false,"yield_time_ms":null,"timeout_seconds":null}"#,
            )
            .expect("exclusive exec_command should prepare");
        let poll = registry
            .prepare(
                "poll-1".into(),
                "poll_command",
                r#"{"session_id":"019d-session","cursor":null,"wait_seconds":5}"#,
            )
            .expect("poll_command should prepare");

        for permissions in [
            PermissionProfile::read_only(),
            PermissionProfile::workspace_write(),
            PermissionProfile::full_access(),
        ] {
            assert!(read.supports_parallel_execution(permissions));
            assert!(search.supports_parallel_execution(permissions));
            assert!(poll.supports_parallel_execution(permissions));
        }
        assert!(command.supports_parallel_execution(PermissionProfile::full_access()));
        assert!(!command.supports_parallel_execution(PermissionProfile::workspace_write()));
        assert!(!command.supports_parallel_execution(PermissionProfile::read_only()));
        assert!(!exclusive_command.supports_parallel_execution(PermissionProfile::full_access()));
    }

    #[test]
    fn command_timeout_can_cover_long_running_autonomous_work() {
        let registry = ToolRegistry;
        let extended = format!(
            r#"{{"command":"Get-Date","cwd":".","reason":"test","parallel_safe":false,"yield_time_ms":null,"timeout_seconds":{MAX_COMMAND_TIMEOUT_SECONDS}}}"#
        );
        registry
            .prepare("command-long".into(), "exec_command", &extended)
            .expect("the seven-day command timeout should prepare");

        let excessive = format!(
            r#"{{"command":"Get-Date","cwd":".","reason":"test","parallel_safe":false,"yield_time_ms":null,"timeout_seconds":{}}}"#,
            MAX_COMMAND_TIMEOUT_SECONDS + 1
        );
        assert!(
            registry
                .prepare("command-too-long".into(), "exec_command", &excessive)
                .is_err()
        );
    }

    #[test]
    fn poll_command_schema_is_bounded_and_strict() {
        let definition = ToolRegistry
            .definitions()
            .iter()
            .find(|tool| tool["name"] == "poll_command")
            .expect("poll_command should be advertised");
        let parameters = &definition["parameters"];

        assert_eq!(
            parameters["required"],
            serde_json::json!(["session_id", "cursor", "wait_seconds"])
        );
        assert_eq!(parameters["properties"]["cursor"]["minimum"], 0);
        assert_eq!(
            parameters["properties"]["wait_seconds"]["maximum"],
            MAX_COMMAND_POLL_WAIT_SECONDS
        );
        ToolRegistry
            .prepare(
                "poll-valid".into(),
                "poll_command",
                r#"{"session_id":"019d-session","cursor":3,"wait_seconds":0}"#,
            )
            .expect("an immediate poll should prepare");
        assert!(
            ToolRegistry
                .prepare(
                    "poll-too-long".into(),
                    "poll_command",
                    r#"{"session_id":"019d-session","cursor":null,"wait_seconds":301}"#,
                )
                .is_err()
        );
    }

    #[test]
    fn exec_command_schema_is_explicit_and_strict() {
        let definition = ToolRegistry
            .definitions()
            .iter()
            .find(|tool| tool["name"] == "exec_command")
            .expect("exec_command should be advertised");
        let parameters = &definition["parameters"];

        assert_eq!(
            parameters["required"],
            serde_json::json!([
                "command",
                "cwd",
                "reason",
                "parallel_safe",
                "yield_time_ms",
                "timeout_seconds"
            ])
        );
        assert_eq!(
            parameters["properties"]
                .as_object()
                .expect("exec command properties should be an object")
                .keys()
                .map(String::as_str)
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([
                "command",
                "cwd",
                "parallel_safe",
                "reason",
                "timeout_seconds",
                "yield_time_ms",
            ])
        );
        assert_eq!(parameters["properties"]["parallel_safe"]["type"], "boolean");
        assert!(
            parameters["properties"]["parallel_safe"]["description"]
                .as_str()
                .is_some_and(|description| {
                    description.contains("independent")
                        && description.contains("does not mutate shared files")
                        && description.contains("permission profile")
                })
        );
        assert_eq!(
            parameters["properties"]["yield_time_ms"]["type"],
            serde_json::json!(["integer", "null"])
        );
        assert!(
            parameters["properties"]["yield_time_ms"]["description"]
                .as_str()
                .is_some_and(|description| {
                    description.contains("foreground wait")
                        && description.contains("session_id")
                        && description.contains("10000 ms default")
                })
        );
        assert_eq!(
            parameters["properties"]["timeout_seconds"]["type"],
            serde_json::json!(["integer", "null"])
        );
        assert!(
            parameters["properties"]["timeout_seconds"]["description"]
                .as_str()
                .is_some_and(|description| {
                    description.contains("expected worst-case duration")
                        && description.contains("safe one-hour default")
                })
        );

        ToolRegistry
            .prepare(
                "command-default-timeout".into(),
                "exec_command",
                r#"{"command":"Get-Date","cwd":".","reason":"test","parallel_safe":false,"yield_time_ms":null,"timeout_seconds":null}"#,
            )
            .expect("a null timeout should use the default");
    }

    #[test]
    fn strict_function_schemas_require_every_declared_property() {
        for definition in ToolRegistry
            .definitions()
            .iter()
            .filter(|tool| tool["type"] == "function")
        {
            let name = definition["name"]
                .as_str()
                .expect("function tools should have names");
            assert_eq!(definition["strict"], true, "{name} must use strict mode");
            assert_strict_object_schema(&definition["parameters"], name);
            assert_provider_schema_keywords(&definition["parameters"], name);
        }
    }

    fn assert_provider_schema_keywords(schema: &Value, context: &str) {
        let Some(schema) = schema.as_object() else {
            return;
        };
        for keyword in schema.keys() {
            assert!(
                matches!(
                    keyword.as_str(),
                    "$defs"
                        | "$ref"
                        | "additionalProperties"
                        | "anyOf"
                        | "description"
                        | "enum"
                        | "exclusiveMaximum"
                        | "exclusiveMinimum"
                        | "format"
                        | "items"
                        | "maxItems"
                        | "maxLength"
                        | "maximum"
                        | "minItems"
                        | "minLength"
                        | "minimum"
                        | "multipleOf"
                        | "pattern"
                        | "properties"
                        | "required"
                        | "type"
                ),
                "{context} uses unsupported strict-schema keyword {keyword}"
            );
        }
        if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
            for (name, property) in properties {
                assert_provider_schema_keywords(property, &format!("{context}.{name}"));
            }
        }
        if let Some(items) = schema.get("items") {
            assert_provider_schema_keywords(items, &format!("{context}[]"));
        }
        if let Some(definitions) = schema.get("$defs").and_then(Value::as_object) {
            for (name, definition) in definitions {
                assert_provider_schema_keywords(definition, &format!("{context}.$defs.{name}"));
            }
        }
        if let Some(branches) = schema.get("anyOf").and_then(Value::as_array) {
            for (index, branch) in branches.iter().enumerate() {
                assert_provider_schema_keywords(branch, &format!("{context}.anyOf[{index}]"));
            }
        }
    }

    fn assert_strict_object_schema(schema: &Value, context: &str) {
        let Some(schema) = schema.as_object() else {
            return;
        };
        if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
            assert_eq!(
                schema.get("additionalProperties"),
                Some(&Value::Bool(false)),
                "{context} must reject undeclared properties"
            );
            let required = schema
                .get("required")
                .and_then(Value::as_array)
                .unwrap_or_else(|| panic!("{context} must declare required properties"));
            let required_names = required
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .unwrap_or_else(|| panic!("{context}.required must contain strings"))
                })
                .collect::<BTreeSet<_>>();
            let property_names = properties
                .keys()
                .map(String::as_str)
                .collect::<BTreeSet<_>>();
            assert_eq!(
                required_names, property_names,
                "{context}.required must contain every declared property"
            );

            for (name, property) in properties {
                assert_strict_object_schema(property, &format!("{context}.{name}"));
            }
        }
        if let Some(items) = schema.get("items") {
            assert_strict_object_schema(items, &format!("{context}[]"));
        }
        for keyword in ["allOf", "anyOf", "oneOf"] {
            if let Some(branches) = schema.get(keyword).and_then(Value::as_array) {
                for (index, branch) in branches.iter().enumerate() {
                    assert_strict_object_schema(branch, &format!("{context}.{keyword}[{index}]"));
                }
            }
        }
    }

    #[test]
    fn failed_file_mutations_preserve_the_error_without_storing_output() {
        let registry = ToolRegistry;
        let patch = registry
            .prepare_custom(
                "patch-failure".into(),
                "apply_patch",
                "*** Begin Patch\n*** Add File: new.txt\n+content\n*** End Patch",
            )
            .expect("patch should prepare");
        let edit = registry
            .prepare(
                "edit-failure".into(),
                "edit_file",
                r#"{"path":"source.txt","old_text":"old","new_text":"new","expected_occurrences":1}"#,
            )
            .expect("edit should prepare");
        let write = registry
            .prepare(
                "write-failure".into(),
                "write_file",
                r#"{"path":"source.txt","content":"new","overwrite":true}"#,
            )
            .expect("write should prepare");
        let error = AppError::FileSystem("the target is unavailable".into());

        for prepared in [patch, edit, write] {
            let result = prepared.failed_result(Path::new("C:\\workspace"), &error);
            assert!(result.display_output.is_none());
            assert!(result.provider_output.contains("target is unavailable"));
            assert!(matches!(
                result.completed_item,
                ThreadItem::FileChange {
                    status: ActivityStatus::Failed,
                    ..
                }
            ));
        }
    }

    #[test]
    fn successful_file_mutations_do_not_create_stored_output_resources() {
        let registry = ToolRegistry;
        let edit = registry
            .prepare(
                "edit-success".into(),
                "edit_file",
                r#"{"path":"source.txt","old_text":"old","new_text":"new","expected_occurrences":1}"#,
            )
            .expect("edit should prepare");
        let write = registry
            .prepare(
                "write-success".into(),
                "write_file",
                r#"{"path":"source.txt","content":"new","overwrite":true}"#,
            )
            .expect("write should prepare");

        for prepared in [edit, write] {
            let result = prepared
                .complete_mutation_confirmation(
                    Path::new("C:\\workspace"),
                    std::time::Instant::now(),
                    "File changed.".into(),
                )
                .expect("mutation confirmation should complete");

            assert_eq!(result.provider_output, "File changed.");
            assert!(result.display_output.is_none());
            assert!(matches!(
                result.completed_item,
                ThreadItem::FileChange {
                    status: ActivityStatus::Completed,
                    ..
                }
            ));
        }
    }

    #[test]
    fn update_plan_is_validated_and_exposed_as_structured_state() {
        let registry = ToolRegistry;
        let definition = registry
            .definitions()
            .iter()
            .find(|tool| tool["name"] == "update_plan")
            .expect("update_plan should be advertised");
        assert_eq!(definition["strict"], true);
        assert_eq!(definition["parameters"]["additionalProperties"], false);

        let prepared = registry
            .prepare(
                "plan-1".into(),
                "update_plan",
                r#"{"explanation":"Implementação iniciada","plan":[{"step":"Mapear o fluxo","status":"completed"},{"step":"Corrigir o estado","status":"in_progress"},{"step":"Validar","status":"pending"}]}"#,
            )
            .expect("valid plan should prepare");

        assert!(matches!(
            prepared.started_item(std::path::Path::new("C:\\workspace")),
            ThreadItem::Plan { explanation: Some(explanation), steps, .. }
                if explanation == "Implementação iniciada"
                    && steps.len() == 3
                    && steps[1].status == PlanStepStatus::InProgress
        ));
    }

    #[test]
    fn update_plan_rejects_ambiguous_or_empty_progress() {
        let registry = ToolRegistry;
        for (item_id, arguments) in [
            ("plan-empty", r#"{"explanation":null,"plan":[]}"#),
            (
                "plan-multiple",
                r#"{"explanation":null,"plan":[{"step":"Um","status":"in_progress"},{"step":"Dois","status":"in_progress"}]}"#,
            ),
            (
                "plan-duplicate",
                r#"{"explanation":null,"plan":[{"step":"Validar","status":"completed"},{"step":"validar","status":"pending"}]}"#,
            ),
        ] {
            assert!(
                registry
                    .prepare(item_id.into(), "update_plan", arguments)
                    .is_err(),
                "invalid plan {item_id} should fail"
            );
        }
    }

    #[tokio::test]
    async fn search_text_reaches_files_beyond_twelve_directory_levels() {
        let directory = TempDir::new().expect("temporary workspace should exist");
        let workspace = tokio::fs::canonicalize(directory.path())
            .await
            .expect("workspace should canonicalize");
        let mut nested = workspace.clone();
        for depth in 0..16 {
            nested.push(format!("level-{depth:02}"));
        }
        tokio::fs::create_dir_all(&nested)
            .await
            .expect("deep directory should exist");
        tokio::fs::write(nested.join("needle.txt"), "before\nDeep marker\nafter\n")
            .await
            .expect("deep file should exist");
        let ripgrep = Ripgrep::for_project_tests();
        let (_sender, mut cancellation) = watch::channel(false);

        let output = search_text(
            &ripgrep,
            &workspace,
            &SearchTextArgs {
                path: ".".into(),
                query: "deep marker".into(),
                case_sensitive: false,
            },
            &mut cancellation,
        )
        .await
        .expect("directory depth must not prevent a workspace search");

        assert!(output.contains("needle.txt:2:Deep marker"));
    }

    #[tokio::test]
    async fn custom_apply_patch_prepares_previews_and_executes_natively() {
        let workspace = TempDir::new().expect("workspace should exist");
        tokio::fs::write(workspace.path().join("source.txt"), "old\n")
            .await
            .expect("source should exist");
        tokio::fs::write(workspace.path().join("move.txt"), "move\n")
            .await
            .expect("move source should exist");
        let prepared = ToolRegistry
            .prepare_custom(
                "patch-1".into(),
                "apply_patch",
                "*** Begin Patch\n\
*** Add File: added.txt\n\
+added\n\
*** Update File: source.txt\n\
@@\n\
-old\n\
+new\n\
*** Update File: move.txt\n\
*** Move to: moved.txt\n\
*** End Patch",
            )
            .expect("custom patch should prepare");

        assert!(matches!(
            prepared.started_item(workspace.path()),
            ThreadItem::FileChange { changes, status: ActivityStatus::InProgress, .. }
                if changes.len() == 3
        ));
        let ToolOperation::ApplyPatch(patch) = &prepared.operation else {
            panic!("expected apply patch operation");
        };
        let (_sender, mut cancellation) = watch::channel(false);
        let outcome = execute_patch_operation(
            workspace.path(),
            patch.clone(),
            PermissionProfile::workspace_write(),
            &mut cancellation,
        )
        .await
        .expect("native patch should execute");

        assert_eq!(outcome.output, "Applied patch to 3 files.");
        assert_eq!(outcome.changes.len(), 3);
        assert_eq!(
            tokio::fs::read_to_string(workspace.path().join("source.txt"))
                .await
                .expect("source should be updated"),
            "new\n"
        );
        assert_eq!(
            tokio::fs::read_to_string(workspace.path().join("added.txt"))
                .await
                .expect("add should exist"),
            "added\n"
        );
        assert!(!workspace.path().join("move.txt").exists());
        assert!(workspace.path().join("moved.txt").exists());
    }

    #[tokio::test]
    async fn custom_apply_patch_fails_closed_in_read_only_mode() {
        let workspace = TempDir::new().expect("workspace should exist");
        let prepared = ToolRegistry
            .prepare_custom(
                "patch-2".into(),
                "apply_patch",
                "*** Begin Patch\n*** Add File: denied.txt\n+denied\n*** End Patch",
            )
            .expect("structural patch should prepare");
        let ToolOperation::ApplyPatch(patch) = &prepared.operation else {
            panic!("expected apply patch operation");
        };
        let (_sender, mut cancellation) = watch::channel(false);

        let error = execute_patch_operation(
            workspace.path(),
            patch.clone(),
            PermissionProfile::read_only(),
            &mut cancellation,
        )
        .await
        .expect_err("read-only patch should fail");

        assert!(matches!(error, crate::error::AppError::Permission(_)));
        assert!(!workspace.path().join("denied.txt").exists());
    }

    #[test]
    fn custom_apply_patch_rejects_invalid_input_and_unknown_names() {
        let registry = ToolRegistry;
        assert!(
            registry
                .prepare_custom(
                    "patch-3".into(),
                    "apply_patch",
                    "*** Begin Patch\n*** Add File: invalid.txt\n+missing end",
                )
                .is_err()
        );
        assert!(
            registry
                .prepare_custom("patch-4".into(), "future_custom_tool", "input")
                .is_err()
        );
    }

    #[tokio::test]
    async fn write_targets_cannot_escape_the_workspace() {
        let directory = TempDir::new().expect("temporary workspace should exist");
        let workspace = tokio::fs::canonicalize(directory.path())
            .await
            .expect("workspace should canonicalize");
        assert!(
            resolve_write_target(&workspace, "../outside.txt")
                .await
                .is_err()
        );
        assert!(
            resolve_write_target(&workspace, "../../etc/passwd")
                .await
                .is_err()
        );
        assert!(
            resolve_write_target(&workspace, "sub/../../outside.txt")
                .await
                .is_err()
        );
        assert!(resolve_write_target(&workspace, "inside.txt").await.is_ok());
    }

    #[tokio::test]
    async fn atomic_write_replaces_an_existing_file() {
        let directory = TempDir::new().expect("temporary workspace should exist");
        let path = directory.path().join("state.txt");
        atomic_write(path.clone(), b"first".to_vec())
            .await
            .expect("initial atomic write should succeed");
        atomic_write(path.clone(), b"second".to_vec())
            .await
            .expect("replacement atomic write should succeed");

        let contents = tokio::fs::read_to_string(path)
            .await
            .expect("written file should be readable");
        assert_eq!(contents, "second");
    }

    #[tokio::test]
    async fn file_tools_round_trip_portuguese_as_utf8_without_bom() {
        const ORIGINAL: &str = "ação, coração, maçã, português e ÁÉÍÓÚ\n";
        const UPDATED: &str = "ação, edição, maçã, português e ÁÉÍÓÚ\n";

        let directory = TempDir::new().expect("temporary workspace should exist");
        let workspace = tokio::fs::canonicalize(directory.path())
            .await
            .expect("workspace should canonicalize");
        write_file(
            &workspace,
            &WriteFileArgs {
                path: "português.txt".into(),
                content: ORIGINAL.into(),
                overwrite: false,
            },
        )
        .await
        .expect("UTF-8 file should be created");
        edit_file(
            &workspace,
            &EditFileArgs {
                path: "português.txt".into(),
                old_text: "coração".into(),
                new_text: "edição".into(),
                expected_occurrences: 1,
            },
        )
        .await
        .expect("UTF-8 file should be edited");

        let bytes = tokio::fs::read(workspace.join("português.txt"))
            .await
            .expect("UTF-8 file should be readable");
        assert!(!bytes.starts_with(&[0xef, 0xbb, 0xbf]));
        assert_eq!(
            std::str::from_utf8(&bytes).expect("file tool output should be valid UTF-8"),
            UPDATED
        );
    }
}
