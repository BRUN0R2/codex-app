use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::{Engine as _, prelude::BASE64_STANDARD};
use serde_json::json;
use tauri::AppHandle;
use tokio::sync::watch;
use uuid::Uuid;

use super::NativeEngineInner;
use super::compaction::compact_context;
use super::context_window::{evaluate_context_window, full_context_usage};
use super::provider::{
    ResponseContent, ResponseEvent, ResponseItem, ResponseMessagePhase, ResponseRequest,
    ResponseRequestSettings, SelectedModel, normalize_provider_history,
};
use super::tools::{MAX_PROVIDER_ITEM_BYTES, PreparedTool, ToolExecutionContext};
use crate::attachments::{AttachmentKind, detect_image_media_type, inspect_path};
use crate::engine::{
    ActivityStatus, AppConfig, DiagnosticStream, ImageDetail, IndexedTextDeltaNotification,
    ItemNotification, MessagePhase, ModelRerouteReason, ModelReroutedNotification,
    ModelSafetyBufferingUpdatedNotification, ModelVerificationNotification, Personality,
    TextDeltaNotification, ThreadItem, TurnInput, TurnModerationMetadataNotification,
    WebSearchMode,
};
use crate::error::AppError;

const MAX_USER_TEXT_BYTES: usize = 1_048_576;
const MAX_ATTACHMENT_TEXT_BYTES: usize = 2 * 1_048_576;
const MAX_IMAGE_BYTES: usize = 10 * 1_048_576;
const MAX_RAW_INPUT_BYTES: usize = 16 * 1_048_576;
const MAX_INSTRUCTIONS_BYTES: usize = 524_288;
const MAX_PROVIDER_ITEM_ID_BYTES: usize = 256;

pub(super) struct PreparedTurn {
    pub user_item: ThreadItem,
    pub provider_item: ResponseItem,
    pub preview: String,
}

pub(super) struct TurnRun {
    pub thread_id: String,
    pub turn_id: String,
    pub workspace: PathBuf,
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

struct SamplingInput {
    history: Vec<ResponseItem>,
    tools: Vec<serde_json::Value>,
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
                preview.get_or_insert_with(|| truncate_utf8(&text, 160));
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
    let instructions = compose_instructions(&run.model, &run.workspace, &run.config)?;
    let mut provider_state = TurnProviderState::default();

    loop {
        if *run.cancellation.borrow() {
            return Ok(RunCompletion::Interrupted);
        }
        let Some(SamplingInput { history, tools }) =
            prepare_sampling_input(&inner, &app, &mut run, &instructions, &mut provider_state)
                .await?
        else {
            return Ok(RunCompletion::Interrupted);
        };
        let request = ResponseRequest::new(
            run.model.id().into(),
            instructions.clone(),
            history,
            tools,
            ResponseRequestSettings {
                parallel_tool_calls: run.model.supports_parallel_tool_calls(),
                reasoning_effort: run.reasoning_effort,
                service_tier: run.service_tier.clone(),
                prompt_cache_key: Some(run.thread_id.clone()),
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
                if matches!(&error, AppError::ContextWindowExceeded(_)) {
                    persist_full_context_usage(&inner, &app, &run).await?;
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
                    if matches!(&error, AppError::ContextWindowExceeded(_)) {
                        persist_full_context_usage(&inner, &app, &run).await?;
                    }
                    return Err(error);
                }
            };
            let Some(event) =
                handle_provider_control_event(&inner, &app, &run, &mut provider_state, event)?
            else {
                continue;
            };
            match event {
                ResponseEvent::OutputTextDelta { item_id, delta } => {
                    validate_delta(&item_id, &delta)?;
                    inner.emit_notification(
                        &app,
                        crate::engine::EngineNotification::AgentTextDelta(TextDeltaNotification {
                            thread_id: run.thread_id.clone(),
                            turn_id: run.turn_id.clone(),
                            item_id,
                            delta,
                        }),
                    )?;
                }
                ResponseEvent::ReasoningSummaryDelta {
                    item_id,
                    summary_index,
                    delta,
                } => {
                    validate_delta(&item_id, &delta)?;
                    inner.emit_notification(
                        &app,
                        crate::engine::EngineNotification::ReasoningSummaryDelta(
                            IndexedTextDeltaNotification {
                                thread_id: run.thread_id.clone(),
                                turn_id: run.turn_id.clone(),
                                item_id,
                                index: summary_index,
                                delta,
                            },
                        ),
                    )?;
                }
                ResponseEvent::ReasoningContentDelta {
                    item_id,
                    content_index,
                    delta,
                } => {
                    validate_delta(&item_id, &delta)?;
                    inner.emit_notification(
                        &app,
                        crate::engine::EngineNotification::ReasoningTextDelta(
                            IndexedTextDeltaNotification {
                                thread_id: run.thread_id.clone(),
                                turn_id: run.turn_id.clone(),
                                item_id,
                                index: content_index,
                                delta,
                            },
                        ),
                    )?;
                }
                ResponseEvent::OutputItemDone(item) => {
                    validate_response_item(&item)?;
                    inner
                        .storage
                        .append_provider_item(run.thread_id.clone(), item.clone())
                        .await?;
                    if let Some(thread_item) = visible_item(&item)? {
                        persist_and_emit_item(
                            &inner,
                            &app,
                            &run.thread_id,
                            &run.turn_id,
                            thread_item,
                            false,
                        )
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
                            let prepared = inner.tools.prepare(item_id, &name, &arguments)?;
                            pending_tools.push(PendingTool {
                                call_id,
                                output_kind: ToolOutputKind::Function,
                                prepared,
                            });
                        }
                        ResponseItem::CustomToolCall {
                            id,
                            call_id,
                            name,
                            input,
                        } => {
                            let item_id = id.unwrap_or_else(|| call_id.clone());
                            let prepared = inner.tools.prepare_custom(item_id, &name, &input)?;
                            pending_tools.push(PendingTool {
                                call_id,
                                output_kind: ToolOutputKind::Custom,
                                prepared,
                            });
                        }
                        _ => {}
                    }
                }
                ResponseEvent::Completed(usage) => {
                    if let Some(usage) = usage {
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
                | ResponseEvent::TurnModerationMetadata(_)
                | ResponseEvent::SafetyBuffering(_) => {
                    return Err(AppError::State(
                        "provider control event escaped its handler".into(),
                    ));
                }
            }
        }
        if !saw_completed {
            return Err(AppError::Provider(
                "response stream ended before response.completed".into(),
            ));
        }
        if !inner
            .should_continue_turn(&run.thread_id, &run.turn_id, !pending_tools.is_empty())
            .await?
        {
            return Ok(RunCompletion::Completed);
        }

        for pending in pending_tools {
            if *run.cancellation.borrow() {
                return Ok(RunCompletion::Interrupted);
            }
            let started_item = pending.prepared.started_item(&run.workspace);
            inner.emit_notification(
                &app,
                crate::engine::EngineNotification::ItemStarted(ItemNotification {
                    thread_id: run.thread_id.clone(),
                    turn_id: run.turn_id.clone(),
                    item: started_item,
                }),
            )?;
            let result = pending
                .prepared
                .execute(
                    ToolExecutionContext {
                        app: &app,
                        workspace: &run.workspace,
                        permissions: run.config.permission_profile,
                        thread_id: &run.thread_id,
                        turn_id: &run.turn_id,
                        approvals: &inner.approvals,
                    },
                    &mut run.cancellation,
                )
                .await;
            let (provider_output, completed_item) = match result {
                Ok(result) => (result.provider_output, result.completed_item),
                Err(AppError::Cancelled(message)) => {
                    let error = AppError::Cancelled(message);
                    let item = pending.prepared.failed_item(&run.workspace, &error);
                    persist_and_emit_item(&inner, &app, &run.thread_id, &run.turn_id, item, false)
                        .await?;
                    return Ok(RunCompletion::Interrupted);
                }
                Err(error) => {
                    let item = pending.prepared.failed_item(&run.workspace, &error);
                    (format!("Tool failed: {error}"), item)
                }
            };
            persist_and_emit_item(
                &inner,
                &app,
                &run.thread_id,
                &run.turn_id,
                completed_item,
                false,
            )
            .await?;
            let output = match pending.output_kind {
                ToolOutputKind::Function => {
                    ResponseItem::function_output(pending.call_id, provider_output)
                }
                ToolOutputKind::Custom => {
                    ResponseItem::custom_output(pending.call_id, provider_output)
                }
            };
            inner
                .storage
                .append_provider_item(run.thread_id.clone(), output)
                .await?;
        }
    }
}

pub(super) async fn run_compaction(
    inner: Arc<NativeEngineInner>,
    app: AppHandle,
    mut run: TurnRun,
) -> Result<RunCompletion, AppError> {
    let instructions = compose_instructions(&run.model, &run.workspace, &run.config)?;
    let mut provider_state = TurnProviderState::default();
    if *run.cancellation.borrow() {
        return Ok(RunCompletion::Interrupted);
    }
    let history = load_prompt_history(&inner, &app, &run.thread_id).await?;
    let tools = provider_tools(&inner, &run.config);
    if compact_context(
        &inner,
        &app,
        &mut run,
        &instructions,
        &mut provider_state,
        history,
        &tools,
    )
    .await?
    {
        Ok(RunCompletion::Completed)
    } else {
        Ok(RunCompletion::Interrupted)
    }
}

pub(super) fn provider_tools(
    inner: &NativeEngineInner,
    config: &AppConfig,
) -> Vec<serde_json::Value> {
    let mut tools = inner.tools.definitions();
    if config.web_search == WebSearchMode::Live {
        tools.push(json!({
            "type": "web_search",
            "external_web_access": true
        }));
    }
    tools
}

pub(super) async fn load_prompt_history(
    inner: &NativeEngineInner,
    app: &AppHandle,
    thread_id: &str,
) -> Result<Vec<ResponseItem>, AppError> {
    let history = inner.storage.provider_history(thread_id.into()).await?;
    let normalized = normalize_provider_history(history)?;
    if !normalized.changed() {
        return Ok(normalized.items);
    }

    inner
        .storage
        .replace_provider_history(thread_id.into(), normalized.items.clone())
        .await?;
    inner.emit_diagnostic(
        app,
        DiagnosticStream::Runtime,
        format!(
            "Provider history normalized before the request: {} aborted output(s) inserted and {} orphan output(s) removed.",
            normalized.inserted_aborted_outputs, normalized.removed_orphan_outputs
        ),
    );
    Ok(normalized.items)
}

async fn prepare_sampling_input(
    inner: &NativeEngineInner,
    app: &AppHandle,
    run: &mut TurnRun,
    instructions: &str,
    provider_state: &mut TurnProviderState,
) -> Result<Option<SamplingInput>, AppError> {
    let history = load_prompt_history(inner, app, &run.thread_id).await?;
    let tools = provider_tools(inner, &run.config);
    let snapshot = inner
        .storage
        .latest_context_usage(run.thread_id.clone())
        .await?;
    let context_window = run.model.context_window();
    let status = evaluate_context_window(
        run.model.id(),
        instructions,
        &history,
        &tools,
        snapshot.as_ref(),
        run.model.auto_compact_token_limit(),
        context_window.as_ref(),
    );
    if !status.should_compact {
        return Ok(Some(SamplingInput { history, tools }));
    }

    inner.emit_diagnostic(
        app,
        DiagnosticStream::Runtime,
        format!(
            "Automatically compacting {active_tokens} active context tokens before sampling.",
            active_tokens = status.active_tokens
        ),
    );
    if !compact_context(
        inner,
        app,
        run,
        instructions,
        provider_state,
        history,
        &tools,
    )
    .await?
    {
        return Ok(None);
    }

    Ok(Some(SamplingInput {
        history: load_prompt_history(inner, app, &run.thread_id).await?,
        tools,
    }))
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
        ResponseEvent::TurnModerationMetadata(metadata) => {
            inner.emit_notification(
                app,
                crate::engine::EngineNotification::TurnModerationMetadata(
                    TurnModerationMetadataNotification {
                        thread_id: run.thread_id.clone(),
                        turn_id: run.turn_id.clone(),
                        metadata,
                    },
                ),
            )?;
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
    match current.as_deref() {
        None => *current = Some(incoming),
        Some(value) if value == incoming => {}
        Some(_) => {
            return Err(AppError::Provider(
                "provider changed x-codex-turn-state within one turn".into(),
            ));
        }
    }
    Ok(())
}

struct PendingTool {
    call_id: String,
    output_kind: ToolOutputKind,
    prepared: PreparedTool,
}

#[derive(Debug, Clone, Copy)]
enum ToolOutputKind {
    Function,
    Custom,
}

async fn persist_and_emit_item(
    inner: &NativeEngineInner,
    app: &AppHandle,
    thread_id: &str,
    turn_id: &str,
    item: ThreadItem,
    started: bool,
) -> Result<(), AppError> {
    if !started {
        inner
            .storage
            .append_thread_item(turn_id.into(), item.clone())
            .await?;
    }
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
                text,
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
                summary,
                content,
            }))
        }
        ResponseItem::WebSearchCall { action, .. } => Ok(Some(ThreadItem::ToolExecution {
            id: required_visible_item_id(item)?,
            name: "web_search".into(),
            description: action
                .as_ref()
                .map(|action| format!("{action:?}"))
                .unwrap_or_else(|| "Web search".into()),
            status: ActivityStatus::Completed,
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

fn required_visible_item_id(item: &ResponseItem) -> Result<String, AppError> {
    item.id()
        .map(str::to_string)
        .ok_or_else(|| AppError::Provider("visible response item is missing its id".into()))
}

fn compose_instructions(
    model: &SelectedModel,
    workspace: &Path,
    config: &AppConfig,
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
    let instructions = format!(
        "{}\n\n# Native Codex Desktop runtime\n\
         You are operating through an independent desktop runtime in workspace {}. \
         Use only the tools advertised in this request. Tool paths are workspace-relative. \
         Never claim an operation succeeded until its tool result confirms it. \
         Surface blockers and failures plainly. {personality}{developer}",
        model.instructions(),
        workspace.display(),
    );
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
            if name.is_empty() || name.len() > 128 {
                return Err(AppError::Provider("tool name is invalid".into()));
            }
        }
        ResponseItem::CustomToolCall { name, call_id, .. } => {
            validate_provider_id(call_id)?;
            if name.is_empty() || name.len() > 128 {
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
    if value.is_empty()
        || value.len() > MAX_PROVIDER_ITEM_ID_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(AppError::Provider("provider item id is invalid".into()));
    }
    Ok(())
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

fn truncate_utf8(value: &str, maximum_bytes: usize) -> String {
    if value.len() <= maximum_bytes {
        return value.to_string();
    }
    let mut end = maximum_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::{add_input_bytes, record_turn_state};

    #[test]
    fn combined_input_is_bounded() {
        let mut total = super::MAX_RAW_INPUT_BYTES;
        assert!(add_input_bytes(&mut total, 1).is_err());
    }

    #[test]
    fn turn_routing_state_is_sticky_within_one_turn() {
        let mut state = None;
        record_turn_state(&mut state, "route-1".into()).expect("first route should be recorded");
        record_turn_state(&mut state, "route-1".into()).expect("same route should be idempotent");
        assert!(record_turn_state(&mut state, "route-2".into()).is_err());
        assert_eq!(state.as_deref(), Some("route-1"));
    }
}
