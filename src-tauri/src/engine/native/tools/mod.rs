use std::path::Path;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::AppHandle;
use tokio::sync::watch;

use super::apply_patch::parser::{ParsedPatch, parse_patch};
use super::apply_patch::plan::{prepare_patch, preview_changes};
use super::apply_patch::transaction::{PatchOutcome, commit_patch};
use super::approval::ApprovalBroker;
use super::output::OutputSource;
use super::storage::NativeStorage;
use super::text::{truncate_utf8, truncate_utf8_marked};
use crate::engine::{
    ActivityStatus, ApprovalDecision, CommandApprovalRequest, CommandSource, FileChange,
    FileChangeKind, PermissionProfile, PlanStep, PlanStepStatus, SandboxMode, ThreadItem,
};
use crate::error::AppError;

mod exec;
mod fs;
mod workspace;

use self::exec::{CommandOutput, command_timeout, execute_command};
use self::fs::{edit_file, list_files, read_file, search_text, write_file};
use self::workspace::{canonical_workspace, display_workspace_path, resolve_existing_directory};

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
                    "definition": include_str!("../apply_patch/apply_patch.lark")
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

    use super::fs::atomic_write;
    use super::workspace::resolve_write_target;
    use super::{
        MAX_COMMAND_TIMEOUT_SECONDS, SearchTextArgs, StoredToolOutput, ToolOperation, ToolRegistry,
        activity_status_for_exit_code, execute_patch_operation, search_text,
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
