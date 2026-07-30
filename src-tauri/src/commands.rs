use std::path::Path;

use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use tauri::AppHandle;
use tauri::State;

use crate::attachments::AttachmentKind;
use crate::attachments::inspect_path;
use crate::codex::CodexRuntime;
use crate::codex::RuntimeStartResponse;
use crate::error::AppError;
use crate::error::CommandResult;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartRequest {
    pub cwd: String,
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBatchWriteRequest {
    pub edits: Vec<ConfigWriteRequest>,
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

#[tauri::command]
pub async fn codex_runtime_start(
    app: AppHandle,
    runtime: State<'_, CodexRuntime>,
) -> CommandResult<RuntimeStartResponse> {
    runtime.start(&app).await.map_err(Into::into)
}

#[tauri::command]
pub async fn codex_account_read(
    app: AppHandle,
    runtime: State<'_, CodexRuntime>,
) -> CommandResult<Value> {
    runtime
        .request(&app, "account/read", Some(json!({ "refreshToken": false })))
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_login_chatgpt(
    app: AppHandle,
    runtime: State<'_, CodexRuntime>,
) -> CommandResult<Value> {
    runtime
        .request(
            &app,
            "account/login/start",
            Some(json!({
                "type": "chatgpt",
                "useHostedLoginSuccessPage": true,
                "appBrand": "codex"
            })),
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_logout(
    app: AppHandle,
    runtime: State<'_, CodexRuntime>,
) -> CommandResult<Value> {
    runtime
        .request(&app, "account/logout", None)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_thread_start(
    app: AppHandle,
    runtime: State<'_, CodexRuntime>,
    request: ThreadStartRequest,
) -> CommandResult<Value> {
    validate_workspace(&request.cwd)
        .await
        .map_err(CommandError::from)?;
    runtime
        .request(
            &app,
            "thread/start",
            Some(json!({
                "cwd": request.cwd,
                "serviceName": "codex_desktop_next"
            })),
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_turn_start(
    app: AppHandle,
    runtime: State<'_, CodexRuntime>,
    request: TurnStartRequest,
) -> CommandResult<Value> {
    let mut input = Vec::with_capacity(request.attachments.len() + 1);
    let text = request.text.trim();
    if !text.is_empty() {
        input.push(json!({ "type": "text", "text": text }));
    }

    for reference in request.attachments {
        let attachment = inspect_path(&reference.path)
            .await
            .map_err(CommandError::from)?;
        match attachment.kind {
            AttachmentKind::Image => input.push(json!({
                "type": "localImage",
                "path": attachment.path
            })),
            AttachmentKind::File => input.push(json!({
                "type": "mention",
                "name": attachment.name,
                "path": attachment.path
            })),
        }
    }

    if input.is_empty() {
        return Err(AppError::Protocol("a turn requires text or an attachment".into()).into());
    }

    runtime
        .request(
            &app,
            "turn/start",
            Some(json!({
                "threadId": request.thread_id,
                "clientUserMessageId": request.client_user_message_id,
                "input": input
            })),
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_turn_interrupt(
    app: AppHandle,
    runtime: State<'_, CodexRuntime>,
    request: TurnInterruptRequest,
) -> CommandResult<Value> {
    runtime
        .request(
            &app,
            "turn/interrupt",
            Some(json!({
                "threadId": request.thread_id,
                "turnId": request.turn_id
            })),
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_config_read(
    app: AppHandle,
    runtime: State<'_, CodexRuntime>,
    request: ConfigReadRequest,
) -> CommandResult<Value> {
    let mut params = json!({ "includeLayers": request.include_layers });
    if let Some(cwd) = request.cwd {
        params["cwd"] = Value::String(cwd);
    }
    runtime
        .request(&app, "config/read", Some(params))
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_config_write(
    app: AppHandle,
    runtime: State<'_, CodexRuntime>,
    request: ConfigWriteRequest,
) -> CommandResult<Value> {
    if request.key_path.trim().is_empty() {
        return Err(AppError::Protocol("config key path cannot be empty".into()).into());
    }
    runtime
        .request(
            &app,
            "config/value/write",
            Some(json!({
                "keyPath": request.key_path,
                "value": request.value,
                "mergeStrategy": request.merge_strategy.as_str()
            })),
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_config_batch_write(
    app: AppHandle,
    runtime: State<'_, CodexRuntime>,
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

    let edits = request
        .edits
        .into_iter()
        .map(|edit| {
            json!({
                "keyPath": edit.key_path,
                "value": edit.value,
                "mergeStrategy": edit.merge_strategy.as_str()
            })
        })
        .collect::<Vec<_>>();

    runtime
        .request(
            &app,
            "config/batchWrite",
            Some(json!({
                "edits": edits,
                "reloadUserConfig": false
            })),
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_model_list(
    app: AppHandle,
    runtime: State<'_, CodexRuntime>,
) -> CommandResult<Value> {
    runtime
        .request(&app, "model/list", Some(json!({ "limit": 100 })))
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn codex_server_request_respond(
    app: AppHandle,
    runtime: State<'_, CodexRuntime>,
    request: ServerResponseRequest,
) -> CommandResult<()> {
    runtime
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

use crate::error::CommandError;
