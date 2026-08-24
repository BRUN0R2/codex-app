use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::OnceLock;

use base64::{Engine as _, prelude::BASE64_STANDARD};
use futures_util::future::join_all;
use serde_json::json;
use tauri::AppHandle;
use tokio::sync::watch;
use uuid::Uuid;

use super::compaction::compact_context;
use super::content_references::strip_content_reference_markers;
use super::context_window::{ContextUsageSnapshot, evaluate_context_window, full_context_usage};
use super::output::OutputSource;
use super::provider::{
    ResponseContent, ResponseEvent, ResponseItem, ResponseMessagePhase, ResponseRequest,
    ResponseRequestSettings, SelectedModel, WebSearchAction, normalize_provider_history,
};
use super::storage::ProviderHistorySnapshot;
use super::stream_notifications::StreamNotificationBatcher;
use super::text::truncate_utf8;
use super::tools::{
    MAX_PROVIDER_ITEM_BYTES, PreparedTool, ReadToolCache, ReadToolCacheKey, ToolExecutionContext,
    ToolExecutionResult, ToolRegistry,
};
use super::turn_recovery;
use super::{NativeEngineInner, TurnContinuation};
use crate::attachments::{AttachmentKind, detect_image_media_type, inspect_path};
use crate::engine::{
    ActivityStatus, AppConfig, ConversationMode, DiagnosticStream, ImageDetail, ItemNotification,
    MessagePhase, ModelRerouteReason, ModelReroutedNotification,
    ModelSafetyBufferingUpdatedNotification, ModelVerificationNotification, PermissionProfile,
    Personality, StreamDelta, ThreadItem, TurnInput, WebSearchMode,
};
use crate::error::AppError;

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
const MAX_INSTRUCTIONS_BYTES: usize = 524_288;
const MAX_TURN_PREVIEW_BYTES: usize = 160;
const MAX_TOOL_NAME_BYTES: usize = 128;
const MAX_REJECTED_TOOL_NAME_BYTES: usize = 128;
const MAX_REJECTED_TOOL_ERROR_BYTES: usize = 4_096;
const MAX_PARALLEL_TOOLS: usize = 8;
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
    pub reasoning_effort: Option<crate::engine::ReasoningEffort>,
    pub service_tier: Option<String>,
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
    instructions: &'a str,
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
                if detect_image_media_type(&bytes) != Some(media_type.as_str()) {
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
            id: client_user_message_id,
            content: user_content,
        },
        provider_item: ResponseItem::user_content(provider_content),
        preview: preview.unwrap_or_else(|| "New conversation".into()),
    })
}

pub(super) async fn run_turn(
    inner: Arc<NativeEngineInner>,
    app: AppHandle,
    mut run: TurnRun,
) -> Result<RunCompletion, AppError> {
    let instructions = compose_instructions(&run.model, &run.workspace, &run.config, run.mode)?;
    let mut provider_state = TurnProviderState::default();
    let tools = provider_tools(&inner, &run.config, run.mode);
    let mut history = load_prompt_history(&inner, &app, &run.thread_id).await?;
    let mut context_snapshot = inner
        .storage
        .latest_context_usage(run.thread_id.clone())
        .await?;
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
                    instructions: &instructions,
                    snapshot: &mut context_snapshot,
                    tools,
                },
                &mut run,
                &mut provider_state,
                &mut history,
            )
            .await?
            {
                return Ok(RunCompletion::Interrupted);
            }
            let sampled_through_steer_sequence = promoted_through_steer_sequence;
            let request = ResponseRequest::new(
                run.model.id(),
                &instructions,
                &history.items,
                tools,
                ResponseRequestSettings {
                    parallel_tool_calls: run.model.supports_parallel_tool_calls(),
                    reasoning_effort: run.reasoning_effort,
                    service_tier: run.service_tier.as_deref(),
                    prompt_cache_key: Some(&run.thread_id),
                    verbosity: run.config.model_verbosity,
                },
            );
            let mut stream = match inner
                .provider
                .start_response(
                    &app,
                    &inner.auth,
                    request,
                    &run.thread_id,
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
                                instructions: &instructions,
                                snapshot: &mut context_snapshot,
                                tools,
                            },
                            &mut run,
                            &mut provider_state,
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
            let mut pending_tools = Vec::new();
            let mut saw_completed = false;

            loop {
                let event = match stream.next_event(&mut run.cancellation).await {
                    Ok(Some(event)) => event,
                    Ok(None) => break,
                    Err(error) => {
                        if let Some(decision) =
                            turn_recovery::classify(&error, &mut transient_failure_count)
                        {
                            stream_deltas.flush().await?;
                            if turn_recovery::wait_for_retry(
                                &inner, &app, &mut run, &error, decision,
                            )
                            .await
                            {
                                continue 'sampling;
                            }
                            return Ok(RunCompletion::Interrupted);
                        }
                        if matches!(&error, AppError::ContextWindowExceeded(_)) {
                            stream_deltas.flush().await?;
                            match recover_from_context_window(
                                SamplingContext {
                                    app: &app,
                                    inner: &inner,
                                    instructions: &instructions,
                                    snapshot: &mut context_snapshot,
                                    tools,
                                },
                                &mut run,
                                &mut provider_state,
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
                transient_failure_count = 0;
                if !matches!(
                    &event,
                    ResponseEvent::OutputTextDelta { .. }
                        | ResponseEvent::ReasoningSummaryDelta { .. }
                        | ResponseEvent::ReasoningContentDelta { .. }
                ) {
                    stream_deltas.flush().await?;
                }
                let Some(event) =
                    handle_provider_control_event(&inner, &app, &run, &mut provider_state, event)?
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
                        match item {
                            ResponseItem::FunctionCall {
                                id,
                                name,
                                arguments,
                                call_id,
                            } => {
                                let item_id = id.unwrap_or_else(|| call_id.clone());
                                pending_tools.push(PendingTool::function(
                                    &inner.tools,
                                    item_id,
                                    &name,
                                    &arguments,
                                    call_id,
                                ));
                            }
                            ResponseItem::CustomToolCall {
                                id,
                                call_id,
                                name,
                                input,
                            } => {
                                let item_id = id.unwrap_or_else(|| call_id.clone());
                                pending_tools.push(PendingTool::custom(
                                    &inner.tools,
                                    item_id,
                                    &name,
                                    &input,
                                    call_id,
                                ));
                            }
                            _ => {}
                        }
                    }
                    ResponseEvent::Completed(usage) => {
                        context_recovery_attempts = 0;
                        if let Some(usage) = usage {
                            context_snapshot = Some(ContextUsageSnapshot {
                                model: run.model.id().into(),
                                usage: usage.clone(),
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
                        saw_completed = true;
                        break;
                    }
                    ResponseEvent::Interrupted => return Ok(RunCompletion::Interrupted),
                    ResponseEvent::ServerModel(_)
                    | ResponseEvent::TurnState(_)
                    | ResponseEvent::ModelVerifications(_)
                    | ResponseEvent::SafetyBuffering(_) => {
                        return Err(AppError::State(
                            "provider control event escaped its handler".into(),
                        ));
                    }
                }
            }
            stream_deltas.flush().await?;
            if !saw_completed {
                return Err(AppError::Provider(
                    "response stream ended before response.completed".into(),
                ));
            }
            match inner
                .turn_continuation(
                    &run.thread_id,
                    &run.turn_id,
                    sampled_through_steer_sequence,
                    !pending_tools.is_empty(),
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

            let allow_parallel_tools = run.model.supports_parallel_tool_calls();
            let mut pending_tools = pending_tools.into_iter().peekable();
            let mut read_cache = ReadToolCache::default();
            let mut read_leaders = HashMap::<ReadToolCacheKey, String>::new();
            while let Some(first) = pending_tools.next() {
                let batch = collect_tool_batch(
                    first,
                    &mut pending_tools,
                    allow_parallel_tools,
                    run.config.permission_profile,
                );
                let (duplicate_reads, read_only_batch) = deduplicate_read_calls(
                    &batch,
                    &run.workspace,
                    &run.thread_id,
                    &mut read_leaders,
                );

                for pending in &batch {
                    if *run.cancellation.borrow() {
                        return Ok(RunCompletion::Interrupted);
                    }
                    if let Some(item) = pending.started_item(&run.workspace) {
                        inner.emit_notification(
                            &app,
                            crate::engine::EngineNotification::ItemStarted(ItemNotification {
                                thread_id: run.thread_id.clone(),
                                turn_id: run.turn_id.clone(),
                                item,
                            }),
                        )?;
                    }
                }

                let workspace = run.workspace.as_path();
                let thread_id = run.thread_id.as_str();
                let turn_id = run.turn_id.as_str();
                let executions =
                    batch
                        .iter()
                        .zip(duplicate_reads)
                        .map(|(pending, duplicate_of)| {
                            let mut cancellation = run.cancellation.clone();
                            let context = ToolExecutionContext {
                                engine: Arc::downgrade(&inner),
                                app: &app,
                                workspace,
                                permissions: run.config.permission_profile,
                                thread_id,
                                turn_id,
                                approvals: &inner.approvals,
                                storage: &inner.storage,
                                ripgrep: &inner.ripgrep,
                                command_sessions: &inner.command_sessions,
                                stream_deltas: &stream_deltas,
                                read_cache: &read_cache,
                            };
                            async move {
                                match duplicate_of {
                                    Some(original_call_id) => {
                                        Ok(pending
                                            .duplicate_read_result(workspace, &original_call_id))
                                    }
                                    None => pending.execute(context, &mut cancellation).await,
                                }
                            }
                        });
                let results = join_all(executions).await;
                stream_deltas.flush().await?;
                let mut interrupted = false;

                // Provider outputs remain in call order even when execution overlaps.
                for (pending, result) in batch.into_iter().zip(results) {
                    let pending_name = pending.name().to_string();
                    let mut result = match result {
                        Ok(result) => result,
                        Err(AppError::Cancelled(message)) => {
                            let error = AppError::Cancelled(message);
                            interrupted = true;
                            pending.failed_result(&run.workspace, &error)
                        }
                        Err(error) => {
                            inner.emit_diagnostic(
                                &app,
                                DiagnosticStream::Runtime,
                                format!("tool `{pending_name}` failed: {error}"),
                            );
                            let mut failure = pending.failed_result(&run.workspace, &error);
                            failure.provider_output = format!("Tool failed: {error}");
                            failure
                        }
                    };
                    let background_command = result.background_command.take();
                    let visual_context = result.visual_context.take();
                    let output = match (pending.output_kind, visual_context) {
                        (ToolOutputKind::Function, Some(visual)) => {
                            ResponseItem::function_output_with_image(
                                pending.call_id,
                                format!("{}\n\n{}", result.provider_output, visual.description),
                                visual.image_url,
                                Some(ImageDetail::High),
                            )
                        }
                        (ToolOutputKind::Function, None) => {
                            ResponseItem::function_output(pending.call_id, result.provider_output)
                        }
                        (ToolOutputKind::Custom, None) => {
                            ResponseItem::custom_output(pending.call_id, result.provider_output)
                        }
                        (ToolOutputKind::Custom, Some(_)) => {
                            return Err(AppError::State(
                                "custom tool produced unsupported visual context".into(),
                            ));
                        }
                    };
                    validate_response_item(&output)?;
                    let completed_item = match inner
                        .storage
                        .append_provider_and_thread_item(
                            run.thread_id.clone(),
                            run.turn_id.clone(),
                            std::slice::from_ref(&output),
                            result.completed_item,
                            result.display_output,
                        )
                        .await
                    {
                        Ok(item) => item,
                        Err(error) => {
                            if let Some(command) = background_command {
                                command.discard();
                            }
                            return Err(error);
                        }
                    };
                    if let Some(message) = tool_failure_diagnostic(&pending_name, &completed_item) {
                        inner.emit_diagnostic(&app, DiagnosticStream::Runtime, message);
                    }
                    let notification = emit_item_notification(
                        &inner,
                        &app,
                        &run.thread_id,
                        &run.turn_id,
                        completed_item,
                        false,
                    );
                    if let Some(command) = background_command {
                        command.commit();
                    }
                    notification?;
                }
                if interrupted {
                    return Ok(RunCompletion::Interrupted);
                }
                if !read_only_batch {
                    read_cache = ReadToolCache::default();
                    read_leaders.clear();
                }
            }
        }
    }
    .await;
    stream_deltas.flush().await?;
    result
}

async fn recover_from_context_window(
    context: SamplingContext<'_>,
    run: &mut TurnRun,
    provider_state: &mut TurnProviderState,
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
        context.instructions,
        provider_state,
        history,
        context.tools,
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
) -> &'static [serde_json::Value] {
    static WEB_ONLY_TOOLS: OnceLock<Vec<serde_json::Value>> = OnceLock::new();
    static FULL_WEB_TOOLS: OnceLock<Vec<serde_json::Value>> = OnceLock::new();
    static READ_ONLY_WEB_TOOLS: OnceLock<Vec<serde_json::Value>> = OnceLock::new();

    let local =
        local_tools_enabled(mode).then(|| inner.tools.definitions_for(config.permission_profile));
    if config.web_search != WebSearchMode::Live {
        return local.unwrap_or(&[]);
    }
    let web_search = || {
        json!({
            "type": "web_search",
            "external_web_access": true
        })
    };
    let Some(local) = local else {
        return WEB_ONLY_TOOLS.get_or_init(|| vec![web_search()]).as_slice();
    };
    let cache = if config.permission_profile.sandbox == crate::engine::SandboxMode::ReadOnly {
        &READ_ONLY_WEB_TOOLS
    } else {
        &FULL_WEB_TOOLS
    };
    cache
        .get_or_init(|| {
            let mut combined = local.to_vec();
            combined.push(web_search());
            combined
        })
        .as_slice()
}

const fn local_tools_enabled(mode: ConversationMode) -> bool {
    matches!(mode, ConversationMode::Work | ConversationMode::Codex)
}

pub(super) async fn load_prompt_history(
    inner: &NativeEngineInner,
    app: &AppHandle,
    thread_id: &str,
) -> Result<ProviderHistorySnapshot, AppError> {
    let mut history = inner
        .storage
        .provider_history_snapshot(thread_id.into())
        .await?;
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
    history: &mut ProviderHistorySnapshot,
) -> Result<bool, AppError> {
    let context_window = run.model.context_window();
    let status = evaluate_context_window(
        run.model.id(),
        context.instructions,
        &history.items,
        context.tools,
        context.snapshot.as_ref(),
        run.model.auto_compact_token_limit(),
        context_window.as_ref(),
    );
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
        context.instructions,
        provider_state,
        history,
        context.tools,
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

pub(super) fn handle_provider_control_event(
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

impl PendingTool {
    fn function(
        registry: &ToolRegistry,
        item_id: String,
        name: &str,
        arguments: &str,
        call_id: String,
    ) -> Self {
        Self::from_preparation(
            item_id.clone(),
            name,
            call_id,
            ToolOutputKind::Function,
            registry.prepare(item_id, name, arguments),
        )
    }

    fn custom(
        registry: &ToolRegistry,
        item_id: String,
        name: &str,
        input: &str,
        call_id: String,
    ) -> Self {
        Self::from_preparation(
            item_id.clone(),
            name,
            call_id,
            ToolOutputKind::Custom,
            registry.prepare_custom(item_id, name, input),
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

fn collect_tool_batch<I>(
    first: PendingTool,
    pending_tools: &mut std::iter::Peekable<I>,
    allow_parallel_tools: bool,
    permissions: PermissionProfile,
) -> Vec<PendingTool>
where
    I: Iterator<Item = PendingTool>,
{
    let parallel_batch = allow_parallel_tools && first.supports_parallel_execution(permissions);
    let mut batch = vec![first];
    while parallel_batch
        && batch.len() < MAX_PARALLEL_TOOLS
        && pending_tools
            .peek()
            .is_some_and(|pending| pending.supports_parallel_execution(permissions))
    {
        if let Some(pending) = pending_tools.next() {
            batch.push(pending);
        }
    }
    batch
}

fn deduplicate_read_calls(
    batch: &[PendingTool],
    workspace: &Path,
    thread_id: &str,
    leaders: &mut HashMap<ReadToolCacheKey, String>,
) -> (Vec<Option<String>>, bool) {
    let mut all_reads = true;
    let mut duplicates = Vec::with_capacity(batch.len());
    for pending in batch {
        let Some(key) = pending.read_dedup_key(workspace, thread_id) else {
            all_reads = false;
            duplicates.push(None);
            continue;
        };
        let duplicate_of = leaders.get(&key).cloned();
        if duplicate_of.is_none() {
            leaders.insert(key, pending.call_id.clone());
        }
        duplicates.push(duplicate_of);
    }
    (duplicates, all_reads)
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

fn compose_instructions(
    model: &SelectedModel,
    workspace: &Path,
    config: &AppConfig,
    mode: ConversationMode,
) -> Result<String, AppError> {
    let personality = match config.personality {
        Personality::Friendly => "Communicate warmly and clearly.",
        Personality::Pragmatic => "Be direct, practical, and concise.",
        Personality::None => "Do not apply an additional personality style.",
    };
    let developer = config
        .developer_instructions
        .as_deref()
        .map(|instructions| format!("\n\n# User developer instructions\n{instructions}"))
        .unwrap_or_default();
    let browser_guidance = "The built-in browser tools control the visible browser attached to this conversation. \
        For interface QA, open or navigate with browser_manage, inspect with browser_snapshot before using element refs, \
        treat refs as stale after page changes, and use browser_metrics to verify latency and runtime findings. \
        Browser actions return a fresh viewport screenshot to your next reasoning round.";
    let runtime = match mode {
        ConversationMode::Chat => format!(
            "# ChatGPT Chat\n\
             You are ChatGPT in Chat mode. Help the user ask questions, explore ideas, learn, \
             and have a natural back-and-forth conversation. Do not claim access to local files, \
             applications, shell commands, or coding tools. Use only tools advertised in this request. \
             Give the answer directly unless the user asks for a larger deliverable. {personality}"
        ),
        ConversationMode::Work => format!(
            "{}\n\n# ChatGPT Work — local\n\
             You are completing a substantial task through ChatGPT Work in local mode. \
             The local workspace is {}. Use only tools advertised in this request, and treat tool paths \
             as workspace-relative. Drive the task to a reviewable result. For multi-step work, publish \
             a concise plan with update_plan and keep its statuses current. Skip a plan for trivial work. \
             {browser_guidance} \
             Never claim an operation succeeded until its tool result confirms it. \
             Surface blockers and failures plainly. {personality}",
            model.instructions(),
            workspace.display(),
        ),
        ConversationMode::Codex => format!(
            "{}\n\n# Native Codex Desktop runtime\n\
             You are operating through an independent desktop runtime in workspace {}. \
             Use only the tools advertised in this request. Tool paths are workspace-relative. \
             For multi-step work, publish a concise plan with update_plan and keep its statuses current. \
             Skip a plan for trivial requests. \
             {browser_guidance} \
             Never claim an operation succeeded until its tool result confirms it. \
             Surface blockers and failures plainly. {personality}",
            model.instructions(),
            workspace.display(),
        ),
    };
    let instructions = format!("{runtime}{developer}");
    if instructions.len() > MAX_INSTRUCTIONS_BYTES {
        return Err(AppError::Protocol(format!(
            "combined instructions exceed {MAX_INSTRUCTIONS_BYTES} bytes"
        )));
    }
    Ok(instructions)
}

pub(super) fn validate_response_item(item: &ResponseItem) -> Result<(), AppError> {
    if let Some(id) = item.id() {
        validate_provider_id(id)?;
    }
    let encoded = serde_json::to_vec(item).map_err(|error| {
        AppError::Provider(format!("response item could not be encoded: {error}"))
    })?;
    if encoded.len() > MAX_PROVIDER_ITEM_BYTES {
        return Err(AppError::Provider(format!(
            "response item exceeds {MAX_PROVIDER_ITEM_BYTES} bytes"
        )));
    }
    match item {
        ResponseItem::FunctionCall { name, call_id, .. } => {
            validate_provider_id(call_id)?;
            if name.is_empty()
                || name.len() > MAX_TOOL_NAME_BYTES
                || name.chars().any(char::is_control)
            {
                return Err(AppError::Provider("tool name is invalid".into()));
            }
        }
        ResponseItem::CustomToolCall { name, call_id, .. } => {
            validate_provider_id(call_id)?;
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
    use std::collections::HashMap;
    use std::path::Path;

    use super::{
        MAX_AUTOMATIC_PROVIDER_RETRY_DELAY_SECONDS, MAX_AUTOMATIC_RATE_LIMIT_WAIT_SECONDS,
        PendingTool, add_input_bytes, automatic_provider_retry_wait, automatic_rate_limit_wait,
        collect_tool_batch, deduplicate_read_calls, local_tools_enabled, record_turn_state,
        tool_failure_diagnostic, validate_response_item, web_search_activity_detail,
    };
    use crate::engine::native::provider::{ResponseItem, WebSearchAction};
    use crate::engine::native::tools::{ToolExecutionResult, ToolRegistry};
    use crate::engine::{ActivityStatus, ConversationMode, PermissionProfile, ThreadItem};

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
            "read_file",
            r#"{"path":"src/lib.rs","start_line":1,"end_line":20}"#,
            "read-call-1".into(),
        );
        let duplicate = PendingTool::function(
            &registry,
            "read-item-2".into(),
            "read_file",
            r#"{"path":"src/lib.rs","start_line":1,"end_line":20}"#,
            "read-call-2".into(),
        );
        let distinct = PendingTool::function(
            &registry,
            "read-item-3".into(),
            "read_file",
            r#"{"path":"src/lib.rs","start_line":21,"end_line":40}"#,
            "read-call-3".into(),
        );
        let batch = [first, duplicate, distinct];
        let mut leaders = HashMap::new();

        let (duplicates, all_reads) =
            deduplicate_read_calls(&batch, Path::new(r"C:\workspace"), "thread-1", &mut leaders);

        assert!(all_reads);
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
            "edit_file",
            r#"{"path":"src/lib.rs","old_text":"old","new_text":"new","expected_occurrences":1}"#,
            "edit-call".into(),
        );
        let mut leaders = HashMap::new();

        let (duplicates, all_reads) = deduplicate_read_calls(
            &[mutation],
            Path::new(r"C:\workspace"),
            "thread-1",
            &mut leaders,
        );

        assert!(!all_reads);
        assert_eq!(duplicates, [None]);
        assert!(leaders.is_empty());
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
    fn tool_batches_overlap_only_consecutive_explicitly_safe_operations() {
        let registry = ToolRegistry;
        let read = |item_id: &str| {
            PendingTool::function(
                &registry,
                item_id.into(),
                "read_file",
                r#"{"path":"source.rs","start_line":1,"end_line":1}"#,
                format!("call-{item_id}"),
            )
        };
        let command = |item_id: &str, parallel_safe: bool| {
            PendingTool::function(
                &registry,
                item_id.into(),
                "exec_command",
                &serde_json::json!({
                    "command": "Get-Date",
                    "cwd": ".",
                    "reason": "test",
                    "parallel_safe": parallel_safe,
                    "yield_time_ms": null,
                    "timeout_seconds": null
                })
                .to_string(),
                format!("call-{item_id}"),
            )
        };

        let mut tools = vec![
            read("read-1"),
            command("command-safe", true),
            command("command-exclusive", false),
            read("read-2"),
        ]
        .into_iter()
        .peekable();
        let parallel = collect_tool_batch(
            tools.next().expect("the first tool should exist"),
            &mut tools,
            true,
            PermissionProfile::full_access(),
        );
        assert_eq!(
            parallel.iter().map(PendingTool::name).collect::<Vec<_>>(),
            ["read_file", "exec_command"]
        );

        let exclusive = collect_tool_batch(
            tools.next().expect("the exclusive command should remain"),
            &mut tools,
            true,
            PermissionProfile::full_access(),
        );
        assert_eq!(exclusive.len(), 1);
        assert_eq!(exclusive[0].name(), "exec_command");

        let trailing = collect_tool_batch(
            tools.next().expect("the trailing read should remain"),
            &mut tools,
            true,
            PermissionProfile::full_access(),
        );
        assert_eq!(trailing.len(), 1);
        assert_eq!(trailing[0].name(), "read_file");
        assert!(tools.next().is_none());

        let mut approval_tools = vec![command("approval-command", true), read("approval-read")]
            .into_iter()
            .peekable();
        let approval_batch = collect_tool_batch(
            approval_tools
                .next()
                .expect("the approval command should exist"),
            &mut approval_tools,
            true,
            PermissionProfile::workspace_write(),
        );
        assert_eq!(approval_batch.len(), 1);
        assert_eq!(approval_batch[0].name(), "exec_command");

        let mut sequential_reads = vec![read("sequential-1"), read("sequential-2")]
            .into_iter()
            .peekable();
        let sequential_batch = collect_tool_batch(
            sequential_reads
                .next()
                .expect("the sequential read should exist"),
            &mut sequential_reads,
            false,
            PermissionProfile::full_access(),
        );
        assert_eq!(sequential_batch.len(), 1);
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
            name: "read_\nfile".into(),
            arguments: "{}".into(),
            call_id: "call-1".into(),
        };

        assert!(validate_response_item(&item).is_err());
    }
}
