use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::AppHandle;
use tokio::io::{AsyncRead, AsyncReadExt as _};
use tokio::process::Command;
use tokio::sync::watch;

use super::approval::ApprovalBroker;
use crate::engine::{
    ActivityStatus, ApprovalDecision, CommandApprovalRequest, CommandSource, FileChange,
    FileChangeKind, PermissionProfile, SandboxMode, ThreadItem,
};
use crate::error::AppError;

const MAX_TOOL_ARGUMENT_BYTES: usize = 262_144;
const MAX_FILE_BYTES: usize = 2 * 1_048_576;
const MAX_READ_LINES: usize = 2_000;
const MAX_LIST_RESULTS: usize = 500;
const MAX_LIST_DEPTH: usize = 12;
const MAX_SEARCH_RESULTS: usize = 200;
const MAX_SEARCH_FILES: usize = 10_000;
const MAX_SEARCH_QUERY_BYTES: usize = 1_024;
const MAX_COMMAND_BYTES: usize = 16_384;
const MAX_COMMAND_OUTPUT_BYTES: usize = 1_048_576;
const MAX_TOOL_OUTPUT_BYTES: usize = 1_048_576;
const MAX_DIFF_BYTES: usize = 131_072;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
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
    ReadFile(ReadFileArgs),
    ListFiles(ListFilesArgs),
    SearchText(SearchTextArgs),
    EditFile(EditFileArgs),
    WriteFile(WriteFileArgs),
    ExecCommand(ExecCommandArgs),
}

#[derive(Debug)]
pub struct ToolExecutionResult {
    pub provider_output: String,
    pub completed_item: ThreadItem,
}

pub struct ToolExecutionContext<'a> {
    pub app: &'a AppHandle,
    pub workspace: &'a Path,
    pub permissions: PermissionProfile,
    pub thread_id: &'a str,
    pub turn_id: &'a str,
    pub approvals: &'a ApprovalBroker,
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
                        "expected_occurrences": { "type": "integer", "minimum": 1, "maximum": 100 }
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
                "Run one bounded non-interactive PowerShell command in the workspace. Workspace-write mode asks the user first.",
                json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "minLength": 1 },
                        "cwd": { "type": "string", "description": "Workspace-relative working directory, or . for the root." },
                        "reason": { "type": "string", "minLength": 1, "description": "A concise user-facing reason." }
                    },
                    "required": ["command", "cwd", "reason"],
                    "additionalProperties": false
                }),
            ),
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
                let description = format!("Run {}", truncate_utf8(&args.command, 160));
                (
                    "exec_command",
                    description,
                    ToolOperation::ExecCommand(args),
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
}

impl PreparedTool {
    pub fn started_item(&self, workspace: &Path) -> ThreadItem {
        match &self.operation {
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
            _ => ThreadItem::ToolExecution {
                id: self.item_id.clone(),
                name: self.name.into(),
                description: self.description.clone(),
                status: ActivityStatus::InProgress,
                output: None,
            },
        }
    }

    pub fn failed_item(&self, workspace: &Path, error: &AppError) -> ThreadItem {
        self.finish_item(
            workspace,
            ActivityStatus::Failed,
            Some(error.to_string()),
            None,
            None,
        )
    }

    pub async fn execute(
        &self,
        context: ToolExecutionContext<'_>,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<ToolExecutionResult, AppError> {
        let workspace = canonical_workspace(context.workspace).await?;
        let started_at = Instant::now();
        let execution = match &self.operation {
            ToolOperation::ReadFile(args) => {
                read_file(&workspace, args).await.map(ToolResult::Text)
            }
            ToolOperation::ListFiles(args) => {
                list_files(&workspace, args).await.map(ToolResult::Text)
            }
            ToolOperation::SearchText(args) => {
                search_text(&workspace, args).await.map(ToolResult::Text)
            }
            ToolOperation::EditFile(args) => {
                require_workspace_write(context.permissions)?;
                edit_file(&workspace, args).await.map(ToolResult::Text)
            }
            ToolOperation::WriteFile(args) => {
                require_workspace_write(context.permissions)?;
                write_file(&workspace, args).await.map(ToolResult::Text)
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
                            return Ok(ToolExecutionResult {
                                provider_output: output.clone(),
                                completed_item: self.finish_item(
                                    &workspace,
                                    ActivityStatus::Declined,
                                    Some(output),
                                    None,
                                    Some(elapsed_millis(started_at)?),
                                ),
                            });
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
                    .map(ToolResult::Command)
            }
        };

        match execution {
            Ok(result) => {
                let (provider_output, exit_code) = result.into_output()?;
                let duration = elapsed_millis(started_at)?;
                let completed_item = self.finish_item(
                    &workspace,
                    ActivityStatus::Completed,
                    Some(provider_output.clone()),
                    exit_code,
                    Some(duration),
                );
                Ok(ToolExecutionResult {
                    provider_output,
                    completed_item,
                })
            }
            Err(error) => Err(error),
        }
    }

    fn finish_item(
        &self,
        workspace: &Path,
        status: ActivityStatus,
        output: Option<String>,
        exit_code: Option<i32>,
        duration_ms: Option<u64>,
    ) -> ThreadItem {
        match &self.operation {
            ToolOperation::ExecCommand(args) => ThreadItem::CommandExecution {
                id: self.item_id.clone(),
                command: args.command.clone(),
                cwd: display_workspace_path(workspace, &args.cwd),
                process_id: None,
                source: CommandSource::Agent,
                status,
                aggregated_output: output,
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
            _ => ThreadItem::ToolExecution {
                id: self.item_id.clone(),
                name: self.name.into(),
                description: self.description.clone(),
                status,
                output,
            },
        }
    }
}

enum ToolResult {
    Text(String),
    Command(CommandOutput),
}

impl ToolResult {
    fn into_output(self) -> Result<(String, Option<i32>), AppError> {
        let (output, exit_code) = match self {
            Self::Text(output) => (output, None),
            Self::Command(output) => {
                let text = format!(
                    "exit_code: {}\nstdout:\n{}\nstderr:\n{}",
                    output.exit_code, output.stdout, output.stderr
                );
                (text, Some(output.exit_code))
            }
        };
        if output.len() > MAX_TOOL_OUTPUT_BYTES {
            return Err(AppError::Tool(format!(
                "tool output exceeds {MAX_TOOL_OUTPUT_BYTES} bytes"
            )));
        }
        Ok((output, exit_code))
    }
}

struct CommandOutput {
    exit_code: i32,
    stdout: String,
    stderr: String,
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
            collect_search_files(&root, MAX_LIST_DEPTH, &mut files)?;
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
                        truncate_utf8(line, 500)
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
    if args.old_text.is_empty() || args.expected_occurrences == 0 || args.expected_occurrences > 100
    {
        return Err(AppError::Tool(
            "edit_file requires an exact non-empty match count from 1 to 100".into(),
        ));
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
    if args.reason.trim().is_empty() || args.reason.len() > 1_024 {
        return Err(AppError::Tool(
            "command reason must contain between 1 and 1024 bytes".into(),
        ));
    }
    let cwd = resolve_existing_directory(workspace, &args.cwd).await?;
    let mut command = shell_command(&args.command);
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
    let mut stdout_task = tokio::spawn(read_stream_bounded(stdout, MAX_COMMAND_OUTPUT_BYTES / 2));
    let mut stderr_task = tokio::spawn(read_stream_bounded(stderr, MAX_COMMAND_OUTPUT_BYTES / 2));
    let mut stdout_output = None;
    let mut stderr_output = None;
    let deadline = Instant::now() + COMMAND_TIMEOUT;

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
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

async fn finish_capture_ref(
    task: &mut tokio::task::JoinHandle<Result<Vec<u8>, AppError>>,
    label: &str,
) -> Result<Vec<u8>, AppError> {
    task.await
        .map_err(|error| AppError::Tool(format!("{label} reader failed: {error}")))?
}

async fn finish_capture(
    task: tokio::task::JoinHandle<Result<Vec<u8>, AppError>>,
    label: &str,
) -> Result<Vec<u8>, AppError> {
    task.await
        .map_err(|error| AppError::Tool(format!("{label} reader failed: {error}")))?
}

async fn read_stream_bounded<R: AsyncRead + Unpin>(
    mut stream: R,
    maximum_bytes: usize,
) -> Result<Vec<u8>, AppError> {
    let mut output = Vec::new();
    let mut buffer = [0u8; 8_192];
    loop {
        let count = stream
            .read(&mut buffer)
            .await
            .map_err(|error| AppError::Tool(format!("could not read process output: {error}")))?;
        if count == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(count) > maximum_bytes {
            return Err(AppError::Tool(format!(
                "command output exceeds {maximum_bytes} bytes per stream"
            )));
        }
        output.extend_from_slice(&buffer[..count]);
    }
}

#[cfg(windows)]
async fn terminate_child(child: &mut tokio::process::Child) -> Result<(), AppError> {
    let Some(process_id) = child.id() else {
        return child.try_wait().map(|_| ()).map_err(|error| {
            AppError::Tool(format!("could not inspect command process: {error}"))
        });
    };
    let mut taskkill = Command::new("taskkill.exe");
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

#[cfg(windows)]
fn shell_command(command: &str) -> Command {
    let mut process = Command::new("powershell.exe");
    process.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        command,
    ]);
    process
}

#[cfg(not(windows))]
fn shell_command(command: &str) -> Command {
    let mut process = Command::new("sh");
    process.args(["-lc", command]);
    process
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
    if value.is_empty() || value.len() > 4_096 {
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

fn collect_search_files(
    directory: &Path,
    remaining_depth: usize,
    output: &mut Vec<PathBuf>,
) -> Result<(), AppError> {
    if remaining_depth == 0 {
        return Err(AppError::Tool(format!(
            "search traversal exceeds {MAX_LIST_DEPTH} directory levels"
        )));
    }
    let entries =
        std::fs::read_dir(directory).map_err(|error| AppError::FileSystem(error.to_string()))?;
    for entry in entries {
        if output.len() >= MAX_SEARCH_FILES {
            return Err(AppError::Tool(format!(
                "search traversal exceeds {MAX_SEARCH_FILES} files"
            )));
        }
        let entry = entry.map_err(|error| AppError::FileSystem(error.to_string()))?;
        let file_type = entry
            .file_type()
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
        if file_type.is_symlink() || ignored_directory(&entry.file_name()) {
            continue;
        }
        if file_type.is_dir() {
            collect_search_files(&entry.path(), remaining_depth - 1, output)?;
        } else if file_type.is_file() {
            output.push(entry.path());
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

fn validate_identifier(label: &str, value: &str) -> Result<(), AppError> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(AppError::Tool(format!("{label} is invalid")));
    }
    Ok(())
}

fn diff_preview(old: &str, new: &str) -> String {
    truncate_utf8(
        &format!("--- before\n+++ after\n-{}\n+{}", old, new),
        MAX_DIFF_BYTES,
    )
}

fn truncate_utf8(value: &str, maximum_bytes: usize) -> String {
    if value.len() <= maximum_bytes {
        return value.to_string();
    }
    let mut end = maximum_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[truncated]", &value[..end])
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

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::{ToolRegistry, atomic_write, resolve_write_target};

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
