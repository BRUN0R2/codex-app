use std::path::Path;

use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::attachments::{AttachmentKind, inspect_path};
use crate::engine::{
    AccountProfileResponse, AccountRateLimitsResponse, AccountReadResponse, CancelLoginResponse,
    ChatModelListResponse, ConfigReadResponse, ConfigUpdate, ConfigUpdateResponse,
    ConversationMode, EngineManager, EngineStartResponse, LoginResponse, LogoutResponse,
    ModelListResponse, OperationAck, ReasoningEffort, ServerResponse, StartTurn, SteerTurn,
    ThreadCompactStartResponse, ThreadForkResponse, ThreadListResponse, ThreadReadResponse,
    ThreadResumeResponse, ThreadStartResponse, ThreadUnarchiveResponse, TurnInput,
    TurnStartResponse,
};
use crate::error::{AppError, CommandError, CommandResult};

const MAX_PROTOCOL_ID_BYTES: usize = 256;
const MAX_MODEL_NAME_BYTES: usize = 256;
const MAX_TIMEZONE_BYTES: usize = 128;
const MAX_TURN_TEXT_BYTES: usize = 1_048_576;
const MAX_TURN_ATTACHMENTS: usize = 12;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadStartRequest {
    project_path: Option<String>,
    mode: ConversationMode,
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
pub struct ThreadReadRequest {
    thread_id: String,
    cursor: Option<String>,
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
    timezone: String,
    timezone_offset_min: i32,
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
pub async fn engine_account_profile_read(
    app: AppHandle,
    engine: State<'_, EngineManager>,
) -> CommandResult<AccountProfileResponse> {
    engine.account_profile_read(&app).await.map_err(Into::into)
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
    let project_path = match request.project_path {
        Some(path) => Some(validate_workspace(&path).await?),
        None => None,
    };
    engine
        .thread_start(&app, project_path, request.mode)
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
    request: ThreadReadRequest,
) -> CommandResult<ThreadReadResponse> {
    validate_protocol_id("thread id", &request.thread_id)?;
    engine
        .thread_read(request.thread_id, request.cursor)
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
    let timezone = validate_timezone(request.timezone)?;
    if !(-840..=840).contains(&request.timezone_offset_min) {
        return Err(AppError::Protocol(
            "timezone offset must be between -840 and 840 minutes".into(),
        )
        .into());
    }
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
                timezone,
                timezone_offset_min: request.timezone_offset_min,
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
pub async fn engine_chat_model_list(
    app: AppHandle,
    engine: State<'_, EngineManager>,
) -> CommandResult<ChatModelListResponse> {
    engine.chat_model_list(&app).await.map_err(Into::into)
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

fn validate_timezone(value: String) -> CommandResult<String> {
    let value = value.trim().to_string();
    if value.is_empty()
        || value.len() > MAX_TIMEZONE_BYTES
        || value.chars().any(|character| {
            character.is_control()
                || !(character.is_ascii_alphanumeric()
                    || matches!(character, '/' | '_' | '-' | '+'))
        })
    {
        return Err(AppError::Protocol("timezone is invalid".into()).into());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{ThreadStartRequest, TurnServiceTierSelection};

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
    fn thread_start_request_accepts_an_explicit_projectless_target() {
        let request: ThreadStartRequest = serde_json::from_value(json!({
            "mode": "chat",
            "projectPath": null
        }))
        .expect("projectless request should decode");

        assert_eq!(request.project_path, None);
        assert_eq!(request.mode, crate::engine::ConversationMode::Chat);
    }
}
