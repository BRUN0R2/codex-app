use std::path::Path;

use serde::Deserialize;
use serde_json::Value;
use tauri::AppHandle;
use tauri::State;

use crate::attachments::AttachmentKind;
use crate::attachments::inspect_path;
use crate::engine::EngineConfigEdit;
use crate::engine::EngineManager;
use crate::engine::EngineOperation;
use crate::engine::EngineReasoningEffort;
use crate::engine::EngineStartResponse;
use crate::engine::EngineTurnInput;
use crate::engine::EngineWindowsSandboxSetupMode;
use crate::error::AppError;
use crate::error::CommandResult;

const MAX_PROTOCOL_ID_LENGTH: usize = 256;
const MAX_MODEL_NAME_LENGTH: usize = 256;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartRequest {
    pub cwd: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListRequest {
    pub cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadResumeRequest {
    pub thread_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadReadRequest {
    pub thread_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadForkBeforeTurnRequest {
    pub thread_id: String,
    pub before_turn_id: String,
    pub model: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSetNameRequest {
    pub thread_id: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadArchiveRequest {
    pub thread_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnAttachment {
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartRequest {
    pub thread_id: String,
    pub client_user_message_id: String,
    pub text: String,
    pub attachments: Vec<TurnAttachment>,
    pub model: Option<String>,
    pub effort: Option<ReasoningEffort>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    #[serde(rename = "xhigh")]
    XHigh,
}

impl From<ReasoningEffort> for EngineReasoningEffort {
    fn from(value: ReasoningEffort) -> Self {
        match value {
            ReasoningEffort::None => Self::None,
            ReasoningEffort::Minimal => Self::Minimal,
            ReasoningEffort::Low => Self::Low,
            ReasoningEffort::Medium => Self::Medium,
            ReasoningEffort::High => Self::High,
            ReasoningEffort::XHigh => Self::XHigh,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnInterruptRequest {
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigReadRequest {
    pub include_layers: bool,
    pub cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigWriteRequest {
    pub key_path: String,
    pub value: Value,
    pub merge_strategy: MergeStrategy,
    pub expected_version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowsSandboxSetupMode {
    Elevated,
    Unelevated,
}

impl From<WindowsSandboxSetupMode> for EngineWindowsSandboxSetupMode {
    fn from(value: WindowsSandboxSetupMode) -> Self {
        match value {
            WindowsSandboxSetupMode::Elevated => Self::Elevated,
            WindowsSandboxSetupMode::Unelevated => Self::Unelevated,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsSandboxSetupRequest {
    pub mode: WindowsSandboxSetupMode,
    pub cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEditRequest {
    pub key_path: String,
    pub value: Value,
    pub merge_strategy: MergeStrategy,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBatchWriteRequest {
    pub edits: Vec<ConfigEditRequest>,
    pub expected_version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeStrategy {
    Replace,
    Upsert,
}

impl MergeStrategy {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Replace => "replace",
            Self::Upsert => "upsert",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerResponseRequest {
    pub id: Value,
    pub response: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelLoginRequest {
    pub login_id: String,
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
) -> CommandResult<Value> {
    engine
        .execute(&app, EngineOperation::AccountRead)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_account_rate_limits_read(
    app: AppHandle,
    engine: State<'_, EngineManager>,
) -> CommandResult<Value> {
    engine
        .execute(&app, EngineOperation::ReadAccountRateLimits)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_login_chatgpt(
    app: AppHandle,
    engine: State<'_, EngineManager>,
) -> CommandResult<Value> {
    engine
        .execute(&app, EngineOperation::LoginChatGpt)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_login_cancel(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: CancelLoginRequest,
) -> CommandResult<Value> {
    if request.login_id.trim().is_empty() {
        return Err(AppError::Protocol("login id cannot be empty".into()).into());
    }
    engine
        .execute(
            &app,
            EngineOperation::CancelLogin {
                login_id: request.login_id,
            },
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_logout(
    app: AppHandle,
    engine: State<'_, EngineManager>,
) -> CommandResult<Value> {
    engine
        .execute(&app, EngineOperation::Logout)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_thread_start(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: ThreadStartRequest,
) -> CommandResult<Value> {
    validate_workspace(&request.cwd)
        .await
        .map_err(CommandError::from)?;
    engine
        .execute(&app, EngineOperation::StartThread { cwd: request.cwd })
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_thread_list(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: ThreadListRequest,
) -> CommandResult<Value> {
    if request.cursor.as_deref().is_some_and(str::is_empty) {
        return Err(AppError::Protocol("thread cursor cannot be empty".into()).into());
    }
    engine
        .execute(
            &app,
            EngineOperation::ListThreads {
                cursor: request.cursor,
            },
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_thread_resume(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: ThreadResumeRequest,
) -> CommandResult<Value> {
    validate_thread_id(&request.thread_id)?;
    engine
        .execute(
            &app,
            EngineOperation::ResumeThread {
                thread_id: request.thread_id,
            },
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_thread_read(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: ThreadReadRequest,
) -> CommandResult<Value> {
    validate_thread_id(&request.thread_id)?;
    engine
        .execute(
            &app,
            EngineOperation::ReadThread {
                thread_id: request.thread_id,
            },
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_thread_fork(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: ThreadForkBeforeTurnRequest,
) -> CommandResult<Value> {
    validate_thread_id(&request.thread_id)?;
    validate_turn_id(&request.before_turn_id)?;
    let model = validate_model_name(request.model)?;
    engine
        .execute(
            &app,
            EngineOperation::ForkThreadBeforeTurn {
                thread_id: request.thread_id,
                before_turn_id: request.before_turn_id,
                model,
            },
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_thread_set_name(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: ThreadSetNameRequest,
) -> CommandResult<Value> {
    validate_thread_id(&request.thread_id)?;
    let name = request.name.trim();
    if name.is_empty() {
        return Err(AppError::Protocol("thread name cannot be empty".into()).into());
    }
    engine
        .execute(
            &app,
            EngineOperation::SetThreadName {
                thread_id: request.thread_id,
                name: name.to_string(),
            },
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_thread_archive(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: ThreadArchiveRequest,
) -> CommandResult<Value> {
    validate_thread_id(&request.thread_id)?;
    engine
        .execute(
            &app,
            EngineOperation::ArchiveThread {
                thread_id: request.thread_id,
            },
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_turn_start(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: TurnStartRequest,
) -> CommandResult<Value> {
    validate_thread_id(&request.thread_id)?;
    validate_protocol_id("client user message id", &request.client_user_message_id)?;
    let model = request.model.map(validate_model_name).transpose()?;
    let mut input = Vec::with_capacity(request.attachments.len() + 1);
    let text = request.text.trim();
    if !text.is_empty() {
        input.push(EngineTurnInput::Text(text.to_string()));
    }

    for reference in request.attachments {
        let attachment = inspect_path(&reference.path)
            .await
            .map_err(CommandError::from)?;
        match attachment.kind {
            AttachmentKind::Image => input.push(EngineTurnInput::LocalImage {
                path: attachment.path,
            }),
            AttachmentKind::File => input.push(EngineTurnInput::Mention {
                name: attachment.name,
                path: attachment.path,
            }),
        }
    }

    if input.is_empty() {
        return Err(AppError::Protocol("a turn requires text or an attachment".into()).into());
    }

    engine
        .execute(
            &app,
            EngineOperation::StartTurn {
                thread_id: request.thread_id,
                client_user_message_id: request.client_user_message_id,
                input,
                model,
                effort: request.effort.map(Into::into),
            },
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_turn_interrupt(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: TurnInterruptRequest,
) -> CommandResult<Value> {
    validate_thread_id(&request.thread_id)?;
    validate_turn_id(&request.turn_id)?;
    engine
        .execute(
            &app,
            EngineOperation::InterruptTurn {
                thread_id: request.thread_id,
                turn_id: request.turn_id,
            },
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_config_read(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: ConfigReadRequest,
) -> CommandResult<Value> {
    engine
        .execute(
            &app,
            EngineOperation::ReadConfig {
                include_layers: request.include_layers,
                cwd: request.cwd,
            },
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_config_requirements_read(
    app: AppHandle,
    engine: State<'_, EngineManager>,
) -> CommandResult<Value> {
    engine
        .execute(&app, EngineOperation::ReadConfigRequirements)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_windows_sandbox_readiness(
    app: AppHandle,
    engine: State<'_, EngineManager>,
) -> CommandResult<Value> {
    engine
        .execute(&app, EngineOperation::ReadWindowsSandboxReadiness)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_windows_sandbox_setup_start(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: WindowsSandboxSetupRequest,
) -> CommandResult<Value> {
    if request
        .cwd
        .as_deref()
        .is_some_and(|cwd| cwd.trim().is_empty() || !Path::new(cwd).is_absolute())
    {
        return Err(AppError::Protocol("sandbox setup cwd must be absolute".into()).into());
    }
    engine
        .execute(
            &app,
            EngineOperation::StartWindowsSandboxSetup {
                mode: request.mode.into(),
                cwd: request.cwd,
            },
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_config_write(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: ConfigWriteRequest,
) -> CommandResult<Value> {
    if request.key_path.trim().is_empty() {
        return Err(AppError::Protocol("config key path cannot be empty".into()).into());
    }
    engine
        .execute(
            &app,
            EngineOperation::WriteConfig {
                edit: EngineConfigEdit {
                    key_path: request.key_path,
                    value: request.value,
                    merge_strategy: request.merge_strategy.as_str(),
                },
                expected_version: request.expected_version,
            },
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_config_batch_write(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: ConfigBatchWriteRequest,
) -> CommandResult<Value> {
    if request.edits.is_empty() {
        return Err(AppError::Protocol("config batch cannot be empty".into()).into());
    }
    if request
        .edits
        .iter()
        .any(|edit| edit.key_path.trim().is_empty())
    {
        return Err(AppError::Protocol("config key path cannot be empty".into()).into());
    }

    let expected_version = request.expected_version;
    let edits = request
        .edits
        .into_iter()
        .map(|edit| EngineConfigEdit {
            key_path: edit.key_path,
            value: edit.value,
            merge_strategy: edit.merge_strategy.as_str(),
        })
        .collect::<Vec<_>>();

    engine
        .execute(
            &app,
            EngineOperation::BatchWriteConfig {
                edits,
                expected_version,
            },
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_model_list(
    app: AppHandle,
    engine: State<'_, EngineManager>,
) -> CommandResult<Value> {
    engine
        .execute(&app, EngineOperation::ListModels)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_server_request_respond(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: ServerResponseRequest,
) -> CommandResult<()> {
    engine
        .respond(&app, request.id, request.response)
        .await
        .map_err(Into::into)
}

async fn validate_workspace(path: &str) -> Result<(), AppError> {
    if !Path::new(path).is_absolute() {
        return Err(AppError::FileSystem(
            "workspace path must be absolute".into(),
        ));
    }
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if !metadata.is_dir() {
        return Err(AppError::FileSystem(
            "workspace path is not a directory".into(),
        ));
    }
    Ok(())
}

fn validate_thread_id(thread_id: &str) -> Result<(), AppError> {
    validate_protocol_id("thread id", thread_id)
}

fn validate_turn_id(turn_id: &str) -> Result<(), AppError> {
    validate_protocol_id("turn id", turn_id)
}

fn validate_protocol_id(label: &str, value: &str) -> Result<(), AppError> {
    if value.trim().is_empty() {
        return Err(AppError::Protocol(format!("{label} cannot be empty")));
    }
    if value.len() > MAX_PROTOCOL_ID_LENGTH {
        return Err(AppError::Protocol(format!(
            "{label} exceeds {MAX_PROTOCOL_ID_LENGTH} bytes"
        )));
    }
    Ok(())
}

fn validate_model_name(model: String) -> Result<String, AppError> {
    let model = model.trim();
    if model.is_empty() {
        return Err(AppError::Protocol("model cannot be empty".into()));
    }
    if model.len() > MAX_MODEL_NAME_LENGTH {
        return Err(AppError::Protocol(format!(
            "model exceeds {MAX_MODEL_NAME_LENGTH} bytes"
        )));
    }
    Ok(model.to_string())
}

use crate::error::CommandError;
