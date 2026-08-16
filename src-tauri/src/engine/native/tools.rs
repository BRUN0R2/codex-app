use std::ffi::OsStr;
use std::fs::File;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::AppHandle;
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::watch;

use super::apply_patch::parser::{ParsedPatch, parse_patch};
use super::apply_patch::plan::{prepare_patch, preview_changes};
use super::apply_patch::transaction::{PatchOutcome, commit_patch};
use super::approval::ApprovalBroker;
use super::output::OutputSource;
use super::storage::NativeStorage;
use super::terminal_output::{configure_plain_terminal, normalize_terminal_file};
use super::text::{truncate_utf8, truncate_utf8_marked};
use crate::engine::{
    ActivityStatus, ApprovalDecision, CommandApprovalRequest, CommandSource, FileChange,
    FileChangeKind, PermissionProfile, PlanStep, PlanStepStatus, SandboxMode, ThreadItem,
};
use crate::error::AppError;
use crate::process::{headless_command, headless_shell_command};

pub(super) const MAX_PROVIDER_ITEM_BYTES: usize = 2 * 1_048_576;
const MAX_TOOL_ARGUMENT_BYTES: usize = 262_144;
const MAX_TOOL_DESCRIPTION_BYTES: usize = 160;
const MAX_FILE_BYTES: usize = 2 * 1_048_576;
const MAX_READ_LINES: usize = 2_000;
const MAX_LIST_RESULTS: usize = 500;
const MAX_LIST_DEPTH: usize = 12;
const MAX_SEARCH_RESULTS: usize = 200;
const MAX_SEARCH_FILES: usize = 10_000;
const MAX_SEARCH_DIRECTORIES: usize = 10_000;
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
pub(super) const MAX_DIFF_BYTES: usize = 131_072;
const DEFAULT_COMMAND_TIMEOUT_SECONDS: u64 = 60 * 60;
const MAX_COMMAND_TIMEOUT_SECONDS: u64 = 7 * 24 * 60 * 60;
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Debug, Default)]
pub struct ToolRegistry;

#[derive(Debug)]
pub struct PreparedTool {
    item_id: String,
    name: &'static str,
    description: String,
    operation: ToolOperation,
}

#[derive(Debug)]
enum ToolOperation {
    ApplyPatch(ParsedPatch),
    ReadFile(ReadFileArgs),
    ListFiles(ListFilesArgs),
    SearchText(SearchTextArgs),
    EditFile(EditFileArgs),
    WriteFile(WriteFileArgs),
    ReadOutput(ReadOutputArgs),
    ExecCommand(ExecCommandArgs),
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
}

pub struct ToolExecutionContext<'a> {
    pub app: &'a AppHandle,
    pub workspace: &'a Path,
    pub permissions: PermissionProfile,
    pub thread_id: &'a str,
    pub turn_id: &'a str,
    pub approvals: &'a ApprovalBroker,
    pub storage: &'a NativeStorage,
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecCommandArgs {
    command: String,
    cwd: String,
    reason: String,
    #[serde(default)]
    timeout_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadOutputArgs {
    output_id: String,
    cursor: Option<String>,
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
    pub fn definitions(&self) -> Vec<Value> {
        vec![
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
                        "old_text": { "type": "string", "minLength": 1 },
                        "new_text": { "type": "string" },
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
                "Run one non-interactive PowerShell command in the workspace. Output is spooled outside the conversation contract and remains available through read_output. Detached processes and external windows are unsupported; child processes remain headless and joined to the command lifetime. Workspace-write mode asks the user first.",
                json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "minLength": 1 },
                        "cwd": { "type": "string", "description": "Workspace-relative working directory, or . for the root." },
                        "reason": { "type": "string", "minLength": 1, "description": "A concise user-facing reason." },
                        "timeout_seconds": {
                            "type": ["integer", "null"],
                            "minimum": 1,
                            "maximum": MAX_COMMAND_TIMEOUT_SECONDS,
                            "description": "Command lifetime in seconds. Use null for the one-hour default; it can be extended to seven days for long-running work."
                        }
                    },
                    "required": ["command", "cwd", "reason", "timeout_seconds"],
                    "additionalProperties": false
                }),
            ),
            function_tool(
                "read_output",
                "Read one UTF-8 chunk from a previously stored tool or command output. Start with a null cursor and follow next_cursor until it is null.",
                json!({
                    "type": "object",
                    "properties": {
                        "output_id": { "type": "string", "minLength": 1 },
                        "cursor": { "type": ["string", "null"] }
                    },
                    "required": ["output_id", "cursor"],
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
                "description": "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
                "format": {
                    "type": "grammar",
                    "syntax": "lark",
                    "definition": include_str!("apply_patch/apply_patch.lark")
                }
            }),
        ]
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
            "read_output" => {
                let args: ReadOutputArgs = decode_arguments(name, arguments)?;
                let description = format!("Read stored output {}", args.output_id);
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
            _ => return Err(AppError::Tool(format!("unknown tool `{name}`"))),
        };
        Ok(PreparedTool {
            item_id,
            name,
            description,
            operation,
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
                })
            }
            _ => Err(AppError::Tool(format!("unknown custom tool `{name}`"))),
        }
    }
}

impl PreparedTool {
    pub fn name(&self) -> &'static str {
        self.name
    }

    pub fn is_parallel_safe(&self) -> bool {
        matches!(
            &self.operation,
            ToolOperation::ReadFile(_)
                | ToolOperation::ListFiles(_)
                | ToolOperation::SearchText(_)
                | ToolOperation::ReadOutput(_)
        )
    }

    pub fn started_item(&self, workspace: &Path) -> ThreadItem {
        match &self.operation {
            ToolOperation::ApplyPatch(patch) => ThreadItem::FileChange {
                id: self.item_id.clone(),
                changes: preview_changes(patch),
                status: ActivityStatus::InProgress,
            },
            ToolOperation::ExecCommand(args) => ThreadItem::CommandExecution {
                id: self.item_id.clone(),
                command: args.command.clone(),
                cwd: display_workspace_path(workspace, &args.cwd),
                process_id: None,
                source: CommandSource::Agent,
                status: ActivityStatus::InProgress,
                aggregated_output: None,
                exit_code: None,
                duration_ms: None,
            },
            ToolOperation::EditFile(args) => ThreadItem::FileChange {
                id: self.item_id.clone(),
                changes: vec![FileChange {
                    path: args.path.clone(),
                    kind: FileChangeKind::Update { move_path: None },
                    diff: diff_preview(&args.old_text, &args.new_text),
                }],
                status: ActivityStatus::InProgress,
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
                }],
                status: ActivityStatus::InProgress,
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
                status: ActivityStatus::InProgress,
                output: None,
            },
        }
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
            });
        }
        let workspace = canonical_workspace(context.workspace).await?;
        let started_at = Instant::now();
        let execution = match &self.operation {
            ToolOperation::ApplyPatch(patch) => execute_patch_operation(
                &workspace,
                patch.clone(),
                context.permissions,
                cancellation,
            )
            .await
            .map(ToolResult::Patch),
            ToolOperation::ReadFile(args) => read_file(&workspace, args)
                .await
                .map(|output| ToolResult::StoredOutput(StoredToolOutput::Text(output))),
            ToolOperation::ListFiles(args) => list_files(&workspace, args)
                .await
                .map(|output| ToolResult::StoredOutput(StoredToolOutput::Text(output))),
            ToolOperation::SearchText(args) => search_text(&workspace, args)
                .await
                .map(|output| ToolResult::StoredOutput(StoredToolOutput::Text(output))),
            ToolOperation::ReadOutput(args) => context
                .storage
                .read_output_for_thread(
                    context.thread_id.to_string(),
                    args.output_id.clone(),
                    args.cursor.clone(),
                )
                .await
                .map(|response| {
                    ToolResult::StoredOutput(StoredToolOutput::OutputPage(format!(
                        "output_id: {}\nnext_cursor: {}\nchunk:\n{}",
                        response.output_id,
                        response.next_cursor.as_deref().unwrap_or("null"),
                        response.chunk
                    )))
                }),
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
                execute_command(&workspace, args, cancellation)
                    .await
                    .map(|output| ToolResult::StoredOutput(StoredToolOutput::Command(output)))
            }
            ToolOperation::UpdatePlan { .. } => {
                return Err(AppError::Tool(
                    "update_plan must complete before filesystem tool execution".into(),
                ));
            }
        };

        match execution {
            Ok(ToolResult::Patch(outcome)) => Ok(ToolExecutionResult {
                provider_output: outcome.output,
                completed_item: ThreadItem::FileChange {
                    id: self.item_id.clone(),
                    changes: outcome.changes,
                    status: ActivityStatus::Completed,
                },
                display_output: None,
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
        })
    }

    async fn complete_stored_output(
        &self,
        workspace: &Path,
        started_at: Instant,
        output: StoredToolOutput,
    ) -> Result<ToolExecutionResult, AppError> {
        let (output, provider_output, exit_code) = output.into_output().await?;
        let duration = elapsed_millis(started_at)?;
        let status = activity_status_for_exit_code(exit_code);
        let completed_item = self.finish_item(workspace, status, exit_code, Some(duration));
        Ok(ToolExecutionResult {
            provider_output,
            completed_item,
            display_output: Some(output),
        })
    }

    fn finish_item(
        &self,
        workspace: &Path,
        status: ActivityStatus,
        exit_code: Option<i32>,
        duration_ms: Option<u64>,
    ) -> ThreadItem {
        match &self.operation {
            ToolOperation::ApplyPatch(patch) => ThreadItem::FileChange {
                id: self.item_id.clone(),
                changes: preview_changes(patch),
                status,
            },
            ToolOperation::ExecCommand(args) => ThreadItem::CommandExecution {
                id: self.item_id.clone(),
                command: args.command.clone(),
                cwd: display_workspace_path(workspace, &args.cwd),
                process_id: None,
                source: CommandSource::Agent,
                status,
                aggregated_output: None,
                exit_code,
                duration_ms,
            },
            ToolOperation::EditFile(args) => ThreadItem::FileChange {
                id: self.item_id.clone(),
                changes: vec![FileChange {
                    path: args.path.clone(),
                    kind: FileChangeKind::Update { move_path: None },
                    diff: diff_preview(&args.old_text, &args.new_text),
                }],
                status,
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
                }],
                status,
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
                status,
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
        }
    }

    fn can_own_stored_output(&self) -> bool {
        matches!(
            &self.operation,
            ToolOperation::ReadFile(_)
                | ToolOperation::ListFiles(_)
                | ToolOperation::SearchText(_)
                | ToolOperation::ReadOutput(_)
                | ToolOperation::ExecCommand(_)
        )
    }
}

enum ToolResult {
    StoredOutput(StoredToolOutput),
    MutationConfirmation(String),
    Patch(PatchOutcome),
}

enum StoredToolOutput {
    Text(String),
    OutputPage(String),
    Command(CommandOutput),
}

impl StoredToolOutput {
    async fn into_output(self) -> Result<(OutputSource, String, Option<i32>), AppError> {
        match self {
            Self::Text(output) => {
                let source = OutputSource::text(output);
                let provider_output = source.provider_output();
                Ok((source, provider_output, None))
            }
            Self::OutputPage(output) => {
                let provider_output = output.clone();
                Ok((OutputSource::text(output), provider_output, None))
            }
            Self::Command(output) => {
                let exit_code = output.exit_code;
                let source = tokio::task::spawn_blocking(move || {
                    OutputSource::command(exit_code, output.stdout, output.stderr)
                })
                .await
                .map_err(|error| AppError::Tool(format!("output spool task failed: {error}")))?
                .map_err(|error| AppError::Tool(format!("could not assemble output: {error}")))?;
                let provider_output = source.provider_output();
                Ok((source, provider_output, Some(exit_code)))
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

struct CommandOutput {
    exit_code: i32,
    stdout: File,
    stderr: File,
}

async fn read_file(workspace: &Path, args: &ReadFileArgs) -> Result<String, AppError> {
    let start =
        usize::try_from(args.start_line).map_err(|error| AppError::Tool(error.to_string()))?;
    let end = usize::try_from(args.end_line).map_err(|error| AppError::Tool(error.to_string()))?;
    if start == 0 || end < start || end - start + 1 > MAX_READ_LINES {
        return Err(AppError::Tool(format!(
            "line range must contain between 1 and {MAX_READ_LINES} lines"
        )));
    }
    let path = resolve_existing_file(workspace, &args.path).await?;
    let bytes = read_file_bounded(&path).await?;
    let text = String::from_utf8(bytes)
        .map_err(|_| AppError::Tool("read_file supports UTF-8 text only".into()))?;
    let lines = text
        .lines()
        .enumerate()
        .filter(|(index, _)| *index + 1 >= start && *index < end)
        .map(|(index, line)| format!("{}: {line}", index + 1))
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return Err(AppError::Tool(
            "requested line range is outside the file".into(),
        ));
    }
    Ok(lines.join("\n"))
}

async fn list_files(workspace: &Path, args: &ListFilesArgs) -> Result<String, AppError> {
    let depth = usize::from(args.max_depth);
    if depth == 0 || depth > MAX_LIST_DEPTH {
        return Err(AppError::Tool(format!(
            "list depth must be between 1 and {MAX_LIST_DEPTH}"
        )));
    }
    let root = resolve_existing_path(workspace, &args.path).await?;
    let workspace = workspace.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();
        walk_files(&workspace, &root, depth, &mut files)?;
        files.sort();
        Ok(files.join("\n"))
    })
    .await
    .map_err(|error| AppError::Tool(format!("file listing task failed: {error}")))?
}

async fn search_text(workspace: &Path, args: &SearchTextArgs) -> Result<String, AppError> {
    if args.query.is_empty() || args.query.len() > MAX_SEARCH_QUERY_BYTES {
        return Err(AppError::Tool(format!(
            "search query must contain between 1 and {MAX_SEARCH_QUERY_BYTES} bytes"
        )));
    }
    let root = resolve_existing_path(workspace, &args.path).await?;
    let workspace = workspace.to_path_buf();
    let query = args.query.clone();
    let case_sensitive = args.case_sensitive;
    tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();
        if root.is_file() {
            files.push(root);
        } else {
            collect_search_files(&root, &mut files)?;
        }
        files.sort();
        let needle = (!case_sensitive).then(|| query.to_lowercase());
        let mut matches = Vec::new();
        let mut skipped_large = 0usize;
        let mut skipped_unreadable = 0usize;
        for file in files {
            let metadata = std::fs::metadata(&file)
                .map_err(|error| AppError::FileSystem(error.to_string()))?;
            if metadata.len() > MAX_FILE_BYTES as u64 {
                skipped_large += 1;
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&file) else {
                skipped_unreadable += 1;
                continue;
            };
            for (index, line) in text.lines().enumerate() {
                let found = match &needle {
                    Some(needle) => line.to_lowercase().contains(needle),
                    None => line.contains(&query),
                };
                if found {
                    let relative = relative_display(&workspace, &file)?;
                    matches.push(format!(
                        "{relative}:{}:{}",
                        index + 1,
                        truncate_utf8(line, MAX_SEARCH_LINE_BYTES)
                    ));
                    if matches.len() >= MAX_SEARCH_RESULTS {
                        return Ok(format_search_output(
                            matches,
                            skipped_large,
                            skipped_unreadable,
                            true,
                        ));
                    }
                }
            }
        }
        Ok(format_search_output(
            matches,
            skipped_large,
            skipped_unreadable,
            false,
        ))
    })
    .await
    .map_err(|error| AppError::Tool(format!("search task failed: {error}")))?
}

async fn edit_file(workspace: &Path, args: &EditFileArgs) -> Result<String, AppError> {
    if args.old_text.is_empty()
        || args.expected_occurrences == 0
        || args.expected_occurrences > MAX_EDIT_OCCURRENCES
    {
        return Err(AppError::Tool(format!(
            "edit_file requires an exact non-empty match count from 1 to {MAX_EDIT_OCCURRENCES}"
        )));
    }
    let path = resolve_existing_file(workspace, &args.path).await?;
    let bytes = read_file_bounded(&path).await?;
    let current = String::from_utf8(bytes)
        .map_err(|_| AppError::Tool("edit_file supports UTF-8 text only".into()))?;
    let occurrences = current.matches(&args.old_text).count();
    if occurrences != usize::from(args.expected_occurrences) {
        return Err(AppError::Tool(format!(
            "edit target occurred {occurrences} times; expected {}",
            args.expected_occurrences
        )));
    }
    let updated = current.replace(&args.old_text, &args.new_text);
    if updated.len() > MAX_FILE_BYTES {
        return Err(AppError::Tool(format!(
            "edited file exceeds {MAX_FILE_BYTES} bytes"
        )));
    }
    atomic_write(path, updated.into_bytes()).await?;
    Ok(format!(
        "Updated {} exact occurrence(s) in {}.",
        occurrences, args.path
    ))
}

async fn write_file(workspace: &Path, args: &WriteFileArgs) -> Result<String, AppError> {
    if args.content.len() > MAX_FILE_BYTES {
        return Err(AppError::Tool(format!(
            "file content exceeds {MAX_FILE_BYTES} bytes"
        )));
    }
    let path = resolve_write_target(workspace, &args.path).await?;
    let existed = tokio::fs::try_exists(&path)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if existed && !args.overwrite {
        return Err(AppError::Tool(
            "target exists; set overwrite to true only when replacement is intended".into(),
        ));
    }
    if !existed && args.overwrite {
        return Err(AppError::Tool(
            "target does not exist; overwrite must be false for creation".into(),
        ));
    }
    atomic_write(path, args.content.as_bytes().to_vec()).await?;
    Ok(if existed {
        format!("Replaced {}.", args.path)
    } else {
        format!("Created {}.", args.path)
    })
}

async fn execute_command(
    workspace: &Path,
    args: &ExecCommandArgs,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<CommandOutput, AppError> {
    if args.command.trim().is_empty() || args.command.len() > MAX_COMMAND_BYTES {
        return Err(AppError::Tool(format!(
            "command must contain between 1 and {MAX_COMMAND_BYTES} bytes"
        )));
    }
    if args.reason.trim().is_empty() || args.reason.len() > MAX_COMMAND_REASON_BYTES {
        return Err(AppError::Tool(format!(
            "command reason must contain between 1 and {MAX_COMMAND_REASON_BYTES} bytes"
        )));
    }
    let command_timeout = command_timeout(args)?;
    let cwd = resolve_existing_directory(workspace, &args.cwd).await?;
    let mut command = headless_shell_command(&args.command);
    configure_plain_terminal(&mut command);
    let mut child = command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| AppError::Tool(format!("could not start command: {error}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Tool("command stdout pipe was not created".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Tool("command stderr pipe was not created".into()))?;
    let mut stdout_task = tokio::spawn(read_stream_spooled(stdout));
    let mut stderr_task = tokio::spawn(read_stream_spooled(stderr));
    let mut stdout_output = None;
    let mut stderr_output = None;
    let deadline = Instant::now()
        .checked_add(command_timeout)
        .ok_or_else(|| AppError::Tool("command timeout could not be represented".into()))?;

    let status = loop {
        if *cancellation.borrow() {
            terminate_child(&mut child).await?;
            return Err(AppError::Cancelled(
                "turn was interrupted during command execution".into(),
            ));
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| AppError::Tool(format!("could not poll command: {error}")))?
        {
            break status;
        }
        if stdout_output.is_none() && stdout_task.is_finished() {
            match finish_capture_ref(&mut stdout_task, "stdout").await {
                Ok(output) => stdout_output = Some(output),
                Err(error) => {
                    if let Err(termination_error) = terminate_child(&mut child).await {
                        return Err(AppError::Tool(format!(
                            "{error}; command termination also failed: {termination_error}"
                        )));
                    }
                    return Err(error);
                }
            }
        }
        if stderr_output.is_none() && stderr_task.is_finished() {
            match finish_capture_ref(&mut stderr_task, "stderr").await {
                Ok(output) => stderr_output = Some(output),
                Err(error) => {
                    if let Err(termination_error) = terminate_child(&mut child).await {
                        return Err(AppError::Tool(format!(
                            "{error}; command termination also failed: {termination_error}"
                        )));
                    }
                    return Err(error);
                }
            }
        }
        if Instant::now() >= deadline {
            terminate_child(&mut child).await.map_err(|error| {
                AppError::Tool(format!(
                    "command timed out and could not be terminated safely: {error}"
                ))
            })?;
            return Err(AppError::Timeout {
                operation: "command execution",
            });
        }
        tokio::select! {
            changed = cancellation.changed() => {
                if changed.is_err() || *cancellation.borrow() {
                    terminate_child(&mut child).await?;
                    return Err(AppError::Cancelled("turn was interrupted during command execution".into()));
                }
            }
            () = tokio::time::sleep(PROCESS_POLL_INTERVAL) => {}
        }
    };

    let stdout = match stdout_output {
        Some(output) => output,
        None => finish_capture(stdout_task, "stdout").await?,
    };
    let stderr = match stderr_output {
        Some(output) => output,
        None => finish_capture(stderr_task, "stderr").await?,
    };
    let exit_code = status
        .code()
        .ok_or_else(|| AppError::Tool("command ended without an exit code".into()))?;
    Ok(CommandOutput {
        exit_code,
        stdout,
        stderr,
    })
}

fn command_timeout(args: &ExecCommandArgs) -> Result<Duration, AppError> {
    let timeout_seconds = args
        .timeout_seconds
        .unwrap_or(DEFAULT_COMMAND_TIMEOUT_SECONDS);
    if timeout_seconds == 0 || timeout_seconds > MAX_COMMAND_TIMEOUT_SECONDS {
        return Err(AppError::Tool(format!(
            "command timeout must contain between 1 and {MAX_COMMAND_TIMEOUT_SECONDS} seconds"
        )));
    }
    Ok(Duration::from_secs(timeout_seconds))
}

async fn finish_capture_ref(
    task: &mut tokio::task::JoinHandle<Result<File, AppError>>,
    label: &str,
) -> Result<File, AppError> {
    task.await
        .map_err(|error| AppError::Tool(format!("{label} reader failed: {error}")))?
}

async fn finish_capture(
    task: tokio::task::JoinHandle<Result<File, AppError>>,
    label: &str,
) -> Result<File, AppError> {
    task.await
        .map_err(|error| AppError::Tool(format!("{label} reader failed: {error}")))?
}

async fn read_stream_spooled<R: AsyncRead + Unpin>(mut stream: R) -> Result<File, AppError> {
    let output = tempfile::tempfile()
        .map_err(|error| AppError::Tool(format!("could not create output spool: {error}")))?;
    let mut output = tokio::fs::File::from_std(output);
    let mut buffer = [0u8; MAX_COMMAND_STREAM_CHUNK_BYTES];
    loop {
        let count = stream
            .read(&mut buffer)
            .await
            .map_err(|error| AppError::Tool(format!("could not read process output: {error}")))?;
        if count == 0 {
            break;
        }
        output
            .write_all(&buffer[..count])
            .await
            .map_err(|error| AppError::Tool(format!("could not spool process output: {error}")))?;
    }
    output
        .flush()
        .await
        .map_err(|error| AppError::Tool(format!("could not flush process output: {error}")))?;
    let raw = output.into_std().await;
    tokio::task::spawn_blocking(move || normalize_terminal_file(raw))
        .await
        .map_err(|error| AppError::Tool(format!("terminal normalization task failed: {error}")))?
        .map_err(|error| AppError::Tool(format!("could not normalize process output: {error}")))
}

#[cfg(windows)]
async fn terminate_child(child: &mut tokio::process::Child) -> Result<(), AppError> {
    let Some(process_id) = child.id() else {
        return child.try_wait().map(|_| ()).map_err(|error| {
            AppError::Tool(format!("could not inspect command process: {error}"))
        });
    };
    let mut taskkill = headless_command("taskkill.exe");
    taskkill
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .kill_on_drop(true);
    let output = match tokio::time::timeout(Duration::from_secs(5), taskkill.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return terminate_direct_child_after_tree_failure(
                child,
                format!("could not start taskkill: {error}"),
            )
            .await;
        }
        Err(_) => {
            return terminate_direct_child_after_tree_failure(
                child,
                "taskkill exceeded its 5 second time limit".into(),
            )
            .await;
        }
    };
    if !output.status.success() {
        if child
            .try_wait()
            .map_err(|error| AppError::Tool(format!("could not inspect command process: {error}")))?
            .is_some()
        {
            return Ok(());
        }
        let message = String::from_utf8_lossy(&output.stderr);
        return terminate_direct_child_after_tree_failure(
            child,
            format!(
                "taskkill could not terminate process tree {process_id}: {}",
                message.trim()
            ),
        )
        .await;
    }
    tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .map_err(|_| AppError::Tool("terminated command did not exit within 5 seconds".into()))?
        .map_err(|error| AppError::Tool(format!("could not reap command process: {error}")))?;
    Ok(())
}

#[cfg(windows)]
async fn terminate_direct_child_after_tree_failure(
    child: &mut tokio::process::Child,
    tree_error: String,
) -> Result<(), AppError> {
    if child
        .try_wait()
        .map_err(|error| AppError::Tool(format!("could not inspect command process: {error}")))?
        .is_some()
    {
        return Ok(());
    }
    match child.kill().await {
        Ok(()) => Err(AppError::Tool(format!(
            "{tree_error}; the direct child was terminated, but descendant termination could not be confirmed"
        ))),
        Err(error) => Err(AppError::Tool(format!(
            "{tree_error}; direct child termination also failed: {error}"
        ))),
    }
}

#[cfg(not(windows))]
async fn terminate_child(child: &mut tokio::process::Child) -> Result<(), AppError> {
    child
        .kill()
        .await
        .map_err(|error| AppError::Tool(format!("could not terminate command process: {error}")))
}

async fn canonical_workspace(workspace: &Path) -> Result<PathBuf, AppError> {
    let canonical = tokio::fs::canonicalize(workspace)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    let metadata = tokio::fs::metadata(&canonical)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if !metadata.is_dir() {
        return Err(AppError::FileSystem("workspace is not a directory".into()));
    }
    Ok(canonical)
}

async fn resolve_existing_path(workspace: &Path, relative: &str) -> Result<PathBuf, AppError> {
    let relative = validate_relative_path(relative)?;
    let path = tokio::fs::canonicalize(workspace.join(relative))
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    ensure_inside_workspace(workspace, &path)?;
    Ok(path)
}

async fn resolve_existing_file(workspace: &Path, relative: &str) -> Result<PathBuf, AppError> {
    let path = resolve_existing_path(workspace, relative).await?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if !metadata.is_file() {
        return Err(AppError::FileSystem("path is not a regular file".into()));
    }
    Ok(path)
}

async fn resolve_existing_directory(workspace: &Path, relative: &str) -> Result<PathBuf, AppError> {
    let path = resolve_existing_path(workspace, relative).await?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if !metadata.is_dir() {
        return Err(AppError::FileSystem("path is not a directory".into()));
    }
    Ok(path)
}

async fn resolve_write_target(workspace: &Path, relative: &str) -> Result<PathBuf, AppError> {
    let relative = validate_relative_path(relative)?;
    let target = workspace.join(relative);
    let parent = target
        .parent()
        .ok_or_else(|| AppError::FileSystem("write target has no parent".into()))?;
    let canonical_parent = tokio::fs::canonicalize(parent).await.map_err(|error| {
        AppError::FileSystem(format!("write target parent is invalid: {error}"))
    })?;
    ensure_inside_workspace(workspace, &canonical_parent)?;
    let file_name = target
        .file_name()
        .ok_or_else(|| AppError::FileSystem("write target has no file name".into()))?;
    let target = canonical_parent.join(file_name);
    if tokio::fs::try_exists(&target)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?
    {
        let canonical = tokio::fs::canonicalize(&target)
            .await
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
        ensure_inside_workspace(workspace, &canonical)?;
        return Ok(canonical);
    }
    Ok(target)
}

fn validate_relative_path(value: &str) -> Result<&Path, AppError> {
    if value.is_empty() || value.len() > MAX_TOOL_PATH_BYTES {
        return Err(AppError::Protocol(
            "workspace path is empty or too long".into(),
        ));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(AppError::Permission(
            "tool paths must be workspace-relative and cannot contain parent traversal".into(),
        ));
    }
    Ok(path)
}

fn ensure_inside_workspace(workspace: &Path, path: &Path) -> Result<(), AppError> {
    if path.starts_with(workspace) {
        Ok(())
    } else {
        Err(AppError::Permission(
            "resolved path escapes the workspace".into(),
        ))
    }
}

async fn read_file_bounded(path: &Path) -> Result<Vec<u8>, AppError> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if metadata.len() > MAX_FILE_BYTES as u64 {
        return Err(AppError::Tool(format!(
            "file exceeds {MAX_FILE_BYTES} bytes"
        )));
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(AppError::Tool(format!(
            "file changed while reading and now exceeds {MAX_FILE_BYTES} bytes"
        )));
    }
    Ok(bytes)
}

async fn atomic_write(path: PathBuf, bytes: Vec<u8>) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let parent = path
            .parent()
            .ok_or_else(|| AppError::FileSystem("write target has no parent".into()))?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
        std::io::Write::write_all(&mut temporary, &bytes)
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
        temporary
            .persist(&path)
            .map_err(|error| AppError::FileSystem(error.error.to_string()))?;
        Ok(())
    })
    .await
    .map_err(|error| AppError::FileSystem(format!("file write task failed: {error}")))?
}

fn walk_files(
    workspace: &Path,
    directory: &Path,
    depth: usize,
    output: &mut Vec<String>,
) -> Result<(), AppError> {
    if output.len() >= MAX_LIST_RESULTS || depth == 0 {
        return Ok(());
    }
    if directory.is_file() {
        output.push(relative_display(workspace, directory)?);
        return Ok(());
    }
    let mut entries = std::fs::read_dir(directory)
        .map_err(|error| AppError::FileSystem(error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        if output.len() >= MAX_LIST_RESULTS {
            output.push(format!("[results truncated at {MAX_LIST_RESULTS}]"));
            break;
        }
        let file_type = entry
            .file_type()
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
        if file_type.is_symlink() || ignored_directory(&entry.file_name()) {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            walk_files(workspace, &path, depth - 1, output)?;
        } else if file_type.is_file() {
            output.push(relative_display(workspace, &path)?);
        }
    }
    Ok(())
}

fn collect_search_files(directory: &Path, output: &mut Vec<PathBuf>) -> Result<(), AppError> {
    let mut pending_directories = vec![directory.to_path_buf()];
    let mut visited_directories = 0usize;
    while let Some(directory) = pending_directories.pop() {
        visited_directories += 1;
        if visited_directories > MAX_SEARCH_DIRECTORIES {
            return Err(AppError::Tool(format!(
                "search traversal exceeds {MAX_SEARCH_DIRECTORIES} directories"
            )));
        }
        let entries = std::fs::read_dir(directory)
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
        for entry in entries {
            let entry = entry.map_err(|error| AppError::FileSystem(error.to_string()))?;
            let file_type = entry
                .file_type()
                .map_err(|error| AppError::FileSystem(error.to_string()))?;
            if file_type.is_symlink() || ignored_directory(&entry.file_name()) {
                continue;
            }
            if file_type.is_dir() {
                pending_directories.push(entry.path());
            } else if file_type.is_file() {
                if output.len() >= MAX_SEARCH_FILES {
                    return Err(AppError::Tool(format!(
                        "search traversal exceeds {MAX_SEARCH_FILES} files"
                    )));
                }
                output.push(entry.path());
            }
        }
    }
    Ok(())
}

fn ignored_directory(name: &OsStr) -> bool {
    matches!(
        name.to_str(),
        Some(".git" | ".idea" | ".reference" | ".vscode" | "node_modules" | "target")
    )
}

fn relative_display(workspace: &Path, path: &Path) -> Result<String, AppError> {
    path.strip_prefix(workspace)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|_| AppError::Permission("path is outside the workspace".into()))
}

fn display_workspace_path(workspace: &Path, relative: &str) -> String {
    workspace.join(relative).display().to_string()
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
    truncate_utf8_marked(
        &format!("--- before\n+++ after\n-{}\n+{}", old, new),
        MAX_DIFF_BYTES,
    )
}

fn format_search_output(
    matches: Vec<String>,
    skipped_large: usize,
    skipped_unreadable: usize,
    truncated: bool,
) -> String {
    let mut output = if matches.is_empty() {
        "No matches found.".to_string()
    } else {
        matches.join("\n")
    };
    if truncated {
        output.push_str(&format!("\n[results truncated at {MAX_SEARCH_RESULTS}]"));
    }
    if skipped_large > 0 || skipped_unreadable > 0 {
        output.push_str(&format!(
            "\n[skipped files: {skipped_large} larger than {MAX_FILE_BYTES} bytes, {skipped_unreadable} unreadable or non-UTF-8]"
        ));
    }
    output
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
    use std::path::Path;

    use serde_json::Value;
    use tempfile::TempDir;
    use tokio::sync::watch;

    use crate::engine::{ActivityStatus, PermissionProfile, PlanStepStatus, ThreadItem};
    use crate::error::AppError;

    use super::{
        MAX_COMMAND_TIMEOUT_SECONDS, SearchTextArgs, StoredToolOutput, ToolOperation, ToolRegistry,
        activity_status_for_exit_code, atomic_write, execute_patch_operation, resolve_write_target,
        search_text,
    };

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
    async fn externalizes_tool_output_instead_of_rejecting_it() {
        let output = "x".repeat(2 * 1_048_576);

        let (source, provider_output, exit_code) = StoredToolOutput::Text(output.clone())
            .into_output()
            .await
            .expect("large tool output should remain available as a resource");

        assert_eq!(source.reference().byte_length, output.len() as u64);
        assert!(provider_output.contains(&source.reference().id));
        assert_eq!(exit_code, None);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn returns_a_requested_output_page_directly_to_the_provider() {
        let output_page = format!(
            "output_id: output-1\nnext_cursor: 2\nchunk:\n{}",
            "x".repeat(64 * 1_024)
        );

        let (source, provider_output, exit_code) =
            StoredToolOutput::OutputPage(output_page.clone())
                .into_output()
                .await
                .expect("an output page should remain directly readable");

        assert_eq!(provider_output, output_page);
        assert!(source.reference().next_cursor.is_some());
        assert_eq!(exit_code, None);
    }

    #[test]
    fn apply_patch_tool_definition_is_freeform_and_grammar_constrained() {
        let tool = ToolRegistry
            .definitions()
            .into_iter()
            .find(|tool| tool["name"] == "apply_patch")
            .expect("apply_patch should be advertised");

        assert_eq!(tool["type"], "custom");
        assert_eq!(tool["name"], "apply_patch");
        assert_eq!(tool["format"]["type"], "grammar");
        assert_eq!(tool["format"]["syntax"], "lark");
        assert_eq!(
            tool["format"]["definition"],
            include_str!("apply_patch/apply_patch.lark")
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
    fn only_read_only_workspace_tools_are_parallel_safe() {
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
                r#"{"command":"Get-Date","cwd":".","reason":"test"}"#,
            )
            .expect("exec_command should prepare");

        assert!(read.is_parallel_safe());
        assert!(search.is_parallel_safe());
        assert!(!command.is_parallel_safe());
    }

    #[test]
    fn command_timeout_can_cover_long_running_autonomous_work() {
        let registry = ToolRegistry;
        let extended = format!(
            r#"{{"command":"Get-Date","cwd":".","reason":"test","timeout_seconds":{MAX_COMMAND_TIMEOUT_SECONDS}}}"#
        );
        registry
            .prepare("command-long".into(), "exec_command", &extended)
            .expect("the seven-day command timeout should prepare");

        let excessive = format!(
            r#"{{"command":"Get-Date","cwd":".","reason":"test","timeout_seconds":{}}}"#,
            MAX_COMMAND_TIMEOUT_SECONDS + 1
        );
        assert!(
            registry
                .prepare("command-too-long".into(), "exec_command", &excessive)
                .is_err()
        );
    }

    #[test]
    fn exec_command_timeout_schema_is_required_and_nullable() {
        let definition = ToolRegistry
            .definitions()
            .into_iter()
            .find(|tool| tool["name"] == "exec_command")
            .expect("exec_command should be advertised");
        let parameters = &definition["parameters"];

        assert_eq!(
            parameters["required"],
            serde_json::json!(["command", "cwd", "reason", "timeout_seconds"])
        );
        assert_eq!(
            parameters["properties"]["timeout_seconds"]["type"],
            serde_json::json!(["integer", "null"])
        );

        ToolRegistry
            .prepare(
                "command-default-timeout".into(),
                "exec_command",
                r#"{"command":"Get-Date","cwd":".","reason":"test","timeout_seconds":null}"#,
            )
            .expect("a null timeout should use the default");
    }

    #[test]
    fn strict_function_schemas_require_every_declared_property() {
        for definition in ToolRegistry
            .definitions()
            .into_iter()
            .filter(|tool| tool["type"] == "function")
        {
            let name = definition["name"]
                .as_str()
                .expect("function tools should have names");
            assert_eq!(definition["strict"], true, "{name} must use strict mode");
            assert_strict_object_schema(&definition["parameters"], name);
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
            .into_iter()
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

        let output = search_text(
            &workspace,
            &SearchTextArgs {
                path: ".".into(),
                query: "deep marker".into(),
                case_sensitive: false,
            },
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
}
