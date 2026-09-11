use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::AppHandle;
use tokio::sync::watch;

use super::scheduler::ToolScheduler;
use super::{
    PendingTool, ToolOutputKind, TurnRun, emit_item_notification, item_remains_in_progress,
    tool_failure_diagnostic, validate_local_response_item,
};
use crate::engine::native::NativeEngineInner;
use crate::engine::native::code_mode::{CodeModeSession, ToolDefinition, ToolDelegate};
use crate::engine::native::multi_agent::AgentInvocationContext;
use crate::engine::native::output_compaction::ProviderOutputBudget;
use crate::engine::native::provider::{FunctionCallOutputPayload, ResponseItem};
use crate::engine::native::stream_notifications::StreamNotificationBatcher;
use crate::engine::native::tools::{
    ReadToolCache, ReadToolCacheKey, ToolExecutionContext, ToolExecutionResult,
};
use crate::engine::{DiagnosticStream, PermissionProfile};
use crate::error::AppError;

pub(super) struct TurnToolContext {
    inner: Arc<NativeEngineInner>,
    app: AppHandle,
    workspace: PathBuf,
    permissions: PermissionProfile,
    turn_id: String,
    agent: AgentInvocationContext,
    stream_deltas: StreamNotificationBatcher,
    supports_image_input: bool,
    supports_original_image_detail: bool,
    provider_output_budget: ProviderOutputBudget,
    code_mode: Option<CodeModeSession>,
    code_mode_delegate: Option<Arc<dyn ToolDelegate>>,
    code_mode_tools: Vec<ToolDefinition>,
    cancellation: watch::Receiver<bool>,
}

pub(super) struct CompletedTool {
    pending: PendingTool,
    result: Result<ToolExecutionResult, AppError>,
}

#[derive(Default)]
pub(super) struct ToolReadSegment {
    cache: Arc<ReadToolCache>,
    leaders: HashMap<ReadToolCacheKey, String>,
}

impl ToolReadSegment {
    pub(super) fn admit(
        &mut self,
        pending: &PendingTool,
        workspace: &Path,
        thread_id: &str,
    ) -> (Arc<ReadToolCache>, Option<String>) {
        let duplicate = match pending.read_dedup_key(workspace, thread_id) {
            Some(key) => {
                let leader = self
                    .leaders
                    .entry(key)
                    .or_insert_with(|| pending.call_id.clone());
                (leader != &pending.call_id).then(|| leader.clone())
            }
            None => {
                *self = Self::default();
                None
            }
        };
        (Arc::clone(&self.cache), duplicate)
    }
}

impl TurnToolContext {
    pub fn new(
        inner: Arc<NativeEngineInner>,
        app: AppHandle,
        run: &TurnRun,
        stream_deltas: StreamNotificationBatcher,
        code_mode: Option<CodeModeSession>,
        code_mode_delegate: Option<Arc<dyn ToolDelegate>>,
        code_mode_tools: Vec<ToolDefinition>,
    ) -> Self {
        Self {
            inner,
            app,
            workspace: run.workspace.clone(),
            permissions: run.config.permission_profile,
            turn_id: run.turn_id.clone(),
            agent: AgentInvocationContext {
                thread_id: run.thread_id.clone(),
                model: run.model.id().into(),
                reasoning_effort: run.selected_reasoning_effort,
                service_tier: run.service_tier.clone(),
                timezone: run.timezone.clone(),
                timezone_offset_min: run.timezone_offset_min,
            },
            stream_deltas,
            supports_image_input: run.model.supports_image_input(),
            supports_original_image_detail: run.model.supports_image_detail_original(),
            provider_output_budget: run.model.provider_output_budget(),
            code_mode,
            code_mode_delegate,
            code_mode_tools,
            cancellation: run.cancellation.clone(),
        }
    }

    pub fn enqueue(
        self: &Arc<Self>,
        scheduler: &mut ToolScheduler<CompletedTool>,
        reads: &mut ToolReadSegment,
        pending: PendingTool,
    ) -> Result<(), AppError> {
        let parallel = pending.supports_parallel_execution(self.permissions);
        let (cache, duplicate_of) = reads.admit(&pending, &self.workspace, &self.agent.thread_id);
        let context = Arc::clone(self);
        scheduler.enqueue(parallel, async move {
            let result = context
                .execute(&pending, &cache, duplicate_of.as_deref())
                .await;
            CompletedTool { pending, result }
        })
    }

    async fn execute(
        &self,
        pending: &PendingTool,
        cache: &ReadToolCache,
        duplicate_of: Option<&str>,
    ) -> Result<ToolExecutionResult, AppError> {
        if *self.cancellation.borrow() {
            return Err(AppError::Cancelled("tool execution was cancelled".into()));
        }
        if let Some(item) = pending.started_item(&self.workspace) {
            emit_item_notification(
                &self.inner,
                &self.app,
                &self.agent.thread_id,
                &self.turn_id,
                item,
                true,
            )?;
        }
        if let Some(original_call_id) = duplicate_of {
            return Ok(pending.duplicate_read_result(&self.workspace, original_call_id));
        }
        let context = ToolExecutionContext {
            engine: Arc::downgrade(&self.inner),
            app: &self.app,
            workspace: &self.workspace,
            permissions: self.permissions,
            thread_id: &self.agent.thread_id,
            turn_id: &self.turn_id,
            provider_call_id: &pending.call_id,
            agent: &self.agent,
            approvals: &self.inner.approvals,
            storage: &self.inner.storage,
            ripgrep: &self.inner.ripgrep,
            command_sessions: &self.inner.command_sessions,
            stream_deltas: &self.stream_deltas,
            read_cache: cache,
            supports_image_input: self.supports_image_input,
            supports_original_image_detail: self.supports_original_image_detail,
            provider_output_budget: self.provider_output_budget,
            code_mode: self.code_mode.as_ref(),
            code_mode_delegate: self.code_mode_delegate.as_ref(),
            code_mode_tools: &self.code_mode_tools,
        };
        pending
            .execute(context, &mut self.cancellation.clone())
            .await
    }

    /// Commit every dispatched call, including failures, before retrying the
    /// model. Provider outputs follow all model output items in call order.
    pub async fn persist(&self, completed: CompletedTool) -> Result<(), AppError> {
        let CompletedTool { pending, result } = completed;
        let name = pending.name();
        let mut result = match result {
            Ok(result) => result,
            Err(error) => {
                self.inner.emit_diagnostic(
                    &self.app,
                    DiagnosticStream::Runtime,
                    format!("tool `{name}` failed: {error}"),
                );
                pending.failed_result(&self.workspace, &error)
            }
        };
        let background_command = result.background_command.take();
        let visual_context = result.visual_context.take();
        let provider_content = result.provider_content.take();
        let output = match (pending.output_kind, visual_context, provider_content) {
            (ToolOutputKind::Function, Some(visual), None) => {
                ResponseItem::function_output_with_image(
                    pending.call_id.clone(),
                    visual.model_text,
                    visual.image_url,
                    Some(visual.detail),
                )
            }
            (ToolOutputKind::Function, None, None) => {
                ResponseItem::function_output(pending.call_id.clone(), result.provider_output)
            }
            (ToolOutputKind::Custom, None, None) => {
                ResponseItem::custom_output(pending.call_id.clone(), result.provider_output)
            }
            (ToolOutputKind::Function, None, Some(content)) => {
                ResponseItem::function_output_payload(
                    pending.call_id.clone(),
                    FunctionCallOutputPayload::Content(content),
                )
            }
            (ToolOutputKind::Custom, None, Some(content)) => ResponseItem::custom_output_payload(
                pending.call_id.clone(),
                FunctionCallOutputPayload::Content(content),
            ),
            (_, Some(_), Some(_)) | (ToolOutputKind::Custom, Some(_), None) => {
                return Err(AppError::State(
                    "tool produced conflicting provider output channels".into(),
                ));
            }
        };
        validate_local_response_item(&output)?;
        let item = match self
            .inner
            .storage
            .append_provider_and_thread_item(
                self.agent.thread_id.clone(),
                self.turn_id.clone(),
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
        if let Some(message) = tool_failure_diagnostic(name, &item) {
            self.inner
                .emit_diagnostic(&self.app, DiagnosticStream::Runtime, message);
        }
        let started = item_remains_in_progress(&item);
        let notification = emit_item_notification(
            &self.inner,
            &self.app,
            &self.agent.thread_id,
            &self.turn_id,
            item,
            started,
        );
        if let Some(command) = background_command {
            command.commit();
        }
        notification
    }
}
