use serde::Deserialize;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt as _;

use crate::attachments::{AttachmentKind, persist_attachment};
use crate::command_validation::{
    MAX_TURN_ATTACHMENTS, MAX_TURN_TEXT_BYTES, validate_diagnostic_message, validate_model_name,
    validate_protocol_id, validate_timezone, validate_workspace,
};
use crate::engine::{
    AccountProfileResponse, AccountRateLimitsResponse, AccountReadResponse,
    AutoTopUpSettingsSnapshot, Automation, AutomationListResponse, AutomationRun,
    CancelLoginResponse, ChatModelListResponse, ConfigUpdate, ConfigUpdateResponse,
    ConversationMode, CreateAutomation, EngineManager, EngineStartResponse, LoginResponse,
    LogoutResponse, ModelListResponse, OperationAck, OutputReadResponse, ReasoningEffort,
    RuntimeDiagnosticSubsystem, ServerResponse, StartTurn, SteerTurn, ThreadForkResponse,
    ThreadListResponse, ThreadReadResponse, ThreadResumeResponse, ThreadStartResponse,
    ThreadUnarchiveResponse, TurnInput, TurnStartResponse, UpdateAutomation,
    UsageResetCreditsResponse, UsageResetRedemptionResponse,
};
use crate::error::{AppError, CommandError, CommandResult};

const MIN_AUTOMATION_INTERVAL_MINUTES: u32 = 5;
const MAX_AUTOMATION_INTERVAL_MINUTES: u32 = 10_080;
const MAX_AUTOMATION_NAME_BYTES: usize = 160;
const MAX_AUTOMATION_PROMPT_BYTES: usize = 262_144;

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
pub struct OutputReadRequest {
    output_id: String,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenWorkspaceRequest {
    path: String,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageResetRedeemRequest {
    credit_id: Option<String>,
    redeem_request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutoTopUpSettingsRequest {
    recharge_threshold: String,
    recharge_target: String,
    recharge_monthly_limit: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDiagnosticRequest {
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationCreateRequest {
    name: String,
    prompt: String,
    project_path: Option<String>,
    enabled: bool,
    interval_minutes: u32,
    timezone: String,
    timezone_offset_min: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationUpdateRequest {
    id: String,
    expected_version: u64,
    name: String,
    prompt: String,
    project_path: Option<String>,
    enabled: bool,
    interval_minutes: u32,
    timezone: String,
    timezone_offset_min: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationIdRequest {
    automation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationRunIdRequest {
    run_id: String,
}

#[tauri::command]
pub async fn engine_start(
    app: AppHandle,
    engine: State<'_, EngineManager>,
) -> CommandResult<EngineStartResponse> {
    engine.start(&app).await.map_err(Into::into)
}

#[tauri::command]
pub fn engine_runtime_diagnostic_report(
    engine: State<'_, EngineManager>,
    request: RuntimeDiagnosticRequest,
) -> CommandResult<OperationAck> {
    let message = validate_diagnostic_message(request.message)?;
    engine
        .persist_runtime_error(RuntimeDiagnosticSubsystem::Frontend, &message)
        .map_err(CommandError::from)?;
    Ok(OperationAck { applied: true })
}

#[tauri::command]
pub async fn application_workspace_open(
    app: AppHandle,
    request: OpenWorkspaceRequest,
) -> CommandResult<OperationAck> {
    let workspace = validate_workspace(&request.path).await?;
    app.opener()
        .open_path(workspace, None::<&str>)
        .map_err(|error| {
            CommandError::from(AppError::FileSystem(format!(
                "could not open workspace directory: {error}"
            )))
        })?;
    Ok(OperationAck { applied: true })
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
pub async fn engine_account_usage_resets_read(
    app: AppHandle,
    engine: State<'_, EngineManager>,
) -> CommandResult<UsageResetCreditsResponse> {
    engine
        .account_usage_resets_read(&app)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_account_usage_reset_redeem(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: UsageResetRedeemRequest,
) -> CommandResult<UsageResetRedemptionResponse> {
    validate_protocol_id("redeem request id", &request.redeem_request_id)?;
    if let Some(credit_id) = request.credit_id.as_deref() {
        validate_protocol_id("usage reset credit id", credit_id)?;
    }
    engine
        .account_usage_reset_redeem(
            &app,
            request.credit_id.as_deref(),
            &request.redeem_request_id,
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_account_auto_top_up_read(
    app: AppHandle,
    engine: State<'_, EngineManager>,
) -> CommandResult<AutoTopUpSettingsSnapshot> {
    engine
        .account_auto_top_up_read(&app)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_account_auto_top_up_enable(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: AutoTopUpSettingsRequest,
) -> CommandResult<AutoTopUpSettingsSnapshot> {
    let (threshold, target, monthly_limit) = validate_auto_top_up_settings(request)?;
    engine
        .account_auto_top_up_enable(&app, &threshold, &target, monthly_limit.as_deref())
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_account_auto_top_up_update(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: AutoTopUpSettingsRequest,
) -> CommandResult<AutoTopUpSettingsSnapshot> {
    let (threshold, target, monthly_limit) = validate_auto_top_up_settings(request)?;
    engine
        .account_auto_top_up_update(&app, &threshold, &target, monthly_limit.as_deref())
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_account_auto_top_up_disable(
    app: AppHandle,
    engine: State<'_, EngineManager>,
) -> CommandResult<AutoTopUpSettingsSnapshot> {
    engine
        .account_auto_top_up_disable(&app)
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
pub async fn engine_output_read(
    engine: State<'_, EngineManager>,
    request: OutputReadRequest,
) -> CommandResult<OutputReadResponse> {
    validate_protocol_id("output id", &request.output_id)?;
    engine
        .output_read(request.output_id, request.cursor)
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
    let input = decode_turn_input(&app, request.text, request.attachments).await?;
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
    let input = decode_turn_input(&app, request.text, request.attachments).await?;
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

#[tauri::command]
pub async fn engine_automation_list(
    engine: State<'_, EngineManager>,
) -> CommandResult<AutomationListResponse> {
    engine.automation_list().await.map_err(Into::into)
}

#[tauri::command]
pub async fn engine_automation_create(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: AutomationCreateRequest,
) -> CommandResult<Automation> {
    let (name, prompt) = validate_automation_content(request.name, request.prompt)?;
    let project_path = match request.project_path {
        Some(path) => Some(validate_workspace(&path).await?),
        None => None,
    };
    let timezone = validate_timezone(request.timezone)?;
    validate_automation_schedule(request.interval_minutes, request.timezone_offset_min)?;
    engine
        .automation_create(
            &app,
            CreateAutomation {
                name,
                prompt,
                project_path,
                enabled: request.enabled,
                interval_minutes: request.interval_minutes,
                timezone,
                timezone_offset_min: request.timezone_offset_min,
            },
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_automation_update(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: AutomationUpdateRequest,
) -> CommandResult<Automation> {
    validate_protocol_id("automation id", &request.id)?;
    let (name, prompt) = validate_automation_content(request.name, request.prompt)?;
    let project_path = match request.project_path {
        Some(path) => Some(validate_workspace(&path).await?),
        None => None,
    };
    let timezone = validate_timezone(request.timezone)?;
    validate_automation_schedule(request.interval_minutes, request.timezone_offset_min)?;
    engine
        .automation_update(
            &app,
            UpdateAutomation {
                id: request.id,
                expected_version: request.expected_version,
                name,
                prompt,
                project_path,
                enabled: request.enabled,
                interval_minutes: request.interval_minutes,
                timezone,
                timezone_offset_min: request.timezone_offset_min,
            },
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_automation_delete(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: AutomationIdRequest,
) -> CommandResult<OperationAck> {
    validate_protocol_id("automation id", &request.automation_id)?;
    engine
        .automation_delete(&app, request.automation_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_automation_run_now(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: AutomationIdRequest,
) -> CommandResult<AutomationRun> {
    validate_protocol_id("automation id", &request.automation_id)?;
    engine
        .automation_run_now(&app, request.automation_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_automation_run_mark_reviewed(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    request: AutomationRunIdRequest,
) -> CommandResult<OperationAck> {
    validate_protocol_id("automation run id", &request.run_id)?;
    engine
        .automation_run_mark_reviewed(&app, request.run_id)
        .await
        .map_err(Into::into)
}

fn validate_automation_content(name: String, prompt: String) -> CommandResult<(String, String)> {
    let name = name.trim().to_string();
    if name.is_empty()
        || name.len() > MAX_AUTOMATION_NAME_BYTES
        || name.chars().any(char::is_control)
    {
        return Err(AppError::Protocol(format!(
            "automation name must contain between 1 and {MAX_AUTOMATION_NAME_BYTES} bytes without control characters"
        ))
        .into());
    }
    let prompt = prompt.trim().to_string();
    if prompt.is_empty()
        || prompt.len() > MAX_AUTOMATION_PROMPT_BYTES
        || prompt
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(AppError::Protocol(format!(
            "automation prompt must contain between 1 and {MAX_AUTOMATION_PROMPT_BYTES} bytes"
        ))
        .into());
    }
    Ok((name, prompt))
}

fn validate_automation_schedule(
    interval_minutes: u32,
    timezone_offset_min: i32,
) -> CommandResult<()> {
    if !(MIN_AUTOMATION_INTERVAL_MINUTES..=MAX_AUTOMATION_INTERVAL_MINUTES)
        .contains(&interval_minutes)
    {
        return Err(AppError::Protocol(format!(
            "automation interval must be between {MIN_AUTOMATION_INTERVAL_MINUTES} and {MAX_AUTOMATION_INTERVAL_MINUTES} minutes"
        ))
        .into());
    }
    if !(-840..=840).contains(&timezone_offset_min) {
        return Err(AppError::Protocol(
            "automation timezone offset must be between -840 and 840 minutes".into(),
        )
        .into());
    }
    Ok(())
}

fn validate_auto_top_up_settings(
    request: AutoTopUpSettingsRequest,
) -> CommandResult<(String, String, Option<String>)> {
    const MINIMUM_RELOAD_CREDITS: u64 = 125;
    const MAXIMUM_RELOAD_TARGET_CREDITS: u64 = 250_000;
    const MAXIMUM_MONTHLY_RELOAD_CREDITS: u64 = 1_000_000_000;

    let threshold = parse_credit_amount(
        "automatic reload threshold",
        &request.recharge_threshold,
        MINIMUM_RELOAD_CREDITS,
        MAXIMUM_RELOAD_TARGET_CREDITS,
    )?;
    let target = parse_credit_amount(
        "automatic reload target",
        &request.recharge_target,
        MINIMUM_RELOAD_CREDITS,
        MAXIMUM_RELOAD_TARGET_CREDITS,
    )?;
    if target.saturating_sub(threshold) < MINIMUM_RELOAD_CREDITS {
        return Err(AppError::Protocol(format!(
            "automatic reload target must exceed the threshold by at least {MINIMUM_RELOAD_CREDITS} credits"
        ))
        .into());
    }
    let monthly_limit = request
        .recharge_monthly_limit
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| {
            parse_credit_amount(
                "automatic reload monthly limit",
                &value,
                target,
                MAXIMUM_MONTHLY_RELOAD_CREDITS,
            )
        })
        .transpose()?;
    Ok((
        threshold.to_string(),
        target.to_string(),
        monthly_limit.map(|value| value.to_string()),
    ))
}

fn parse_credit_amount(label: &str, value: &str, minimum: u64, maximum: u64) -> CommandResult<u64> {
    let value = value.trim();
    let parsed = value.parse::<u64>().map_err(|_| {
        CommandError::from(AppError::Protocol(format!(
            "{label} must be a whole number"
        )))
    })?;
    if !(minimum..=maximum).contains(&parsed) {
        return Err(AppError::Protocol(format!(
            "{label} must be between {minimum} and {maximum} credits"
        ))
        .into());
    }
    Ok(parsed)
}

async fn decode_turn_input(
    app: &AppHandle,
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
        let attachment = persist_attachment(app, &attachment.path)
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

#[cfg(test)]
mod tests {
    use super::{AutoTopUpSettingsRequest, validate_auto_top_up_settings};

    #[test]
    fn validates_official_auto_top_up_boundaries() {
        let settings = validate_auto_top_up_settings(AutoTopUpSettingsRequest {
            recharge_threshold: "125".into(),
            recharge_target: "250".into(),
            recharge_monthly_limit: Some("1000".into()),
        })
        .expect("official defaults should validate");

        assert_eq!(settings, ("125".into(), "250".into(), Some("1000".into())));
    }

    #[test]
    fn rejects_auto_top_up_target_too_close_to_threshold() {
        let result = validate_auto_top_up_settings(AutoTopUpSettingsRequest {
            recharge_threshold: "125".into(),
            recharge_target: "249".into(),
            recharge_monthly_limit: None,
        });

        assert!(result.is_err());
    }

    #[test]
    fn rejects_monthly_limit_below_reload_target() {
        let result = validate_auto_top_up_settings(AutoTopUpSettingsRequest {
            recharge_threshold: "125".into(),
            recharge_target: "250".into(),
            recharge_monthly_limit: Some("249".into()),
        });

        assert!(result.is_err());
    }
}
