use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::{Engine as _, prelude::BASE64_STANDARD};
use serde_json::json;
use tauri::AppHandle;
use tokio::sync::watch;
use uuid::Uuid;

use super::code_mode::ToolDelegate;
use super::compaction::{CompactionContext, compact_context};
use super::content_references::strip_content_reference_markers;
use super::context_window::{
    ContextUsageSnapshot, ContextWindowEvaluation, evaluate_context_window, full_context_usage,
};
use super::multi_agent::{
    AgentInvocationContext, compose_prompt_context as compose_multi_agent_prompt_context,
};
use super::output::OutputSource;
use super::prompt_context::compose_prompt_context;
use super::provider::{
    DEFAULT_FUNCTION_NAMESPACE, ModelToolMode, ProviderResponseSession, ResponseContent,
    ResponseEvent, ResponseItem, ResponseMessagePhase, ResponseProtocol, ResponseRequest,
    ResponseRequestSettings, ResponseStream, ResponseTransportConfig, SelectedModel,
    WebSearchAction, normalize_provider_history,
};
use super::storage::ProviderHistorySnapshot;
use super::stream_notifications::StreamNotificationBatcher;
use super::text::truncate_utf8;
use super::tools::{
    CodeModeToolDelegate, CodeModeToolDelegateContext, MAX_PROVIDER_ITEM_BYTES, PreparedTool,
    ReadToolCacheKey, ToolExecutionContext, ToolExecutionResult, ToolRegistry,
};
use super::turn_recovery;
use super::{NativeEngineInner, ResolvedAgentSettings, TurnContinuation};
use crate::attachments::{AttachmentKind, ImageContentError, inspect_path, validate_image_content};
use crate::engine::{
    AccountRateLimitsUpdatedNotification, ActivityStatus, AppConfig, CodexModel, ConversationMode,
    DiagnosticStream, ImageDetail, ItemNotification, MessagePhase, ModelRerouteReason,
    ModelReroutedNotification, ModelSafetyBufferingUpdatedNotification,
    ModelVerificationNotification, PermissionProfile, StreamDelta, ThreadItem, TurnInput,
    WebSearchMode,
};
use crate::error::AppError;

mod scheduler;
mod tool_execution;

use scheduler::ToolScheduler;
use tool_execution::{ToolReadSegment, TurnToolContext};

pub(super) use super::turn_recovery::{
    DEFAULT_RETRY_AFTER_SECONDS, automatic_provider_retry_wait, automatic_rate_limit_wait,
};
#[cfg(test)]
use super::turn_recovery::{
    MAX_AUTOMATIC_PROVIDER_RETRY_DELAY_SECONDS, MAX_AUTOMATIC_RATE_LIMIT_WAIT_SECONDS,
};

const MAX_USER_TEXT_BYTES: usize = 1_048_576;
const MAX_ATTACHMENT_TEXT_BYTES: usize = 2 * 1_048_576;
const MAX_IMAGE_BYTES: usize = 10 * 1_048_576;
const MAX_RAW_INPUT_BYTES: usize = 16 * 1_048_576;
const MAX_LOCAL_PROVIDER_ITEM_BYTES: usize = 24 * 1_048_576;
const MAX_TURN_PREVIEW_BYTES: usize = 160;
const MAX_TOOL_NAME_BYTES: usize = 128;
const MAX_REJECTED_TOOL_NAME_BYTES: usize = 128;
const MAX_REJECTED_TOOL_ERROR_BYTES: usize = 4_096;
const MAX_PREWARM_CONTROL_EVENTS: usize = 32;
const RESPONSE_PREWARM_COMPLETION_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CONTEXT_RECOVERY_ATTEMPTS_WITHOUT_PROGRESS: u8 = 1;
pub(super) struct PreparedTurn {
    pub user_item: ThreadItem,
    pub provider_item: ResponseItem,
    pub preview: String,
}

pub(super) struct TurnRun {
    pub thread_id: String,
    pub turn_id: String,
    pub workspace: PathBuf,
    pub mode: ConversationMode,
    pub model: SelectedModel,
    pub config: AppConfig,
    pub selected_reasoning_effort: Option<crate::engine::ReasoningEffort>,
    pub provider_reasoning_effort: Option<crate::engine::ReasoningEffort>,
    pub service_tier: Option<String>,
    pub timezone: String,
    pub timezone_offset_min: i32,
    pub cancellation: watch::Receiver<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RunCompletion {
    Completed,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContextWindowRecovery {
    Exhausted,
    Interrupted,
    Retry,
}

struct SamplingContext<'a> {
    app: &'a AppHandle,
    inner: &'a NativeEngineInner,
    base_instructions: &'a str,
    prompt_context: &'a [ResponseItem],
    snapshot: &'a mut Option<ContextUsageSnapshot>,
    tools: &'a [serde_json::Value],
}

pub(super) async fn prepare_user_input(
    client_user_message_id: String,
    inputs: Vec<TurnInput>,
) -> Result<PreparedTurn, AppError> {
    if inputs.is_empty() {
        return Err(AppError::Protocol(
            "a turn requires text or at least one attachment".into(),
        ));
    }
    let mut raw_bytes = 0usize;
    let mut user_content = Vec::with_capacity(inputs.len());
    let mut provider_content = Vec::with_capacity(inputs.len());
    let mut preview = None;

    for input in inputs {
        match input {
            TurnInput::Text(text) => {
                let text = text.trim().to_string();
                if text.is_empty() || text.len() > MAX_USER_TEXT_BYTES {
                    return Err(AppError::Protocol(format!(
                        "turn text must contain between 1 and {MAX_USER_TEXT_BYTES} bytes"
                    )));
                }
                add_input_bytes(&mut raw_bytes, text.len())?;
                preview.get_or_insert_with(|| truncate_utf8(&text, MAX_TURN_PREVIEW_BYTES));
                user_content.push(crate::engine::UserContent::Text { text: text.clone() });
                provider_content.push(ResponseContent::InputText { text });
            }
            TurnInput::LocalImage { path } => {
                let attachment = inspect_path(&path).await?;
                if attachment.kind != AttachmentKind::Image
                    || attachment.size > MAX_IMAGE_BYTES as u64
                {
                    return Err(AppError::InvalidAttachment(format!(
                        "images must use a supported format and be at most {} MiB",
                        MAX_IMAGE_BYTES / 1_048_576
                    )));
                }
                let bytes = tokio::fs::read(&attachment.path)
                    .await
                    .map_err(|error| AppError::FileSystem(error.to_string()))?;
                add_input_bytes(&mut raw_bytes, bytes.len())?;
                let media_type = attachment.media_type.ok_or_else(|| {
                    AppError::InvalidAttachment("image media type is unavailable".into())
                })?;
                let (bytes, validated_media_type) = tokio::task::spawn_blocking(move || {
                    validate_image_content(&bytes)
                        .map(|validated_media_type| (bytes, validated_media_type))
                })
                .await
                .map_err(|error| AppError::State(format!("image decoder task failed: {error}")))?
                .map_err(|error| {
                    AppError::InvalidAttachment(match error {
                        ImageContentError::UnsupportedFormat => {
                            "image format is not supported".into()
                        }
                        ImageContentError::InvalidOrUnsafeData => {
                            "image data is invalid or exceeds the safe decode limits".into()
                        }
                    })
                })?;
                if validated_media_type != media_type {
                    return Err(AppError::InvalidAttachment(
                        "image contents changed after attachment validation".into(),
                    ));
                }
                preview.get_or_insert_with(|| attachment.name.clone());
                user_content.push(crate::engine::UserContent::LocalImage {
                    path: attachment.path,
                    detail: Some(ImageDetail::Auto),
                });
                provider_content.push(ResponseContent::InputImage {
                    image_url: format!(
                        "data:{media_type};base64,{}",
                        BASE64_STANDARD.encode(bytes)
                    ),
                    detail: Some(ImageDetail::Auto),
                });
            }
            TurnInput::Mention { name, path } => {
                let attachment = inspect_path(&path).await?;
                if attachment.kind != AttachmentKind::File
                    || attachment.size > MAX_ATTACHMENT_TEXT_BYTES as u64
                {
                    return Err(AppError::InvalidAttachment(format!(
                        "text attachments must be at most {} MiB",
                        MAX_ATTACHMENT_TEXT_BYTES / 1_048_576
                    )));
                }
                let bytes = tokio::fs::read(&attachment.path)
                    .await
                    .map_err(|error| AppError::FileSystem(error.to_string()))?;
                add_input_bytes(&mut raw_bytes, bytes.len())?;
                let text = String::from_utf8(bytes).map_err(|_| {
                    AppError::InvalidAttachment("file attachments must contain UTF-8 text".into())
                })?;
                preview.get_or_insert_with(|| name.clone());
                user_content.push(crate::engine::UserContent::Mention {
                    name: name.clone(),
                    path: attachment.path.clone(),
                });
                provider_content.push(ResponseContent::InputText {
                    text: format!(
                        "<workspace_attachment name={}>\n{}\n</workspace_attachment>",
                        serde_json::to_string(&name).map_err(|error| {
                            AppError::Protocol(format!(
                                "attachment name could not be encoded: {error}"
                            ))
                        })?,
                        text
                    ),
                });
            }
        }
    }

    Ok(PreparedTurn {
        user_item: ThreadItem::UserMessage {
            id: client_user_message_id.clone(),
            content: user_content,
        },
        provider_item: ResponseItem::user_content_with_id(
            &client_user_message_id,
            provider_content,
        ),
        preview: preview.unwrap_or_else(|| "New conversation".into()),
    })
}

pub(super) async fn prewarm_response_session(
    inner: &NativeEngineInner,
    app: &AppHandle,
    thread_id: &str,
    mode: ConversationMode,
    settings: &ResolvedAgentSettings,
    response_session: &mut ProviderResponseSession,
) -> Result<(), AppError> {
    if !response_session.owns_current_lease() || !response_session.needs_prewarm() {
        return Ok(());
    }

    let supports_multi_agent = settings.model.multi_agent_version().is_supported();
    let (_cancellation_sender, mut cancellation) = watch::channel(false);
    let preconnect = inner.provider.preconnect_response(
        app,
        &inner.auth,
        response_session,
        ResponseTransportConfig {
            uses_responses_lite: settings.model.response_protocol() == ResponseProtocol::Lite,
            model: settings.model.id(),
            service_tier: settings.service_tier.as_deref(),
        },
        &mut cancellation,
    );
    let multi_agent_models = async {
        if supports_multi_agent {
            inner
                .provider
                .multi_agent_models(app, &inner.auth)
                .await
                .map(Some)
        } else {
            Ok(None)
        }
    };
    let (preconnect_result, multi_agent_models) = tokio::join!(preconnect, multi_agent_models);
    if let Some(message) = preconnect_result? {
        inner.emit_diagnostic(app, DiagnosticStream::Runtime, message);
    }
    if !response_session.owns_current_lease() || !response_session.needs_prewarm() {
        return Ok(());
    }

    let tools = provider_tools(
        inner,
        &settings.config,
        mode,
        &settings.model,
        multi_agent_models?.as_deref(),
    );
    let base_instructions = settings.model.instructions(settings.config.personality);
    let request = ResponseRequest::new(
        settings.model.id(),
        &base_instructions,
        &[],
        &[],
        &tools,
        ResponseRequestSettings {
            protocol: settings.model.response_protocol(),
            parallel_tool_calls: settings.model.request_parallel_tool_calls(),
            reasoning_effort: settings.provider_reasoning_effort,
            reasoning_summary: settings.model.requested_reasoning_summary(),
            service_tier: settings.service_tier.as_deref(),
            prompt_cache_key: Some(thread_id),
            verbosity: settings
                .model
                .select_verbosity(settings.config.model_verbosity)?,
        },
    )?;
    let Some(stream) = inner
        .provider
        .prewarm_response(response_session, request, None)
        .await?
    else {
        return Ok(());
    };
    match tokio::time::timeout(
        RESPONSE_PREWARM_COMPLETION_TIMEOUT,
        collect_response_prewarm(stream, &mut cancellation),
    )
    .await
    {
        Ok(Ok(events)) => {
            response_session.retain_prewarm_control_events(events);
            Ok(())
        }
        Ok(Err(error)) => {
            response_session.abandon_pending_response();
            Err(error)
        }
        Err(_) => {
            response_session.abandon_pending_response();
            Err(AppError::Timeout {
                operation: "Responses WebSocket prewarm",
            })
        }
    }
}

pub(super) async fn run_turn(
    inner: Arc<NativeEngineInner>,
    app: AppHandle,
    mut run: TurnRun,
) -> Result<RunCompletion, AppError> {
    let base_instructions = run.model.instructions(run.config.personality);
    let supports_multi_agent = run.model.multi_agent_version().is_supported();
    let verbosity = run.model.select_verbosity(run.config.model_verbosity)?;
    let code_mode_enabled =
        local_tools_enabled(run.mode) && run.model.tool_mode() != ModelToolMode::Direct;
    let code_mode_tools = if code_mode_enabled {
        inner.tools.code_mode_nested_definitions(
            run.config.permission_profile,
            run.model.supports_image_input(),
            run.model.supports_image_detail_original(),
        )
    } else {
        Vec::new()
    };
    let mut response_session = inner.provider.response_session(&run.thread_id);
    let mut preconnect_cancellation = run.cancellation.clone();
    let prompt_context_future = async {
        let multi_agent_context = if supports_multi_agent {
            let identity = inner
                .multi_agents
                .identity(&inner.storage, &run.thread_id)
                .await?;
            Some(compose_multi_agent_prompt_context(
                &identity,
                &run.model,
                run.selected_reasoning_effort,
            ))
        } else {
            None
        };
        compose_prompt_context(
            &run.workspace,
            &run.config,
            run.mode,
            &run.model,
            multi_agent_context.as_ref(),
            &run.timezone,
            run.timezone_offset_min,
        )
        .await
    };
    let prompt_state_future = load_initial_prompt_state(&inner, &app, &run.thread_id);
    let code_mode_session_future = async {
        if code_mode_enabled {
            Some(inner.code_mode_sessions.session(&run.thread_id).await)
        } else {
            None
        }
    };
    let response_transport_future = async {
        let preconnect_future = inner.provider.preconnect_response(
            &app,
            &inner.auth,
            &mut response_session,
            ResponseTransportConfig {
                uses_responses_lite: run.model.response_protocol() == ResponseProtocol::Lite,
                model: run.model.id(),
                service_tier: run.service_tier.as_deref(),
            },
            &mut preconnect_cancellation,
        );
        let multi_agent_models_future = async {
            if supports_multi_agent {
                inner
                    .provider
                    .multi_agent_models(&app, &inner.auth)
                    .await
                    .map(Some)
            } else {
                Ok(None)
            }
        };
        let (preconnect_result, multi_agent_models) =
            tokio::join!(preconnect_future, multi_agent_models_future);
        let multi_agent_models = multi_agent_models?;
        let tools = provider_tools(
            &inner,
            &run.config,
            run.mode,
            &run.model,
            multi_agent_models.as_deref(),
        );
        Ok::<_, AppError>((preconnect_result, tools))
    };
    let (transport, prompt_context, prompt_state, code_mode_session) = tokio::join!(
        response_transport_future,
        prompt_context_future,
        prompt_state_future,
        code_mode_session_future,
    );
    let (preconnect_result, tools) = transport?;
    match preconnect_result {
        Ok(Some(message)) => inner.emit_diagnostic(&app, DiagnosticStream::Runtime, message),
        Ok(None) => {}
        Err(AppError::Cancelled(_)) if *run.cancellation.borrow() => {
            return Ok(RunCompletion::Interrupted);
        }
        Err(error) if error.is_transient() => inner.emit_diagnostic(
            &app,
            DiagnosticStream::Runtime,
            format!(
                "Responses WebSocket preconnect was unavailable; the request will connect normally: {error}"
            ),
        ),
        Err(error) => return Err(error),
    }
    let prompt_context = prompt_context?;
    let (mut history, mut context_snapshot) = prompt_state?;
    let agent_invocation = AgentInvocationContext {
        thread_id: run.thread_id.clone(),
        model: run.model.id().to_string(),
        reasoning_effort: run.selected_reasoning_effort,
        service_tier: run.service_tier.clone(),
        timezone: run.timezone.clone(),
        timezone_offset_min: run.timezone_offset_min,
    };
    let mut provider_state = TurnProviderState::default();
    for event in response_session.take_prewarm_control_events() {
        if handle_provider_control_event(&inner, &app, &run, &mut provider_state, event)
            .await?
            .is_some()
        {
            return Err(AppError::State(
                "websocket prewarm retained a non-control event".into(),
            ));
        }
    }
    let mut history_requires_refresh = false;
    let mut promoted_through_steer_sequence = 0i64;
    let mut required_pending_steer_sequence = None;
    let mut transient_failure_count = 0u32;
    let mut context_recovery_attempts = 0u8;
    let stream_deltas = StreamNotificationBatcher::new(
        Arc::clone(&inner),
        app.clone(),
        run.thread_id.clone(),
        run.turn_id.clone(),
    );
    let code_mode_delegate: Option<Arc<dyn ToolDelegate>> = code_mode_enabled.then(|| {
        Arc::new(CodeModeToolDelegate::new(
            Arc::clone(&inner),
            app.clone(),
            CodeModeToolDelegateContext {
                workspace: run.workspace.clone(),
                permissions: run.config.permission_profile,
                thread_id: run.thread_id.clone(),
                turn_id: run.turn_id.clone(),
                supports_image_input: run.model.supports_image_input(),
                supports_original_image_detail: run.model.supports_image_detail_original(),
                provider_output_budget: run.model.provider_output_budget(),
                agent: agent_invocation.clone(),
            },
        )) as Arc<dyn ToolDelegate>
    });

    let tool_context = Arc::new(TurnToolContext::new(
        Arc::clone(&inner),
        app.clone(),
        &run,
        stream_deltas.clone(),
        code_mode_session.clone(),
        code_mode_delegate,
        code_mode_tools,
    ));
    let result = async {
        'sampling: loop {
            if *run.cancellation.borrow() {
                stream_deltas.flush().await?;
                return Ok(RunCompletion::Interrupted);
            }
            // Steers accepted during the previous sample are staged outside provider history
            // so they can be appended after that response and any tool outputs it produced.
            let promoted = inner
                .storage
                .promote_pending_turn_inputs(run.thread_id.clone(), run.turn_id.clone())
                .await?;
            if let Some(sequence) = promoted {
                promoted_through_steer_sequence = promoted_through_steer_sequence.max(sequence);
                history_requires_refresh = true;
            }
            if let Some(required_sequence) = required_pending_steer_sequence.take()
                && promoted.is_none_or(|sequence| sequence < required_sequence)
            {
                return Err(AppError::State(
                    "a pending steer was not promoted before the follow-up request".into(),
                ));
            }
            if history_requires_refresh {
                inner
                    .storage
                    .refresh_provider_history(run.thread_id.clone(), &mut history)
                    .await?;
            }
            history_requires_refresh = true;
            if !prepare_sampling_input(
                SamplingContext {
                    app: &app,
                    inner: &inner,
                    base_instructions: &base_instructions,
                    prompt_context: prompt_context.items(),
                    snapshot: &mut context_snapshot,
                    tools: &tools,
                },
                &mut run,
                &mut provider_state,
                &mut response_session,
                &mut history,
            )
            .await?
            {
                return Ok(RunCompletion::Interrupted);
            }
            let sampled_through_steer_sequence = promoted_through_steer_sequence;
            let request = ResponseRequest::new(
                run.model.id(),
                &base_instructions,
                prompt_context.items(),
                &history.items,
                &tools,
                ResponseRequestSettings {
                    protocol: run.model.response_protocol(),
                    parallel_tool_calls: run.model.request_parallel_tool_calls(),
                    reasoning_effort: run.provider_reasoning_effort,
                    reasoning_summary: run.model.requested_reasoning_summary(),
                    service_tier: run.service_tier.as_deref(),
                    prompt_cache_key: Some(&run.thread_id),
                    verbosity,
                },
            )?;
            let mut stream = match inner
                .provider
                .start_response(
                    &app,
                    &inner.auth,
                    &mut response_session,
                    request,
                    provider_state.turn_state(),
                    &mut run.cancellation,
                )
                .await
            {
                Ok(stream) => stream,
                Err(AppError::Cancelled(_)) => return Ok(RunCompletion::Interrupted),
                Err(error) => {
                    if let Some(decision) =
                        turn_recovery::classify(&error, &mut transient_failure_count)
                    {
                        history_requires_refresh = false;
                        if turn_recovery::wait_for_retry(&inner, &app, &mut run, &error, decision)
                            .await
                        {
                            continue 'sampling;
                        }
                        return Ok(RunCompletion::Interrupted);
                    }
                    if matches!(&error, AppError::ContextWindowExceeded(_)) {
                        match recover_from_context_window(
                            SamplingContext {
                                app: &app,
                                inner: &inner,
                                base_instructions: &base_instructions,
                                prompt_context: prompt_context.items(),
                                snapshot: &mut context_snapshot,
                                tools: &tools,
                            },
                            &mut run,
                            &mut provider_state,
                            &mut response_session,
                            &mut history,
                            &mut context_recovery_attempts,
                        )
                        .await?
                        {
                            ContextWindowRecovery::Retry => {
                                history_requires_refresh = false;
                                transient_failure_count = 0;
                                continue 'sampling;
                            }
                            ContextWindowRecovery::Interrupted => {
                                return Ok(RunCompletion::Interrupted);
                            }
                            ContextWindowRecovery::Exhausted => {
                                persist_full_context_usage(&inner, &app, &run).await?;
                            }
                        }
                    }
                    return Err(error);
                }
            };
            let mut pending_tools = ToolScheduler::new();
            let mut read_segment = ToolReadSegment::default();
            let mut response_item_count = 0usize;
            let response_result = async {
                loop {
                    let event = pending_tools
                        .next_response_event(stream.next_event(&mut run.cancellation))
                        .await?
                        .ok_or_else(|| {
                            AppError::Provider(
                                "response stream ended before response.completed".into(),
                            )
                        })?;
                    if !matches!(
                        &event,
                        ResponseEvent::OutputTextDelta { .. }
                            | ResponseEvent::ReasoningSummaryDelta { .. }
                            | ResponseEvent::ReasoningContentDelta { .. }
                    ) {
                        stream_deltas.flush().await?;
                    }
                    let Some(event) = handle_provider_control_event(
                        &inner,
                        &app,
                        &run,
                        &mut provider_state,
                        event,
                    )
                    .await?
                    else {
                        continue;
                    };
                    match event {
                        ResponseEvent::OutputItemAdded(item) => {
                            validate_response_item(&item)?;
                            if matches!(
                                &item,
                                ResponseItem::Message { .. } | ResponseItem::Reasoning { .. }
                            ) && let Some(thread_item) = visible_item(&item)?
                            {
                                emit_item_notification(
                                    &inner,
                                    &app,
                                    &run.thread_id,
                                    &run.turn_id,
                                    thread_item,
                                    true,
                                )?;
                            }
                        }
                        ResponseEvent::OutputTextDelta { item_id, delta } => {
                            validate_delta(&item_id, &delta)?;
                            stream_deltas
                                .push(StreamDelta::AgentText { item_id, delta })
                                .await?;
                        }
                        ResponseEvent::ReasoningSummaryDelta {
                            item_id,
                            summary_index,
                            delta,
                        } => {
                            validate_delta(&item_id, &delta)?;
                            stream_deltas
                                .push(StreamDelta::ReasoningSummary {
                                    item_id,
                                    index: summary_index,
                                    delta,
                                })
                                .await?;
                        }
                        ResponseEvent::ReasoningContentDelta {
                            item_id,
                            content_index,
                            delta,
                        } => {
                            validate_delta(&item_id, &delta)?;
                            stream_deltas
                                .push(StreamDelta::ReasoningText {
                                    item_id,
                                    index: content_index,
                                    delta,
                                })
                                .await?;
                        }
                        ResponseEvent::OutputItemDone(item) => {
                            validate_response_item(&item)?;
                            if let Some(item_id) = item.id() {
                                stream_deltas.finish_item(item_id).await?;
                            }
                            if let Some(thread_item) = visible_item(&item)? {
                                let thread_item = inner
                                    .storage
                                    .append_provider_and_thread_item(
                                        run.thread_id.clone(),
                                        run.turn_id.clone(),
                                        std::slice::from_ref(&item),
                                        thread_item,
                                        None,
                                    )
                                    .await?;
                                emit_item_notification(
                                    &inner,
                                    &app,
                                    &run.thread_id,
                                    &run.turn_id,
                                    thread_item,
                                    false,
                                )?;
                            } else {
                                inner
                                    .storage
                                    .append_provider_item(run.thread_id.clone(), &item)
                                    .await?;
                            }
                            response_item_count += 1;
                            match item {
                                ResponseItem::FunctionCall {
                                    id,
                                    namespace,
                                    name,
                                    arguments,
                                    call_id,
                                } => {
                                    let item_id = id.unwrap_or_else(|| call_id.clone());
                                    tool_context.enqueue(
                                        &mut pending_tools,
                                        &mut read_segment,
                                        PendingTool::function(
                                            &inner.tools,
                                            item_id,
                                            namespace.as_deref(),
                                            &name,
                                            &arguments,
                                            call_id,
                                        ),
                                    )?;
                                }
                                ResponseItem::CustomToolCall {
                                    id,
                                    namespace,
                                    call_id,
                                    name,
                                    input,
                                } => {
                                    let item_id = id.unwrap_or_else(|| call_id.clone());
                                    tool_context.enqueue(
                                        &mut pending_tools,
                                        &mut read_segment,
                                        PendingTool::custom(
                                            &inner.tools,
                                            item_id,
                                            namespace.as_deref(),
                                            &name,
                                            &input,
                                            call_id,
                                        ),
                                    )?;
                                }
                                _ => {}
                            }
                        }
                        ResponseEvent::Completed(completed) => {
                            context_recovery_attempts = 0;
                            if let Some(usage) = completed.usage {
                                context_snapshot = Some(ContextUsageSnapshot {
                                    model: run.model.id().into(),
                                    usage: usage.clone(),
                                    history_item_count: history.items.len() + response_item_count,
                                });
                                persist_and_emit_item(
                                    &inner,
                                    &app,
                                    &run.thread_id,
                                    &run.turn_id,
                                    ThreadItem::ContextUsage {
                                        id: Uuid::now_v7().to_string(),
                                        model: run.model.id().into(),
                                        usage,
                                        context_window: run.model.context_window(),
                                    },
                                    None,
                                    false,
                                )
                                .await?;
                            }
                            return Ok::<_, AppError>(());
                        }
                        ResponseEvent::Interrupted => {
                            return Err(AppError::Cancelled(
                                "response stream was interrupted".into(),
                            ));
                        }
                        ResponseEvent::ServerModel(_)
                        | ResponseEvent::ModelsEtag(_)
                        | ResponseEvent::TurnState(_)
                        | ResponseEvent::ModelVerifications(_)
                        | ResponseEvent::SafetyBuffering(_)
                        | ResponseEvent::RateLimits(_)
                        | ResponseEvent::TransportFallback(_) => {
                            return Err(AppError::State(
                                "provider control event escaped its handler".into(),
                            ));
                        }
                    }
                }
            }
            .await;
            let had_tool_calls = pending_tools.has_calls();
            let drained = pending_tools.drain().await;
            let flush_result = stream_deltas.finish_response().await;
            let mut settlement_failure = drained.failure;
            for completed in drained.results {
                if let Err(error) = tool_context.persist(completed).await {
                    inner.emit_diagnostic(
                        &app,
                        DiagnosticStream::Runtime,
                        format!("could not settle a dispatched tool: {error}"),
                    );
                    settlement_failure.get_or_insert(error);
                }
            }
            if let Some(error) = settlement_failure {
                return Err(error);
            }
            flush_result?;
            match response_result {
                Ok(()) => transient_failure_count = 0,
                Err(AppError::Cancelled(_)) => return Ok(RunCompletion::Interrupted),
                Err(error) => {
                    // A partial response cannot move the confirmed usage boundary.
                    // Its completed items and tool results remain part of the local delta.
                    if let Some(decision) =
                        turn_recovery::classify(&error, &mut transient_failure_count)
                    {
                        if turn_recovery::wait_for_retry(&inner, &app, &mut run, &error, decision)
                            .await
                        {
                            continue 'sampling;
                        }
                        return Ok(RunCompletion::Interrupted);
                    }
                    if matches!(&error, AppError::ContextWindowExceeded(_)) {
                        inner
                            .storage
                            .refresh_provider_history(run.thread_id.clone(), &mut history)
                            .await?;
                        match recover_from_context_window(
                            SamplingContext {
                                app: &app,
                                inner: &inner,
                                base_instructions: &base_instructions,
                                prompt_context: prompt_context.items(),
                                snapshot: &mut context_snapshot,
                                tools: &tools,
                            },
                            &mut run,
                            &mut provider_state,
                            &mut response_session,
                            &mut history,
                            &mut context_recovery_attempts,
                        )
                        .await?
                        {
                            ContextWindowRecovery::Retry => {
                                history_requires_refresh = false;
                                transient_failure_count = 0;
                                continue 'sampling;
                            }
                            ContextWindowRecovery::Interrupted => {
                                return Ok(RunCompletion::Interrupted);
                            }
                            ContextWindowRecovery::Exhausted => {
                                persist_full_context_usage(&inner, &app, &run).await?
                            }
                        }
                    }
                    return Err(error);
                }
            }
            if *run.cancellation.borrow() {
                return Ok(RunCompletion::Interrupted);
            }
            match inner
                .turn_continuation(
                    &run.thread_id,
                    &run.turn_id,
                    sampled_through_steer_sequence,
                    had_tool_calls,
                )
                .await?
            {
                TurnContinuation::Complete => return Ok(RunCompletion::Completed),
                TurnContinuation::Continue {
                    pending_steer_sequence,
                } => {
                    required_pending_steer_sequence = pending_steer_sequence;
                }
            }
        }
    }
    .await;
    let flush_result = stream_deltas.flush().await;
    if let Some(session) = code_mode_session.as_ref() {
        session.cancel_owner(&run.turn_id).await;
    }
    flush_result?;
    result
}

async fn recover_from_context_window(
    context: SamplingContext<'_>,
    run: &mut TurnRun,
    provider_state: &mut TurnProviderState,
    response_session: &mut ProviderResponseSession,
    history: &mut ProviderHistorySnapshot,
    attempts: &mut u8,
) -> Result<ContextWindowRecovery, AppError> {
    if *attempts >= MAX_CONTEXT_RECOVERY_ATTEMPTS_WITHOUT_PROGRESS {
        return Ok(ContextWindowRecovery::Exhausted);
    }
    *attempts = (*attempts).saturating_add(1);
    context.inner.emit_diagnostic(
        context.app,
        DiagnosticStream::Runtime,
        "The provider reached the context boundary before the local estimate; compacting and retrying the active turn."
            .into(),
    );

    let compacted = match compact_context(
        context.inner,
        context.app,
        run,
        provider_state,
        response_session,
        history,
        CompactionContext {
            base_instructions: context.base_instructions,
            prompt_context: context.prompt_context,
            tools: context.tools,
            active_tokens: None,
        },
    )
    .await
    {
        Ok(compacted) => compacted,
        Err(AppError::ContextWindowExceeded(_)) => {
            context.inner.emit_diagnostic(
                context.app,
                DiagnosticStream::Runtime,
                "Context recovery compaction also exceeded the model window; preserving the terminal failure."
                    .into(),
            );
            return Ok(ContextWindowRecovery::Exhausted);
        }
        Err(error) => return Err(error),
    };
    if !compacted {
        return Ok(ContextWindowRecovery::Interrupted);
    }

    *history = load_prompt_history(context.inner, context.app, &run.thread_id).await?;
    *context.snapshot = None;
    context.inner.emit_diagnostic(
        context.app,
        DiagnosticStream::Runtime,
        "Context recovery completed; retrying the active turn.".into(),
    );
    Ok(ContextWindowRecovery::Retry)
}

pub(super) fn provider_tools(
    inner: &NativeEngineInner,
    config: &AppConfig,
    mode: ConversationMode,
    model: &SelectedModel,
    multi_agent_models: Option<&[CodexModel]>,
) -> Vec<serde_json::Value> {
    let mut tools = if local_tools_enabled(mode) {
        local_provider_tools(
            &inner.tools,
            config.permission_profile,
            model.supports_image_input(),
            model.supports_image_detail_original(),
            multi_agent_models,
            model.tool_mode(),
        )
    } else {
        Vec::new()
    };
    if let Some(web_search) = hosted_web_search_tool(
        config.web_search,
        model.response_protocol(),
        model.web_search_includes_images(),
    ) {
        tools.push(web_search);
    }
    tools
}

fn local_provider_tools(
    registry: &ToolRegistry,
    permissions: PermissionProfile,
    supports_image_input: bool,
    supports_original_image_detail: bool,
    multi_agent_models: Option<&[CodexModel]>,
    tool_mode: ModelToolMode,
) -> Vec<serde_json::Value> {
    let mut tools = match tool_mode {
        ModelToolMode::Direct | ModelToolMode::CodeMode => registry.definitions_for_model(
            permissions,
            supports_image_input,
            supports_original_image_detail,
            multi_agent_models,
        ),
        ModelToolMode::CodeModeOnly => multi_agent_models
            .map(|models| registry.multi_agent_definitions(models))
            .unwrap_or_default(),
    };
    if tool_mode != ModelToolMode::Direct {
        let nested_tools = registry.code_mode_nested_definitions(
            permissions,
            supports_image_input,
            supports_original_image_detail,
        );
        tools.extend(
            registry.code_mode_definitions(&nested_tools, tool_mode == ModelToolMode::CodeModeOnly),
        );
    }
    tools
}

fn hosted_web_search_tool(
    mode: WebSearchMode,
    protocol: super::provider::ResponseProtocol,
    includes_images: bool,
) -> Option<serde_json::Value> {
    if mode != WebSearchMode::Live || protocol == super::provider::ResponseProtocol::Lite {
        return None;
    }
    Some(if includes_images {
        json!({
            "type": "web_search",
            "external_web_access": true,
            "search_content_types": ["text", "image"]
        })
    } else {
        json!({
            "type": "web_search",
            "external_web_access": true
        })
    })
}

const fn local_tools_enabled(mode: ConversationMode) -> bool {
    matches!(mode, ConversationMode::Work | ConversationMode::Codex)
}

pub(super) async fn load_prompt_history(
    inner: &NativeEngineInner,
    app: &AppHandle,
    thread_id: &str,
) -> Result<ProviderHistorySnapshot, AppError> {
    let history = inner
        .storage
        .provider_history_snapshot(thread_id.into())
        .await?;
    normalize_prompt_history(inner, app, thread_id, history).await
}

async fn collect_response_prewarm(
    mut stream: ResponseStream,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<Vec<ResponseEvent>, AppError> {
    let mut events = Vec::new();
    loop {
        let Some(event) = stream.next_event(cancellation).await? else {
            return Err(AppError::Protocol(
                "websocket prewarm ended before response.completed".into(),
            ));
        };
        match event {
            ResponseEvent::ServerModel(_)
            | ResponseEvent::ModelsEtag(_)
            | ResponseEvent::TurnState(_)
            | ResponseEvent::ModelVerifications(_)
            | ResponseEvent::SafetyBuffering(_)
            | ResponseEvent::RateLimits(_)
            | ResponseEvent::TransportFallback(_) => {
                if events.len() >= MAX_PREWARM_CONTROL_EVENTS {
                    return Err(AppError::Protocol(format!(
                        "websocket prewarm exceeded {MAX_PREWARM_CONTROL_EVENTS} control events"
                    )));
                }
                events.push(event);
            }
            ResponseEvent::Completed(_) => return Ok(events),
            ResponseEvent::Interrupted => {
                return Err(AppError::Cancelled(
                    "websocket prewarm was interrupted".into(),
                ));
            }
            ResponseEvent::OutputItemAdded(_)
            | ResponseEvent::OutputTextDelta { .. }
            | ResponseEvent::ReasoningSummaryDelta { .. }
            | ResponseEvent::ReasoningContentDelta { .. }
            | ResponseEvent::OutputItemDone(_) => {
                return Err(AppError::Protocol(
                    "websocket prewarm generated an unexpected output event".into(),
                ));
            }
        }
    }
}

async fn load_initial_prompt_state(
    inner: &NativeEngineInner,
    app: &AppHandle,
    thread_id: &str,
) -> Result<(ProviderHistorySnapshot, Option<ContextUsageSnapshot>), AppError> {
    let snapshot = inner
        .storage
        .provider_prompt_snapshot(thread_id.into())
        .await?;
    let original_sequence = snapshot.history.last_sequence();
    let history = normalize_prompt_history(inner, app, thread_id, snapshot.history).await?;
    let usage = (history.last_sequence() == original_sequence)
        .then_some(snapshot.context_usage)
        .flatten();
    Ok((history, usage))
}

async fn normalize_prompt_history(
    inner: &NativeEngineInner,
    app: &AppHandle,
    thread_id: &str,
    mut history: ProviderHistorySnapshot,
) -> Result<ProviderHistorySnapshot, AppError> {
    let normalized_through_sequence = history.last_sequence();
    let normalized = normalize_provider_history(std::mem::take(&mut history.items))?;
    if !normalized.changed() {
        history.items = normalized.items;
        return Ok(history);
    }

    inner
        .storage
        .rewrite_provider_history_prefix(
            thread_id.into(),
            normalized_through_sequence,
            normalized.items.clone(),
        )
        .await?;
    inner.emit_diagnostic(
        app,
        DiagnosticStream::Runtime,
        format!(
            "Provider history normalized before the request: {} aborted output(s) inserted and {} orphan output(s) removed.",
            normalized.inserted_aborted_outputs, normalized.removed_orphan_outputs
        ),
    );
    inner
        .storage
        .provider_history_snapshot(thread_id.into())
        .await
}

async fn prepare_sampling_input(
    context: SamplingContext<'_>,
    run: &mut TurnRun,
    provider_state: &mut TurnProviderState,
    response_session: &mut ProviderResponseSession,
    history: &mut ProviderHistorySnapshot,
) -> Result<bool, AppError> {
    let context_window = run.model.context_window();
    let status = evaluate_context_window(ContextWindowEvaluation {
        model_id: run.model.id(),
        base_instructions: context.base_instructions,
        prompt_context: context.prompt_context,
        history: &history.items,
        tools: context.tools,
        snapshot: context.snapshot.as_ref(),
        auto_compact_limit: run.model.auto_compact_token_limit(),
        context_window: context_window.as_ref(),
    });
    if !status.should_compact {
        return Ok(true);
    }

    context.inner.emit_diagnostic(
        context.app,
        DiagnosticStream::Runtime,
        format!(
            "Automatically compacting {active_tokens} active context tokens before sampling.",
            active_tokens = status.active_tokens
        ),
    );
    if !compact_context(
        context.inner,
        context.app,
        run,
        provider_state,
        response_session,
        history,
        CompactionContext {
            base_instructions: context.base_instructions,
            prompt_context: context.prompt_context,
            tools: context.tools,
            active_tokens: Some(status.active_tokens),
        },
    )
    .await?
    {
        return Ok(false);
    }

    *history = load_prompt_history(context.inner, context.app, &run.thread_id).await?;
    *context.snapshot = None;
    Ok(true)
}

async fn persist_full_context_usage(
    inner: &NativeEngineInner,
    app: &AppHandle,
    run: &TurnRun,
) -> Result<(), AppError> {
    let Some(context_window) = run.model.context_window() else {
        return Ok(());
    };
    persist_and_emit_item(
        inner,
        app,
        &run.thread_id,
        &run.turn_id,
        ThreadItem::ContextUsage {
            id: Uuid::now_v7().to_string(),
            model: run.model.id().into(),
            usage: full_context_usage(&context_window),
            context_window: Some(context_window),
        },
        None,
        false,
    )
    .await
}

#[derive(Default)]
pub(super) struct TurnProviderState {
    turn_state: Option<String>,
    rerouted_models: Vec<String>,
    verification_emitted: bool,
}

impl TurnProviderState {
    pub(super) fn turn_state(&self) -> Option<&str> {
        self.turn_state.as_deref()
    }
}

pub(super) async fn handle_provider_control_event(
    inner: &NativeEngineInner,
    app: &AppHandle,
    run: &TurnRun,
    state: &mut TurnProviderState,
    event: ResponseEvent,
) -> Result<Option<ResponseEvent>, AppError> {
    match event {
        ResponseEvent::TurnState(turn_state) => {
            record_turn_state(&mut state.turn_state, turn_state)?;
            Ok(None)
        }
        ResponseEvent::ModelsEtag(etag) => {
            inner.provider.reconcile_catalog_etag(&etag).await;
            Ok(None)
        }
        ResponseEvent::ServerModel(server_model) => {
            if !server_model.eq_ignore_ascii_case(run.model.id())
                && !state
                    .rerouted_models
                    .iter()
                    .any(|model| model.eq_ignore_ascii_case(&server_model))
            {
                state.rerouted_models.push(server_model.clone());
                inner.emit_notification(
                    app,
                    crate::engine::EngineNotification::ModelRerouted(ModelReroutedNotification {
                        thread_id: run.thread_id.clone(),
                        turn_id: run.turn_id.clone(),
                        from_model: run.model.id().into(),
                        to_model: server_model,
                        reason: ModelRerouteReason::HighRiskCyberActivity,
                    }),
                )?;
            }
            Ok(None)
        }
        ResponseEvent::ModelVerifications(verifications) => {
            if !state.verification_emitted {
                state.verification_emitted = true;
                inner.emit_notification(
                    app,
                    crate::engine::EngineNotification::ModelVerification(
                        ModelVerificationNotification {
                            thread_id: run.thread_id.clone(),
                            turn_id: run.turn_id.clone(),
                            verifications,
                        },
                    ),
                )?;
            }
            Ok(None)
        }
        ResponseEvent::SafetyBuffering(buffering) => {
            inner.emit_notification(
                app,
                crate::engine::EngineNotification::ModelSafetyBufferingUpdated(
                    ModelSafetyBufferingUpdatedNotification {
                        thread_id: run.thread_id.clone(),
                        turn_id: run.turn_id.clone(),
                        model: run.model.id().into(),
                        use_cases: buffering.use_cases,
                        reasons: buffering.reasons,
                        show_buffering_ui: true,
                        faster_model: buffering.faster_model,
                    },
                ),
            )?;
            Ok(None)
        }
        ResponseEvent::RateLimits(rate_limits) => {
            inner.emit_notification(
                app,
                crate::engine::EngineNotification::AccountRateLimitsUpdated(
                    AccountRateLimitsUpdatedNotification { rate_limits },
                ),
            )?;
            Ok(None)
        }
        ResponseEvent::TransportFallback(message) => {
            inner.emit_diagnostic(app, DiagnosticStream::Runtime, message);
            Ok(None)
        }
        event => Ok(Some(event)),
    }
}

fn record_turn_state(current: &mut Option<String>, incoming: String) -> Result<(), AppError> {
    if current.is_none() {
        *current = Some(incoming);
    }
    Ok(())
}

struct PendingTool {
    call_id: String,
    output_kind: ToolOutputKind,
    operation: PendingToolOperation,
}

enum PendingToolOperation {
    Prepared(PreparedTool),
    Rejected(RejectedToolCall),
}

struct RejectedToolCall {
    item_id: String,
    name: String,
    error: String,
}

#[derive(Debug, Clone, Copy)]
enum ToolOutputKind {
    Function,
    Custom,
}

fn local_tool_name<'a>(namespace: Option<&str>, name: &'a str) -> Result<&'a str, AppError> {
    match namespace {
        None | Some("") | Some(DEFAULT_FUNCTION_NAMESPACE) => Ok(name),
        Some(namespace) => Err(AppError::Protocol(format!(
            "tool `{namespace}.{name}` belongs to an unadvertised namespace"
        ))),
    }
}

fn display_tool_name(namespace: Option<&str>, name: &str) -> String {
    match namespace {
        None | Some("") | Some(DEFAULT_FUNCTION_NAMESPACE) => name.to_string(),
        Some(namespace) => format!("{namespace}.{name}"),
    }
}

impl PendingTool {
    fn function(
        registry: &ToolRegistry,
        item_id: String,
        namespace: Option<&str>,
        name: &str,
        arguments: &str,
        call_id: String,
    ) -> Self {
        let display_name = display_tool_name(namespace, name);
        let preparation = local_tool_name(namespace, name)
            .and_then(|name| registry.prepare(item_id.clone(), name, arguments));
        Self::from_preparation(
            item_id,
            &display_name,
            call_id,
            ToolOutputKind::Function,
            preparation,
        )
    }

    fn custom(
        registry: &ToolRegistry,
        item_id: String,
        namespace: Option<&str>,
        name: &str,
        input: &str,
        call_id: String,
    ) -> Self {
        let display_name = display_tool_name(namespace, name);
        let preparation = local_tool_name(namespace, name)
            .and_then(|name| registry.prepare_custom(item_id.clone(), name, input));
        Self::from_preparation(
            item_id,
            &display_name,
            call_id,
            ToolOutputKind::Custom,
            preparation,
        )
    }

    fn from_preparation(
        item_id: String,
        name: &str,
        call_id: String,
        output_kind: ToolOutputKind,
        preparation: Result<PreparedTool, AppError>,
    ) -> Self {
        let operation = match preparation {
            Ok(prepared) => PendingToolOperation::Prepared(prepared),
            Err(error) => {
                PendingToolOperation::Rejected(RejectedToolCall::new(item_id, name, error))
            }
        };
        Self {
            call_id,
            output_kind,
            operation,
        }
    }

    fn supports_parallel_execution(&self, permissions: PermissionProfile) -> bool {
        match &self.operation {
            PendingToolOperation::Prepared(prepared) => {
                prepared.supports_parallel_execution(permissions)
            }
            PendingToolOperation::Rejected(_) => true,
        }
    }

    fn read_dedup_key(&self, workspace: &Path, thread_id: &str) -> Option<ReadToolCacheKey> {
        match &self.operation {
            PendingToolOperation::Prepared(prepared) => {
                prepared.read_dedup_key(workspace, thread_id)
            }
            PendingToolOperation::Rejected(_) => None,
        }
    }

    fn duplicate_read_result(
        &self,
        workspace: &Path,
        original_call_id: &str,
    ) -> ToolExecutionResult {
        match &self.operation {
            PendingToolOperation::Prepared(prepared) => {
                prepared.duplicate_read_result(workspace, original_call_id)
            }
            PendingToolOperation::Rejected(rejected) => rejected.result(),
        }
    }

    fn name(&self) -> &str {
        match &self.operation {
            PendingToolOperation::Prepared(prepared) => prepared.name(),
            PendingToolOperation::Rejected(rejected) => &rejected.name,
        }
    }

    fn started_item(&self, workspace: &Path) -> Option<ThreadItem> {
        match &self.operation {
            PendingToolOperation::Prepared(prepared) => Some(prepared.started_item(workspace)),
            PendingToolOperation::Rejected(_) => None,
        }
    }

    fn failed_result(&self, workspace: &Path, error: &AppError) -> ToolExecutionResult {
        match &self.operation {
            PendingToolOperation::Prepared(prepared) => prepared.failed_result(workspace, error),
            PendingToolOperation::Rejected(rejected) => rejected.failed_result(truncate_utf8(
                &error.to_string(),
                MAX_REJECTED_TOOL_ERROR_BYTES,
            )),
        }
    }

    async fn execute(
        &self,
        context: ToolExecutionContext<'_>,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<ToolExecutionResult, AppError> {
        match &self.operation {
            PendingToolOperation::Prepared(prepared) => {
                prepared.execute(context, cancellation).await
            }
            PendingToolOperation::Rejected(rejected) => Ok(rejected.result()),
        }
    }

    #[cfg(test)]
    fn rejected_result(&self) -> Option<ToolExecutionResult> {
        match &self.operation {
            PendingToolOperation::Prepared(_) => None,
            PendingToolOperation::Rejected(rejected) => Some(rejected.result()),
        }
    }
}

impl RejectedToolCall {
    fn new(item_id: String, name: &str, error: AppError) -> Self {
        Self {
            item_id,
            name: truncate_utf8(name, MAX_REJECTED_TOOL_NAME_BYTES),
            error: truncate_utf8(&error.to_string(), MAX_REJECTED_TOOL_ERROR_BYTES),
        }
    }

    fn result(&self) -> ToolExecutionResult {
        self.failed_result(self.error.clone())
    }

    fn failed_result(&self, error: String) -> ToolExecutionResult {
        let display_output = OutputSource::text(error.clone());
        ToolExecutionResult {
            provider_output: format!("Tool failed: {error}"),
            provider_content: None,
            completed_item: self.failed_item(),
            display_output: Some(display_output),
            background_command: None,
            visual_context: None,
        }
    }

    fn failed_item(&self) -> ThreadItem {
        ThreadItem::ToolExecution {
            id: self.item_id.clone(),
            name: self.name.clone(),
            description: format!("Rejected {} call", self.name),
            status: ActivityStatus::Failed,
            output_presentation: crate::engine::ToolOutputPresentation::PlainText,
            output: None,
        }
    }
}

async fn persist_and_emit_item(
    inner: &NativeEngineInner,
    app: &AppHandle,
    thread_id: &str,
    turn_id: &str,
    item: ThreadItem,
    output: Option<OutputSource>,
    started: bool,
) -> Result<(), AppError> {
    let item = if started {
        item
    } else {
        inner
            .storage
            .append_thread_item(turn_id.into(), item, output)
            .await?
    };
    emit_item_notification(inner, app, thread_id, turn_id, item, started)
}

pub(super) fn emit_item_notification(
    inner: &NativeEngineInner,
    app: &AppHandle,
    thread_id: &str,
    turn_id: &str,
    item: ThreadItem,
    started: bool,
) -> Result<(), AppError> {
    let notification = ItemNotification {
        thread_id: thread_id.into(),
        turn_id: turn_id.into(),
        item,
    };
    inner.emit_notification(
        app,
        if started {
            crate::engine::EngineNotification::ItemStarted(notification)
        } else {
            crate::engine::EngineNotification::ItemCompleted(notification)
        },
    )
}

fn visible_item(item: &ResponseItem) -> Result<Option<ThreadItem>, AppError> {
    match item {
        ResponseItem::Message { phase, .. } => {
            let item_id = required_visible_item_id(item)?;
            let text = item.assistant_text().ok_or_else(|| {
                AppError::Provider("provider emitted a non-assistant output message".into())
            })?;
            Ok(Some(ThreadItem::AgentMessage {
                id: item_id,
                text: strip_content_reference_markers(&text),
                phase: phase.map(|phase| match phase {
                    ResponseMessagePhase::Commentary => MessagePhase::Commentary,
                    ResponseMessagePhase::FinalAnswer => MessagePhase::FinalAnswer,
                }),
            }))
        }
        ResponseItem::Reasoning { .. } => {
            let item_id = required_visible_item_id(item)?;
            let (summary, content) = item.reasoning_text().ok_or_else(|| {
                AppError::Provider("reasoning output could not be decoded".into())
            })?;
            Ok(Some(ThreadItem::Reasoning {
                id: item_id,
                summary: summary
                    .into_iter()
                    .map(|part| strip_content_reference_markers(&part))
                    .collect(),
                content: content
                    .into_iter()
                    .map(|part| strip_content_reference_markers(&part))
                    .collect(),
            }))
        }
        ResponseItem::WebSearchCall { action, .. } => Ok(Some(ThreadItem::ToolExecution {
            id: required_visible_item_id(item)?,
            name: "web_search".into(),
            description: web_search_activity_detail(action.as_ref()),
            status: ActivityStatus::Completed,
            output_presentation: crate::engine::ToolOutputPresentation::PlainText,
            output: None,
        })),
        ResponseItem::FunctionCall { .. }
        | ResponseItem::FunctionCallOutput { .. }
        | ResponseItem::CustomToolCall { .. }
        | ResponseItem::CustomToolCallOutput { .. }
        | ResponseItem::Compaction { .. }
        | ResponseItem::CompactionTrigger { .. } => Ok(None),
    }
}

fn web_search_activity_detail(action: Option<&WebSearchAction>) -> String {
    let detail = match action {
        Some(WebSearchAction::Search { query, queries }) => query
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(str::trim)
            .map(str::to_string)
            .or_else(|| {
                let queries = queries
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>();
                (!queries.is_empty()).then(|| queries.join(" · "))
            }),
        Some(WebSearchAction::OpenPage { url }) | Some(WebSearchAction::FindInPage { url, .. }) => {
            url.as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        }
        None => None,
    };
    detail.unwrap_or_else(|| "Pesquisa na web".into())
}

fn required_visible_item_id(item: &ResponseItem) -> Result<String, AppError> {
    item.id()
        .map(str::to_string)
        .ok_or_else(|| AppError::Provider("visible response item is missing its id".into()))
}

pub(super) fn item_remains_in_progress(item: &ThreadItem) -> bool {
    matches!(
        item,
        ThreadItem::CommandExecution {
            status: ActivityStatus::InProgress,
            ..
        } | ThreadItem::FileChange {
            status: ActivityStatus::InProgress,
            ..
        } | ThreadItem::ToolExecution {
            status: ActivityStatus::InProgress,
            ..
        }
    )
}

pub(super) fn validate_response_item(item: &ResponseItem) -> Result<(), AppError> {
    validate_response_item_with_limit(item, MAX_PROVIDER_ITEM_BYTES)
}

fn validate_local_response_item(item: &ResponseItem) -> Result<(), AppError> {
    validate_response_item_with_limit(item, MAX_LOCAL_PROVIDER_ITEM_BYTES)
}

fn validate_response_item_with_limit(
    item: &ResponseItem,
    maximum_bytes: usize,
) -> Result<(), AppError> {
    if let Some(id) = item.id() {
        validate_provider_id(id)?;
    }
    let encoded = serde_json::to_vec(item).map_err(|error| {
        AppError::Provider(format!("response item could not be encoded: {error}"))
    })?;
    if encoded.len() > maximum_bytes {
        return Err(AppError::Provider(format!(
            "response item exceeds {maximum_bytes} bytes"
        )));
    }
    match item {
        ResponseItem::FunctionCall {
            namespace,
            name,
            call_id,
            ..
        } => {
            validate_provider_id(call_id)?;
            validate_tool_namespace(namespace.as_deref())?;
            if name.is_empty()
                || name.len() > MAX_TOOL_NAME_BYTES
                || name.chars().any(char::is_control)
            {
                return Err(AppError::Provider("tool name is invalid".into()));
            }
        }
        ResponseItem::CustomToolCall {
            namespace,
            name,
            call_id,
            ..
        } => {
            validate_provider_id(call_id)?;
            validate_tool_namespace(namespace.as_deref())?;
            if name.is_empty()
                || name.len() > MAX_TOOL_NAME_BYTES
                || name.chars().any(char::is_control)
            {
                return Err(AppError::Provider("custom tool name is invalid".into()));
            }
        }
        ResponseItem::Compaction { .. } => {
            let (encrypted_content, turn_id) = item.compaction_checkpoint().ok_or_else(|| {
                AppError::Provider("compaction checkpoint could not be decoded".into())
            })?;
            if encrypted_content.is_empty() {
                return Err(AppError::Provider("compaction checkpoint is empty".into()));
            }
            if let Some(turn_id) = turn_id {
                validate_provider_id(turn_id)?;
            }
        }
        ResponseItem::CompactionTrigger { .. } => {
            return Err(AppError::Provider(
                "provider returned a compaction trigger as output".into(),
            ));
        }
        _ => {}
    }
    Ok(())
}

fn validate_tool_namespace(namespace: Option<&str>) -> Result<(), AppError> {
    if namespace.is_some_and(|namespace| {
        namespace.len() > MAX_TOOL_NAME_BYTES || namespace.chars().any(char::is_control)
    }) {
        Err(AppError::Provider("tool namespace is invalid".into()))
    } else {
        Ok(())
    }
}

fn validate_delta(item_id: &str, delta: &str) -> Result<(), AppError> {
    validate_provider_id(item_id)?;
    if delta.len() > MAX_PROVIDER_ITEM_BYTES {
        return Err(AppError::Provider("stream delta is too large".into()));
    }
    Ok(())
}

fn validate_provider_id(value: &str) -> Result<(), AppError> {
    if crate::command_validation::identifier_is_valid(value) {
        Ok(())
    } else {
        Err(AppError::Provider("provider item id is invalid".into()))
    }
}

fn add_input_bytes(total: &mut usize, bytes: usize) -> Result<(), AppError> {
    *total = total
        .checked_add(bytes)
        .ok_or_else(|| AppError::InvalidAttachment("turn input size overflow".into()))?;
    if *total > MAX_RAW_INPUT_BYTES {
        return Err(AppError::InvalidAttachment(format!(
            "combined turn input exceeds {} MiB",
            MAX_RAW_INPUT_BYTES / 1_048_576
        )));
    }
    Ok(())
}

fn tool_failure_diagnostic(tool_name: &str, item: &ThreadItem) -> Option<String> {
    match item {
        ThreadItem::CommandExecution {
            status: ActivityStatus::Failed,
            exit_code,
            ..
        } => Some(match exit_code {
            Some(exit_code) => format!("tool `{tool_name}` exited with code {exit_code}"),
            None => format!("tool `{tool_name}` failed without an exit code"),
        }),
        ThreadItem::FileChange {
            status: ActivityStatus::Failed,
            ..
        } => Some(format!(
            "tool `{tool_name}` could not apply its file changes"
        )),
        ThreadItem::ToolExecution {
            status: ActivityStatus::Failed,
            output,
            ..
        } => {
            let detail = output
                .as_ref()
                .map(|output| output.preview.trim())
                .filter(|message| !message.is_empty())
                .map(|message| truncate_utf8(message, MAX_REJECTED_TOOL_ERROR_BYTES));
            Some(match detail {
                Some(detail) => format!("tool `{tool_name}` failed: {detail}"),
                None => format!("tool `{tool_name}` failed"),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        MAX_AUTOMATIC_PROVIDER_RETRY_DELAY_SECONDS, MAX_AUTOMATIC_RATE_LIMIT_WAIT_SECONDS,
        PendingTool, ToolReadSegment, add_input_bytes, automatic_provider_retry_wait,
        automatic_rate_limit_wait, hosted_web_search_tool, item_remains_in_progress,
        local_provider_tools, local_tool_name, local_tools_enabled, prepare_user_input,
        record_turn_state, tool_failure_diagnostic, validate_local_response_item,
        validate_response_item, web_search_activity_detail,
    };
    use crate::engine::native::provider::ModelToolMode;
    use crate::engine::native::provider::{ResponseItem, ResponseProtocol, WebSearchAction};
    use crate::engine::native::tools::{ToolExecutionResult, ToolRegistry};
    use crate::engine::{
        ActivityStatus, CommandLiveOutput, CommandSource, ConversationMode, PermissionProfile,
        ThreadItem, TurnInput, WebSearchMode,
    };

    #[test]
    fn model_tool_modes_expose_only_their_intended_top_level_contracts() {
        let registry = ToolRegistry;
        let names = |mode| {
            local_provider_tools(
                &registry,
                PermissionProfile::workspace_write(),
                true,
                true,
                None,
                mode,
            )
            .into_iter()
            .filter_map(|definition| definition["name"].as_str().map(str::to_string))
            .collect::<std::collections::BTreeSet<_>>()
        };

        let direct = names(ModelToolMode::Direct);
        assert!(direct.contains("read_file"));
        assert!(!direct.contains("exec"));
        assert!(!direct.contains("wait"));

        let hybrid = names(ModelToolMode::CodeMode);
        assert!(hybrid.contains("read_file"));
        assert!(hybrid.contains("exec"));
        assert!(hybrid.contains("wait"));

        assert_eq!(
            names(ModelToolMode::CodeModeOnly),
            std::collections::BTreeSet::from(["exec".into(), "wait".into()])
        );

        let code_mode_only = local_provider_tools(
            &registry,
            PermissionProfile::workspace_write(),
            true,
            true,
            None,
            ModelToolMode::CodeModeOnly,
        );
        let exec_description = code_mode_only
            .iter()
            .find(|definition| definition["name"] == "exec")
            .and_then(|definition| definition["description"].as_str())
            .expect("CodeModeOnly must describe the exec tool");
        assert!(exec_description.contains("read_file(args:"));
        assert!(exec_description.contains("apply_patch(input: string): Promise<string>;"));
        assert!(exec_description.contains("view_image(args:"));
        assert!(!exec_description.contains("spawn_agent(args:"));

        let code_mode_only_with_collaboration = local_provider_tools(
            &registry,
            PermissionProfile::workspace_write(),
            true,
            true,
            Some(&[]),
            ModelToolMode::CodeModeOnly,
        );
        let names = code_mode_only_with_collaboration
            .iter()
            .filter_map(|definition| definition["name"].as_str())
            .collect::<std::collections::BTreeSet<_>>();
        for name in [
            "exec",
            "wait",
            "spawn_agent",
            "send_message",
            "followup_task",
            "interrupt_agent",
            "list_agents",
            "wait_agent",
        ] {
            assert!(names.contains(name));
        }
    }

    #[tokio::test]
    async fn user_images_are_fully_decoded_before_reaching_the_provider() {
        let directory = tempfile::tempdir().expect("temporary directory should exist");
        let path = directory.path().join("invalid.png");
        tokio::fs::write(&path, b"\x89PNG\r\n\x1a\ninvalid")
            .await
            .expect("invalid image fixture should exist");

        let result = prepare_user_input(
            "message-1".into(),
            vec![TurnInput::LocalImage {
                path: path.to_string_lossy().into_owned(),
            }],
        )
        .await;
        let Err(error) = result else {
            panic!("signature-only images must not reach the provider");
        };

        assert!(error.to_string().contains("safe decode limits"));
    }

    #[tokio::test]
    async fn prepared_user_input_reuses_the_client_identity_for_provider_retries() {
        let first = prepare_user_input(
            "client-message-1".into(),
            vec![TurnInput::Text("hello".into())],
        )
        .await
        .expect("first input should prepare");
        let retried = prepare_user_input(
            "client-message-1".into(),
            vec![TurnInput::Text("hello".into())],
        )
        .await
        .expect("retried input should prepare");

        assert_eq!(first.provider_item.id(), retried.provider_item.id());
        assert!(
            first
                .provider_item
                .id()
                .is_some_and(|id| id.starts_with("msg_"))
        );
        assert!(matches!(
            first.user_item,
            ThreadItem::UserMessage { id, .. } if id == "client-message-1"
        ));
    }

    #[test]
    fn a_yielded_command_keeps_started_notification_semantics() {
        let running = ThreadItem::CommandExecution {
            id: "command-1".into(),
            command: "cargo test".into(),
            cwd: ".".into(),
            process_id: Some("session-1".into()),
            started_at: Some(1),
            source: CommandSource::Agent,
            status: ActivityStatus::InProgress,
            aggregated_output: None,
            live_output: Some(CommandLiveOutput::default()),
            exit_code: None,
            duration_ms: None,
        };
        let mut completed = running.clone();
        let ThreadItem::CommandExecution {
            status,
            live_output,
            exit_code,
            duration_ms,
            ..
        } = &mut completed
        else {
            panic!("command fixture changed type");
        };
        *status = ActivityStatus::Completed;
        *live_output = None;
        *exit_code = Some(0);
        *duration_ms = Some(10);

        assert!(item_remains_in_progress(&running));
        assert!(!item_remains_in_progress(&completed));
    }

    fn stored_tool_item(result: &ToolExecutionResult) -> ThreadItem {
        let mut item = result.completed_item.clone();
        if let ThreadItem::ToolExecution { output, .. } = &mut item {
            *output = result
                .display_output
                .as_ref()
                .map(|source| source.reference());
        }
        item
    }

    #[test]
    fn duplicate_pure_reads_reference_one_leader_without_repeating_the_output() {
        let registry = ToolRegistry;
        let first = PendingTool::function(
            &registry,
            "read-item-1".into(),
            None,
            "read_file",
            r#"{"path":"src/lib.rs","start_line":1,"end_line":20}"#,
            "read-call-1".into(),
        );
        let duplicate = PendingTool::function(
            &registry,
            "read-item-2".into(),
            None,
            "read_file",
            r#"{"path":"src/lib.rs","start_line":1,"end_line":20}"#,
            "read-call-2".into(),
        );
        let distinct = PendingTool::function(
            &registry,
            "read-item-3".into(),
            None,
            "read_file",
            r#"{"path":"src/lib.rs","start_line":21,"end_line":40}"#,
            "read-call-3".into(),
        );
        let batch = [first, duplicate, distinct];
        let mut reads = ToolReadSegment::default();
        let duplicates = batch
            .iter()
            .map(|pending| {
                reads
                    .admit(pending, Path::new(r"C:\workspace"), "thread-1")
                    .1
            })
            .collect::<Vec<_>>();
        assert_eq!(duplicates, [None, Some("read-call-1".into()), None]);
        let result = batch[1].duplicate_read_result(Path::new(r"C:\workspace"), "read-call-1");
        assert!(result.provider_output.contains("read-call-1"));
        assert!(result.display_output.is_none());
        assert!(matches!(
            result.completed_item,
            ThreadItem::ToolExecution {
                status: ActivityStatus::Completed,
                output: None,
                ..
            }
        ));
    }

    #[test]
    fn mutation_calls_never_enter_the_read_deduplication_domain() {
        let mutation = PendingTool::function(
            &ToolRegistry,
            "edit-item".into(),
            None,
            "edit_file",
            r#"{"path":"src/lib.rs","old_text":"old","new_text":"new","expected_occurrences":1}"#,
            "edit-call".into(),
        );
        let mut reads = ToolReadSegment::default();
        let (before, _) = reads.admit(&mutation, Path::new(r"C:\workspace"), "thread-1");
        let (after, duplicate) = reads.admit(&mutation, Path::new(r"C:\workspace"), "thread-1");
        assert_eq!(duplicate, None);
        assert!(!std::sync::Arc::ptr_eq(&before, &after));
    }

    #[test]
    fn combined_input_is_bounded() {
        let mut total = super::MAX_RAW_INPUT_BYTES;
        assert!(add_input_bytes(&mut total, 1).is_err());
    }

    #[test]
    fn automatic_rate_limit_wait_is_positive_and_bounded() {
        assert_eq!(automatic_rate_limit_wait(0).as_secs(), 1);
        assert_eq!(automatic_rate_limit_wait(3_600).as_secs(), 3_600);
        assert_eq!(
            automatic_rate_limit_wait(u64::MAX).as_secs(),
            MAX_AUTOMATIC_RATE_LIMIT_WAIT_SECONDS
        );
    }

    #[test]
    fn transient_provider_retry_uses_unbounded_attempts_with_bounded_backoff() {
        assert_eq!(automatic_provider_retry_wait(0).as_secs(), 1);
        assert_eq!(automatic_provider_retry_wait(1).as_secs(), 1);
        assert_eq!(automatic_provider_retry_wait(2).as_secs(), 2);
        assert_eq!(automatic_provider_retry_wait(6).as_secs(), 32);
        assert_eq!(
            automatic_provider_retry_wait(u32::MAX).as_secs(),
            MAX_AUTOMATIC_PROVIDER_RETRY_DELAY_SECONDS
        );
    }

    #[test]
    fn chat_never_receives_local_agent_tools() {
        assert!(!local_tools_enabled(ConversationMode::Chat));
        assert!(local_tools_enabled(ConversationMode::Work));
        assert!(local_tools_enabled(ConversationMode::Codex));
    }

    #[test]
    fn responses_lite_never_receives_a_hosted_web_search_tool() {
        assert_eq!(
            hosted_web_search_tool(WebSearchMode::Live, ResponseProtocol::Lite, true),
            None
        );
    }

    #[test]
    fn standard_web_search_preserves_the_catalog_content_types() {
        assert_eq!(
            hosted_web_search_tool(WebSearchMode::Live, ResponseProtocol::Standard, true),
            Some(serde_json::json!({
                "type": "web_search",
                "external_web_access": true,
                "search_content_types": ["text", "image"]
            }))
        );
        assert_eq!(
            hosted_web_search_tool(WebSearchMode::Live, ResponseProtocol::Standard, false),
            Some(serde_json::json!({
                "type": "web_search",
                "external_web_access": true
            }))
        );
        assert_eq!(
            hosted_web_search_tool(WebSearchMode::Disabled, ResponseProtocol::Standard, true),
            None
        );
    }

    #[test]
    fn turn_routing_state_keeps_the_first_value_within_one_turn() {
        let mut state = None;
        record_turn_state(&mut state, "route-1".into()).expect("first route should be recorded");
        record_turn_state(&mut state, "route-1".into()).expect("same route should be idempotent");
        record_turn_state(&mut state, "route-2".into())
            .expect("later provider metadata must not replace or fail the active route");
        assert_eq!(state.as_deref(), Some("route-1"));
    }

    #[test]
    fn web_search_activity_uses_the_query_or_url_without_debug_syntax() {
        let search = WebSearchAction::Search {
            query: Some("  Codex app activity messages  ".into()),
            queries: None,
        };
        let page = WebSearchAction::OpenPage {
            url: Some("https://developers.openai.com/codex/app/".into()),
        };

        assert_eq!(
            web_search_activity_detail(Some(&search)),
            "Codex app activity messages"
        );
        assert_eq!(
            web_search_activity_detail(Some(&page)),
            "https://developers.openai.com/codex/app/"
        );
        assert_eq!(web_search_activity_detail(None), "Pesquisa na web");
    }

    #[test]
    fn invalid_tool_arguments_become_a_recoverable_provider_result() {
        let arguments = serde_json::json!({
            "explanation": null,
            "plan": [
                { "step": "Primeira", "status": "in_progress" },
                { "step": "Segunda", "status": "in_progress" }
            ]
        })
        .to_string();
        let pending = PendingTool::function(
            &ToolRegistry,
            "item-1".into(),
            None,
            "update_plan",
            &arguments,
            "call-1".into(),
        );
        let result = pending
            .rejected_result()
            .expect("invalid arguments should remain inside the tool loop");

        assert!(
            result
                .provider_output
                .contains("plan must not contain more than one in-progress step")
        );
        assert!(
            tool_failure_diagnostic("update_plan", &stored_tool_item(&result))
                .is_some_and(|message| message.contains("more than one in-progress step"))
        );
        assert!(result.display_output.as_ref().is_some_and(|output| {
            output
                .reference()
                .preview
                .contains("more than one in-progress step")
        }));
        match result.completed_item {
            ThreadItem::ToolExecution {
                id,
                name,
                status,
                output,
                ..
            } => {
                assert_eq!(id, "item-1");
                assert_eq!(name, "update_plan");
                assert!(matches!(status, ActivityStatus::Failed));
                assert!(output.is_none());
            }
            item => panic!("unexpected rejected-tool item: {item:?}"),
        }
    }

    #[test]
    fn invalid_custom_tool_input_becomes_a_recoverable_provider_result() {
        let pending = PendingTool::custom(
            &ToolRegistry,
            "patch-1".into(),
            None,
            "apply_patch",
            "*** Begin Patch\n*** Update File: source.txt\n@@\n*** End Patch",
            "call-1".into(),
        );
        let result = pending
            .rejected_result()
            .expect("invalid custom input should remain inside the tool loop");

        assert!(result.provider_output.contains("invalid patch"));
        assert!(
            tool_failure_diagnostic("apply_patch", &stored_tool_item(&result))
                .is_some_and(|message| message.contains("invalid patch"))
        );
        assert!(matches!(
            result.completed_item,
            ThreadItem::ToolExecution {
                name,
                status: ActivityStatus::Failed,
                ..
            } if name == "apply_patch"
        ));
    }

    #[test]
    fn rejected_tool_result_does_not_invent_a_timeline_id() {
        let pending = PendingTool::function(
            &ToolRegistry,
            String::new(),
            None,
            "future_tool",
            "{}",
            "call-1".into(),
        );
        let result = pending
            .rejected_result()
            .expect("invalid tool identity should remain a rejected result");

        assert!(matches!(
            result.completed_item,
            ThreadItem::ToolExecution { id, name, .. }
                if id.is_empty() && name == "future_tool"
        ));
    }

    #[test]
    fn provider_tool_names_reject_control_characters() {
        let item = ResponseItem::FunctionCall {
            id: Some("item-1".into()),
            namespace: None,
            name: "read_\nfile".into(),
            arguments: "{}".into(),
            call_id: "call-1".into(),
        };

        assert!(validate_response_item(&item).is_err());
    }

    #[test]
    fn only_the_advertised_function_namespace_can_execute_local_tools() {
        assert_eq!(
            local_tool_name(None, "read_file").expect("legacy call"),
            "read_file"
        );
        assert_eq!(
            local_tool_name(Some(""), "read_file").expect("empty legacy namespace"),
            "read_file"
        );
        assert_eq!(
            local_tool_name(Some("functions"), "read_file").expect("Lite namespace"),
            "read_file"
        );
        assert!(local_tool_name(Some("foreign"), "read_file").is_err());
    }

    #[test]
    fn locally_generated_image_outputs_use_the_request_limit_not_the_stream_limit() {
        let item = ResponseItem::function_output_with_image(
            "call-view-image".into(),
            None,
            format!("data:image/png;base64,{}", "A".repeat(4_600_000)),
            Some(crate::engine::ImageDetail::High),
        );

        assert!(validate_response_item(&item).is_err());
        validate_local_response_item(&item)
            .expect("bounded local image output should fit the provider request contract");
    }
}
