use std::path::Path;
use std::process::{Output, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::process::Command;
use tokio::time::timeout;

use crate::attachments::{AttachmentKind, inspect_path};
use crate::engine::{
    AccountRateLimitsResponse, AccountReadResponse, CancelLoginResponse, ConfigReadResponse,
    ConfigUpdate, ConfigUpdateResponse, EngineManager, EngineStartResponse, LoginResponse,
    LogoutResponse, ModelListResponse, OperationAck, ReasoningEffort, ServerResponse, StartTurn,
    SteerTurn, ThreadCompactStartResponse, ThreadForkResponse, ThreadListResponse,
    ThreadReadResponse, ThreadResumeResponse, ThreadStartResponse, ThreadUnarchiveResponse,
    TurnInput, TurnStartResponse,
};
use crate::error::{AppError, CommandError, CommandResult};

const MAX_PROTOCOL_ID_BYTES: usize = 256;
const MAX_MODEL_NAME_BYTES: usize = 256;
const MAX_TURN_TEXT_BYTES: usize = 1_048_576;
const MAX_TURN_ATTACHMENTS: usize = 12;
const MAX_GIT_REFERENCE_BYTES: usize = 256;
const MAX_GIT_PATH_BYTES: usize = 4_096;
const MAX_GIT_STATUS_BYTES: usize = 524_288;
const MAX_WORKSPACE_CHANGES: usize = 512;
const GIT_INSPECTION_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadStartRequest {
    cwd: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRequest {
    cwd: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WorkspaceRepository {
    None,
    GitBranch {
        branch: String,
        changes: Vec<WorkspaceChange>,
    },
    GitDetached {
        revision: String,
        changes: Vec<WorkspaceChange>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChange {
    status: String,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadListRequest {
    cursor: Option<String>,
    archived: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadIdRequest {
    thread_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadSetNameRequest {
    thread_id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnAttachment {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnStartRequest {
    thread_id: String,
    client_user_message_id: String,
    text: String,
    attachments: Vec<TurnAttachment>,
    model: Option<String>,
    effort: Option<ReasoningEffort>,
    service_tier: TurnServiceTierSelection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnSteerRequest {
    thread_id: String,
    expected_turn_id: String,
    client_user_message_id: String,
    text: String,
    attachments: Vec<TurnAttachment>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum TurnServiceTierSelection {
    Default,
    Tier { id: String },
}

impl TurnServiceTierSelection {
    fn into_option(self) -> Option<String> {
        match self {
            Self::Default => None,
            Self::Tier { id } => Some(id),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnInterruptRequest {
    thread_id: String,
    turn_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigUpdateRequest {
    expected_version: u64,
    update: ConfigUpdate,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerResponseRequest {
    id: String,
    response: ServerResponse,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelLoginRequest {
    login_id: String,
}

#[tauri::command]
pub async fn engine_start(
    app: AppHandle,
    engine: State<'_, EngineManager>,
) -> CommandResult<EngineStartResponse> {
    engine.start(&app).await.map_err(Into::into)
}

#[tauri::command]
pub async fn engine_account_read(
    app: AppHandle,
    engine: State<'_, EngineManager>,
) -> CommandResult<AccountReadResponse> {
    engine.account_read(&app).await.map_err(Into::into)
}

#[tauri::command]
pub async fn engine_account_rate_limits_read(
    app: AppHandle,
    engine: State<'_, EngineManager>,
) -> CommandResult<AccountRateLimitsResponse> {
    engine
        .account_rate_limits_read(&app)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_login_chatgpt(
    app: AppHandle,
    engine: State<'_, EngineManager>,
) -> CommandResult<LoginResponse> {
    engine.login_chatgpt(&app).await.map_err(Into::into)
}

#[tauri::command]
pub async fn engine_login_cancel(
    engine: State<'_, EngineManager>,
    request: CancelLoginRequest,
) -> CommandResult<CancelLoginResponse> {
    validate_protocol_id("login id", &request.login_id)?;
    Ok(engine.login_cancel(&request.login_id).await)
}

#[tauri::command]
pub async fn engine_logout(
    app: AppHandle,
    engine: State<'_, EngineManager>,
) -> CommandResult<LogoutResponse> {
    engine.logout(&app).await.map_err(Into::into)
}

#[tauri::command]
pub async fn engine_thread_start(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: ThreadStartRequest,
) -> CommandResult<ThreadStartResponse> {
    let cwd = validate_workspace(&request.cwd).await?;
    engine.thread_start(&app, cwd).await.map_err(Into::into)
}

#[tauri::command]
pub async fn workspace_repository_read(
    request: WorkspaceRequest,
) -> CommandResult<WorkspaceRepository> {
    let cwd = validate_workspace(&request.cwd).await?;
    inspect_workspace_repository(Path::new(&cwd))
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_thread_list(
    engine: State<'_, EngineManager>,
    request: ThreadListRequest,
) -> CommandResult<ThreadListResponse> {
    engine
        .thread_list(request.cursor, request.archived)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_thread_resume(
    engine: State<'_, EngineManager>,
    request: ThreadIdRequest,
) -> CommandResult<ThreadResumeResponse> {
    validate_protocol_id("thread id", &request.thread_id)?;
    engine
        .thread_resume(request.thread_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_thread_read(
    engine: State<'_, EngineManager>,
    request: ThreadIdRequest,
) -> CommandResult<ThreadReadResponse> {
    validate_protocol_id("thread id", &request.thread_id)?;
    engine
        .thread_read(request.thread_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_thread_set_name(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: ThreadSetNameRequest,
) -> CommandResult<OperationAck> {
    validate_protocol_id("thread id", &request.thread_id)?;
    let name = request.name.trim();
    if name.is_empty() {
        return Err(AppError::Protocol("thread name cannot be empty".into()).into());
    }
    engine
        .thread_set_name(&app, request.thread_id, name.into())
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_thread_archive(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: ThreadIdRequest,
) -> CommandResult<OperationAck> {
    validate_protocol_id("thread id", &request.thread_id)?;
    engine
        .thread_archive(&app, request.thread_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_thread_unarchive(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: ThreadIdRequest,
) -> CommandResult<ThreadUnarchiveResponse> {
    validate_protocol_id("thread id", &request.thread_id)?;
    engine
        .thread_unarchive(&app, request.thread_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_thread_delete(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: ThreadIdRequest,
) -> CommandResult<OperationAck> {
    validate_protocol_id("thread id", &request.thread_id)?;
    engine
        .thread_delete(&app, request.thread_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_thread_fork(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: ThreadIdRequest,
) -> CommandResult<ThreadForkResponse> {
    validate_protocol_id("thread id", &request.thread_id)?;
    engine
        .thread_fork(&app, request.thread_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_thread_compact_start(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: ThreadIdRequest,
) -> CommandResult<ThreadCompactStartResponse> {
    validate_protocol_id("thread id", &request.thread_id)?;
    engine
        .thread_compact_start(&app, request.thread_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_turn_start(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: TurnStartRequest,
) -> CommandResult<TurnStartResponse> {
    validate_protocol_id("thread id", &request.thread_id)?;
    validate_protocol_id("client user message id", &request.client_user_message_id)?;
    let model = request.model.map(validate_model_name).transpose()?;
    let input = decode_turn_input(request.text, request.attachments).await?;
    engine
        .turn_start(
            &app,
            StartTurn {
                thread_id: request.thread_id,
                client_user_message_id: request.client_user_message_id,
                input,
                model,
                effort: request.effort,
                service_tier: request.service_tier.into_option(),
            },
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_turn_steer(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: TurnSteerRequest,
) -> CommandResult<OperationAck> {
    validate_protocol_id("thread id", &request.thread_id)?;
    validate_protocol_id("expected turn id", &request.expected_turn_id)?;
    validate_protocol_id("client user message id", &request.client_user_message_id)?;
    let input = decode_turn_input(request.text, request.attachments).await?;
    engine
        .turn_steer(
            &app,
            SteerTurn {
                thread_id: request.thread_id,
                expected_turn_id: request.expected_turn_id,
                client_user_message_id: request.client_user_message_id,
                input,
            },
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_turn_interrupt(
    engine: State<'_, EngineManager>,
    request: TurnInterruptRequest,
) -> CommandResult<OperationAck> {
    validate_protocol_id("thread id", &request.thread_id)?;
    validate_protocol_id("turn id", &request.turn_id)?;
    engine
        .turn_interrupt(request.thread_id, request.turn_id)
        .await
        .map_err(Into::into)
}

async fn decode_turn_input(
    text: String,
    attachments: Vec<TurnAttachment>,
) -> CommandResult<Vec<TurnInput>> {
    if text.len() > MAX_TURN_TEXT_BYTES {
        return Err(
            AppError::Protocol(format!("turn text exceeds {MAX_TURN_TEXT_BYTES} bytes")).into(),
        );
    }
    if attachments.len() > MAX_TURN_ATTACHMENTS {
        return Err(AppError::InvalidAttachment(format!(
            "a turn accepts at most {MAX_TURN_ATTACHMENTS} attachments"
        ))
        .into());
    }
    let mut input = Vec::with_capacity(attachments.len() + 1);
    if !text.trim().is_empty() {
        input.push(TurnInput::Text(text));
    }
    for attachment in attachments {
        let attachment = inspect_path(&attachment.path)
            .await
            .map_err(CommandError::from)?;
        match attachment.kind {
            AttachmentKind::Image => input.push(TurnInput::LocalImage {
                path: attachment.path,
            }),
            AttachmentKind::File => input.push(TurnInput::Mention {
                name: attachment.name,
                path: attachment.path,
            }),
        }
    }
    if input.is_empty() {
        return Err(
            AppError::Protocol("a turn requires text or at least one attachment".into()).into(),
        );
    }
    Ok(input)
}

#[tauri::command]
pub async fn engine_config_read(
    engine: State<'_, EngineManager>,
) -> CommandResult<ConfigReadResponse> {
    engine.config_read().await.map_err(Into::into)
}

#[tauri::command]
pub async fn engine_config_update(
    engine: State<'_, EngineManager>,
    request: ConfigUpdateRequest,
) -> CommandResult<ConfigUpdateResponse> {
    engine
        .config_update(request.expected_version, request.update)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_model_list(
    app: AppHandle,
    engine: State<'_, EngineManager>,
) -> CommandResult<ModelListResponse> {
    engine.model_list(&app).await.map_err(Into::into)
}

#[tauri::command]
pub async fn engine_server_request_respond(
    engine: State<'_, EngineManager>,
    request: ServerResponseRequest,
) -> CommandResult<OperationAck> {
    validate_protocol_id("server request id", &request.id)?;
    engine
        .server_request_respond(request.id, request.response)
        .await
        .map_err(Into::into)
}

async fn validate_workspace(value: &str) -> CommandResult<String> {
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(AppError::FileSystem("workspace path must be absolute".into()).into());
    }
    let canonical = tokio::fs::canonicalize(path)
        .await
        .map_err(|error| CommandError::from(AppError::FileSystem(error.to_string())))?;
    let metadata = tokio::fs::metadata(&canonical)
        .await
        .map_err(|error| CommandError::from(AppError::FileSystem(error.to_string())))?;
    if !metadata.is_dir() {
        return Err(AppError::FileSystem("workspace path is not a directory".into()).into());
    }
    Ok(normalize_windows_canonical_path(
        &canonical.to_string_lossy(),
    ))
}

async fn inspect_workspace_repository(cwd: &Path) -> Result<WorkspaceRepository, AppError> {
    let branch = run_git(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await?;
    if branch.status.success() {
        return Ok(WorkspaceRepository::GitBranch {
            branch: decode_git_reference(branch, "Git branch")?,
            changes: inspect_workspace_changes(cwd).await?,
        });
    }

    let revision = run_git(cwd, &["rev-parse", "--verify", "--short=12", "HEAD"]).await?;
    if revision.status.success() {
        return Ok(WorkspaceRepository::GitDetached {
            revision: decode_git_reference(revision, "Git revision")?,
            changes: inspect_workspace_changes(cwd).await?,
        });
    }

    Ok(WorkspaceRepository::None)
}

async fn inspect_workspace_changes(cwd: &Path) -> Result<Vec<WorkspaceChange>, AppError> {
    let output = run_git(
        cwd,
        &["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
    )
    .await?;
    if !output.status.success() {
        return Err(AppError::FileSystem(
            "could not inspect Git workspace changes".into(),
        ));
    }
    decode_git_changes(output.stdout)
}

fn decode_git_changes(output: Vec<u8>) -> Result<Vec<WorkspaceChange>, AppError> {
    if output.len() > MAX_GIT_STATUS_BYTES {
        return Err(AppError::Protocol(format!(
            "Git status exceeds {MAX_GIT_STATUS_BYTES} bytes"
        )));
    }
    let mut fields = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut changes = Vec::new();
    while let Some(entry) = fields.next() {
        if changes.len() >= MAX_WORKSPACE_CHANGES {
            return Err(AppError::Protocol(format!(
                "Git status exceeds {MAX_WORKSPACE_CHANGES} changes"
            )));
        }
        if entry.len() < 4 || entry[2] != b' ' {
            return Err(AppError::Protocol(
                "Git status returned an invalid entry".into(),
            ));
        }
        let status = std::str::from_utf8(&entry[..2])
            .map_err(|_| AppError::Protocol("Git status code is not valid UTF-8".into()))?;
        if status.chars().any(char::is_control) {
            return Err(AppError::Protocol(
                "Git status code contains control characters".into(),
            ));
        }
        let path = std::str::from_utf8(&entry[3..])
            .map_err(|_| AppError::Protocol("Git path is not valid UTF-8".into()))?;
        if path.is_empty() || path.len() > MAX_GIT_PATH_BYTES || path.chars().any(char::is_control)
        {
            return Err(AppError::Protocol(
                "Git status returned an invalid path".into(),
            ));
        }
        changes.push(WorkspaceChange {
            status: status.to_owned(),
            path: path.to_owned(),
        });
        if matches!(entry[0], b'R' | b'C') || matches!(entry[1], b'R' | b'C') {
            fields.next().ok_or_else(|| {
                AppError::Protocol("Git rename status omitted its source path".into())
            })?;
        }
    }
    Ok(changes)
}

async fn run_git(cwd: &Path, arguments: &[&str]) -> Result<Output, AppError> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(cwd)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);

    timeout(GIT_INSPECTION_TIMEOUT, command.output())
        .await
        .map_err(|_| AppError::Timeout {
            operation: "Git workspace inspection",
        })?
        .map_err(|error| AppError::FileSystem(format!("could not inspect Git metadata: {error}")))
}

fn decode_git_reference(output: Output, label: &str) -> Result<String, AppError> {
    let value = String::from_utf8(output.stdout)
        .map_err(|_| AppError::Protocol(format!("{label} is not valid UTF-8")))?;
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_GIT_REFERENCE_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(AppError::Protocol(format!(
            "{label} must contain between 1 and {MAX_GIT_REFERENCE_BYTES} bytes without control characters"
        )));
    }
    Ok(value.to_owned())
}

fn normalize_windows_canonical_path(value: &str) -> String {
    if let Some(path) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{path}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(value).to_string()
    }
}

fn validate_protocol_id(label: &str, value: &str) -> CommandResult<()> {
    if value.trim().is_empty()
        || value.len() > MAX_PROTOCOL_ID_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(AppError::Protocol(format!(
            "{label} must contain between 1 and {MAX_PROTOCOL_ID_BYTES} bytes without control characters"
        ))
        .into());
    }
    Ok(())
}

fn validate_model_name(model: String) -> CommandResult<String> {
    let model = model.trim();
    if model.is_empty() || model.len() > MAX_MODEL_NAME_BYTES || model.chars().any(char::is_control)
    {
        return Err(AppError::Protocol(format!(
            "model must contain between 1 and {MAX_MODEL_NAME_BYTES} bytes"
        ))
        .into());
    }
    Ok(model.into())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{TurnServiceTierSelection, decode_git_changes};

    #[test]
    fn canonical_windows_prefix_is_not_exposed_to_the_ui() {
        assert_eq!(
            super::normalize_windows_canonical_path(r"\\?\C:\workspace"),
            r"C:\workspace"
        );
        assert_eq!(
            super::normalize_windows_canonical_path(r"\\?\UNC\server\share"),
            r"\\server\share"
        );
    }

    #[test]
    fn turn_service_tier_selection_distinguishes_default_from_a_tier() {
        let default: TurnServiceTierSelection =
            serde_json::from_value(json!({ "type": "default" })).expect("default should decode");
        let tier: TurnServiceTierSelection = serde_json::from_value(json!({
            "type": "tier",
            "id": "priority"
        }))
        .expect("tier should decode");

        assert_eq!(default.into_option(), None);
        assert_eq!(tier.into_option().as_deref(), Some("priority"));
    }

    #[test]
    fn git_status_parser_handles_regular_untracked_and_renamed_paths() {
        let changes = decode_git_changes(
            b" M src/ui/Timeline.tsx\0?? notes.txt\0R  new-name.ts\0old-name.ts\0".to_vec(),
        )
        .expect("Git status should decode");

        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].status, " M");
        assert_eq!(changes[0].path, "src/ui/Timeline.tsx");
        assert_eq!(changes[1].status, "??");
        assert_eq!(changes[2].path, "new-name.ts");
    }

    #[test]
    fn git_status_parser_rejects_truncated_rename_metadata() {
        assert!(decode_git_changes(b"R  new-name.ts\0".to_vec()).is_err());
    }
}
