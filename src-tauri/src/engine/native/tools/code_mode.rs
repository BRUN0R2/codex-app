use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use serde_json::{Value, json};
use tauri::AppHandle;
use tokio::sync::{Mutex, RwLock, watch};
use uuid::Uuid;

use super::{
    PreparedTool, ReadToolCache, ToolExecutionContext, ToolExecutionResult, ToolOperation,
};
use crate::engine::native::NativeEngineInner;
use crate::engine::native::agent::{emit_item_notification, item_remains_in_progress};
use crate::engine::native::code_mode::{
    CellId, DelegateFuture, ExecuteRequest, NestedToolCall, RuntimeResponse, ToolDelegate, ToolKind,
};
use crate::engine::native::multi_agent::AgentInvocationContext;
use crate::engine::native::output::OutputSource;
use crate::engine::native::output_compaction::ProviderOutputBudget;
use crate::engine::native::provider::FunctionCallOutputContent;
use crate::engine::native::stream_notifications::StreamNotificationBatcher;
use crate::engine::{ActivityStatus, ImageDetail, PermissionProfile};
use crate::error::AppError;

const ESTIMATED_BYTES_PER_TOKEN: usize = 4;
const ESTIMATED_IMAGE_TOKENS: usize = 1_024;
const MAX_TRUNCATION_MARKER_BYTES: usize = 160;

#[derive(Default)]
struct NestedToolExecutionGate {
    lock: RwLock<()>,
}

#[derive(Default)]
struct NestedReadCache {
    current: Mutex<Arc<ReadToolCache>>,
}

impl NestedToolExecutionGate {
    async fn run<T>(
        &self,
        supports_parallel_execution: bool,
        operation: impl std::future::Future<Output = T>,
    ) -> T {
        if supports_parallel_execution {
            let _guard = self.lock.read().await;
            operation.await
        } else {
            let _guard = self.lock.write().await;
            operation.await
        }
    }
}

impl NestedReadCache {
    async fn snapshot(&self) -> Arc<ReadToolCache> {
        self.current.lock().await.clone()
    }

    async fn invalidate(&self) {
        *self.current.lock().await = Arc::new(ReadToolCache::default());
    }
}

pub(crate) struct CodeModeToolDelegate {
    inner: Arc<NativeEngineInner>,
    app: AppHandle,
    workspace: PathBuf,
    permissions: PermissionProfile,
    thread_id: String,
    turn_id: String,
    supports_image_input: bool,
    supports_original_image_detail: bool,
    provider_output_budget: ProviderOutputBudget,
    agent: AgentInvocationContext,
    read_cache: Arc<NestedReadCache>,
    execution_gate: Arc<NestedToolExecutionGate>,
}

pub(crate) struct CodeModeToolDelegateContext {
    pub workspace: PathBuf,
    pub permissions: PermissionProfile,
    pub thread_id: String,
    pub turn_id: String,
    pub supports_image_input: bool,
    pub supports_original_image_detail: bool,
    pub provider_output_budget: ProviderOutputBudget,
    pub agent: AgentInvocationContext,
}

impl CodeModeToolDelegate {
    pub fn new(
        inner: Arc<NativeEngineInner>,
        app: AppHandle,
        context: CodeModeToolDelegateContext,
    ) -> Self {
        Self {
            inner,
            app,
            workspace: context.workspace,
            permissions: context.permissions,
            thread_id: context.thread_id,
            turn_id: context.turn_id,
            supports_image_input: context.supports_image_input,
            supports_original_image_detail: context.supports_original_image_detail,
            provider_output_budget: context.provider_output_budget,
            agent: context.agent,
            read_cache: Arc::new(NestedReadCache::default()),
            execution_gate: Arc::new(NestedToolExecutionGate::default()),
        }
    }

    async fn invoke_nested(
        &self,
        call: NestedToolCall,
        mut cancellation: watch::Receiver<bool>,
    ) -> Result<Value, String> {
        if *cancellation.borrow() {
            return Err("nested tool call was cancelled before dispatch".into());
        }
        let item_id = Uuid::new_v5(
            &Uuid::NAMESPACE_OID,
            format!(
                "{}\0{}\0{}\0{}",
                self.thread_id,
                self.turn_id,
                call.cell_id.as_str(),
                call.runtime_call_id
            )
            .as_bytes(),
        )
        .to_string();
        let prepared = match call.kind {
            ToolKind::Function => {
                let arguments = function_arguments(&call.name, call.input)?;
                self.inner.tools.prepare(item_id, &call.name, &arguments)
            }
            ToolKind::Freeform => {
                let input = freeform_input(&call.name, call.input)?;
                self.inner.tools.prepare_custom(item_id, &call.name, &input)
            }
        }
        .map_err(|error| error.to_string())?;

        emit_item_notification(
            &self.inner,
            &self.app,
            &self.thread_id,
            &self.turn_id,
            prepared.started_item(&self.workspace),
            true,
        )
        .map_err(|error| error.to_string())?;

        let stream_deltas = StreamNotificationBatcher::new(
            Arc::clone(&self.inner),
            self.app.clone(),
            self.thread_id.clone(),
            self.turn_id.clone(),
        );
        let supports_parallel_execution = prepared.supports_parallel_execution(self.permissions);
        let invalidates_read_cache = prepared.invalidates_read_cache(self.permissions);
        let execution = self
            .execution_gate
            .run(
                supports_parallel_execution && !invalidates_read_cache,
                async {
                    let read_cache = self.read_cache.snapshot().await;
                    let context = ToolExecutionContext {
                        engine: Arc::downgrade(&self.inner),
                        app: &self.app,
                        workspace: &self.workspace,
                        permissions: self.permissions,
                        thread_id: &self.thread_id,
                        turn_id: &self.turn_id,
                        provider_call_id: &call.runtime_call_id,
                        agent: &self.agent,
                        approvals: &self.inner.approvals,
                        storage: &self.inner.storage,
                        ripgrep: &self.inner.ripgrep,
                        command_sessions: &self.inner.command_sessions,
                        stream_deltas: &stream_deltas,
                        read_cache: read_cache.as_ref(),
                        supports_image_input: self.supports_image_input,
                        supports_original_image_detail: self.supports_original_image_detail,
                        provider_output_budget: self.provider_output_budget,
                        code_mode: None,
                        code_mode_delegate: None,
                        code_mode_tools: &[],
                    };
                    let result = prepared.execute(context, &mut cancellation).await;
                    if invalidates_read_cache {
                        self.read_cache.invalidate().await;
                    }
                    result
                },
            )
            .await;
        let NestedExecutionSettlement {
            mut result,
            cancellation_error,
        } = settle_nested_execution(&prepared, &self.workspace, execution);
        stream_deltas
            .flush()
            .await
            .map_err(|error| error.to_string())?;

        let nested_result = nested_result(&result);
        let background_command = result.background_command.take();
        let completed_item = self
            .inner
            .storage
            .append_thread_item(
                self.turn_id.clone(),
                result.completed_item,
                result.display_output,
            )
            .await;
        let completed_item = match completed_item {
            Ok(item) => item,
            Err(error) => {
                if let Some(command) = background_command {
                    command.discard();
                }
                return Err(error.to_string());
            }
        };
        let remains_in_progress = item_remains_in_progress(&completed_item);
        let notification = emit_item_notification(
            &self.inner,
            &self.app,
            &self.thread_id,
            &self.turn_id,
            completed_item,
            remains_in_progress,
        );
        if let Some(command) = background_command {
            command.commit();
        }
        notification.map_err(|error| error.to_string())?;
        match cancellation_error {
            Some(message) => Err(message),
            None => Ok(nested_result),
        }
    }
}

struct NestedExecutionSettlement {
    result: ToolExecutionResult,
    cancellation_error: Option<String>,
}

fn settle_nested_execution(
    prepared: &PreparedTool,
    workspace: &std::path::Path,
    execution: Result<ToolExecutionResult, AppError>,
) -> NestedExecutionSettlement {
    match execution {
        Ok(result) => NestedExecutionSettlement {
            result,
            cancellation_error: None,
        },
        Err(AppError::Cancelled(message)) => NestedExecutionSettlement {
            result: prepared.failed_result(workspace, &AppError::Cancelled(message.clone())),
            cancellation_error: Some(message),
        },
        Err(error) => NestedExecutionSettlement {
            result: prepared.failed_result(workspace, &error),
            cancellation_error: None,
        },
    }
}

impl ToolDelegate for CodeModeToolDelegate {
    fn invoke(
        &self,
        call: NestedToolCall,
        cancellation: watch::Receiver<bool>,
    ) -> DelegateFuture<Value> {
        let this = Self {
            inner: Arc::clone(&self.inner),
            app: self.app.clone(),
            workspace: self.workspace.clone(),
            permissions: self.permissions,
            thread_id: self.thread_id.clone(),
            turn_id: self.turn_id.clone(),
            supports_image_input: self.supports_image_input,
            supports_original_image_detail: self.supports_original_image_detail,
            provider_output_budget: self.provider_output_budget,
            agent: self.agent.clone(),
            read_cache: Arc::clone(&self.read_cache),
            execution_gate: Arc::clone(&self.execution_gate),
        };
        Box::pin(async move { this.invoke_nested(call, cancellation).await })
    }

    fn notify(
        &self,
        _call_id: String,
        _cell_id: CellId,
        _text: String,
        _cancellation: watch::Receiver<bool>,
    ) -> DelegateFuture<()> {
        Box::pin(async { Ok(()) })
    }
}

pub(super) async fn execute(
    prepared: &PreparedTool,
    context: &ToolExecutionContext<'_>,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<ToolExecutionResult, AppError> {
    let session = context
        .code_mode
        .ok_or_else(|| AppError::State("Code Mode session is unavailable for this turn".into()))?;
    let delegate = context
        .code_mode_delegate
        .ok_or_else(|| AppError::State("Code Mode delegate is unavailable for this turn".into()))?;
    let started_at = Instant::now();
    let (response, max_tokens) = match &prepared.operation {
        ToolOperation::CodeExec(parsed) => (
            session
                .execute(
                    context.turn_id.to_string(),
                    ExecuteRequest {
                        call_id: context.provider_call_id.to_string(),
                        enabled_tools: context.code_mode_tools.to_vec(),
                        source: parsed.source.clone(),
                        yield_time_ms: parsed.yield_time_ms,
                        max_output_tokens: parsed.max_output_tokens,
                    },
                    Arc::clone(delegate),
                    cancellation.clone(),
                )
                .await
                .map_err(|error| AppError::Tool(error.to_string()))?,
            parsed.max_output_tokens,
        ),
        ToolOperation::CodeWait(args) => {
            let cell_id = CellId::new(args.cell_id.clone())
                .map_err(|error| AppError::Tool(error.to_string()))?;
            let response = if args.terminate {
                session.terminate(cell_id).await
            } else {
                session.wait(cell_id, args.yield_time_ms).await
            }
            .map_err(|error| AppError::Tool(error.to_string()))?;
            (
                response,
                args.max_tokens
                    .unwrap_or(super::super::code_mode::DEFAULT_MAX_OUTPUT_TOKENS),
            )
        }
        _ => {
            return Err(AppError::State(
                "non-Code-Mode operation entered Code Mode execution".into(),
            ));
        }
    };
    let (status, content) = adapt_response(response, max_tokens, started_at.elapsed());
    let provider_output = content_text(&content);
    Ok(ToolExecutionResult {
        provider_output: provider_output.clone(),
        provider_content: Some(content),
        completed_item: prepared.finish_item(context.workspace, status, None, elapsed(started_at)?),
        display_output: Some(OutputSource::text(provider_output)),
        background_command: None,
        visual_context: None,
    })
}

fn function_arguments(name: &str, input: Option<Value>) -> Result<String, String> {
    match input {
        None => Ok("{}".into()),
        Some(Value::Object(arguments)) => serde_json::to_string(&arguments)
            .map_err(|error| format!("failed to serialize `{name}` arguments: {error}")),
        Some(_) => Err(format!(
            "nested function tool `{name}` expects an object argument"
        )),
    }
}

fn freeform_input(name: &str, input: Option<Value>) -> Result<String, String> {
    match input {
        Some(Value::String(input)) => Ok(input),
        _ => Err(format!(
            "nested freeform tool `{name}` expects a string argument"
        )),
    }
}

fn nested_result(result: &ToolExecutionResult) -> Value {
    let Some(visual) = result.visual_context.as_ref() else {
        return Value::String(result.provider_output.clone());
    };
    json!({
        "output": result.provider_output,
        "image_url": visual.image_url,
        "detail": image_detail_name(visual.detail),
    })
}

fn image_detail_name(detail: ImageDetail) -> &'static str {
    match detail {
        ImageDetail::Auto => "auto",
        ImageDetail::Low => "low",
        ImageDetail::High => "high",
        ImageDetail::Original => "original",
    }
}

fn adapt_response(
    response: RuntimeResponse,
    max_tokens: usize,
    wall_time: std::time::Duration,
) -> (ActivityStatus, Vec<FunctionCallOutputContent>) {
    let response_cell_id = response.cell_id().to_string();
    let (status_text, status, mut content, error) = match response {
        RuntimeResponse::Yielded { cell_id, content } => (
            format!("Script running with cell ID {cell_id}"),
            ActivityStatus::InProgress,
            content,
            None,
        ),
        RuntimeResponse::Terminated { content, .. } => (
            format!("Script {response_cell_id} terminated"),
            ActivityStatus::Completed,
            content,
            None,
        ),
        RuntimeResponse::Completed { content, error, .. } => (
            if error.is_some() {
                format!("Script {response_cell_id} failed")
            } else {
                format!("Script {response_cell_id} completed")
            },
            if error.is_some() {
                ActivityStatus::Failed
            } else {
                ActivityStatus::Completed
            },
            content,
            error,
        ),
    };
    if let Some(error) = error {
        content.push(FunctionCallOutputContent::InputText {
            text: format!("Script error:\n{error}"),
        });
    }
    let mut content = truncate_content(content, max_tokens);
    let seconds = ((wall_time.as_secs_f32() * 10.0).round()) / 10.0;
    content.insert(
        0,
        FunctionCallOutputContent::InputText {
            text: format!("{status_text}\nWall time {seconds:.1} seconds\nOutput:\n"),
        },
    );
    (status, content)
}

fn truncate_content(
    content: Vec<FunctionCallOutputContent>,
    max_tokens: usize,
) -> Vec<FunctionCallOutputContent> {
    let mut remaining = max_tokens.saturating_mul(ESTIMATED_BYTES_PER_TOKEN);
    let mut output = Vec::with_capacity(content.len());
    for item in content {
        match item {
            FunctionCallOutputContent::InputText { text } => {
                if text.len() <= remaining {
                    remaining -= text.len();
                    output.push(FunctionCallOutputContent::InputText { text });
                } else {
                    output.push(FunctionCallOutputContent::InputText {
                        text: truncate_text(&text, remaining),
                    });
                    break;
                }
            }
            image @ FunctionCallOutputContent::InputImage { .. } => {
                let cost = ESTIMATED_IMAGE_TOKENS.saturating_mul(ESTIMATED_BYTES_PER_TOKEN);
                if cost <= remaining {
                    remaining -= cost;
                    output.push(image);
                } else {
                    output.push(FunctionCallOutputContent::InputText {
                        text: "[omitted image output: token budget exhausted]".into(),
                    });
                }
            }
            FunctionCallOutputContent::InputAudio { audio_url } => {
                let cost = audio_url.len().max(ESTIMATED_BYTES_PER_TOKEN);
                if cost <= remaining {
                    remaining -= cost;
                    output.push(FunctionCallOutputContent::InputAudio { audio_url });
                } else {
                    output.push(FunctionCallOutputContent::InputText {
                        text: "[omitted audio output: token budget exhausted]".into(),
                    });
                }
            }
        }
    }
    output
}

fn truncate_text(text: &str, maximum_bytes: usize) -> String {
    let original_tokens = text.len().div_ceil(ESTIMATED_BYTES_PER_TOKEN);
    let marker =
        format!("\n[truncated Code Mode output; approximately {original_tokens} tokens total]\n");
    if maximum_bytes <= marker.len().min(MAX_TRUNCATION_MARKER_BYTES) {
        return marker.chars().take(maximum_bytes).collect();
    }
    let available = maximum_bytes - marker.len();
    let head_bytes = available / 2;
    let tail_bytes = available - head_bytes;
    let head_end = floor_char_boundary(text, head_bytes);
    let tail_start = ceil_char_boundary(text, text.len().saturating_sub(tail_bytes));
    format!("{}{}{}", &text[..head_end], marker, &text[tail_start..])
}

fn floor_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn content_text(content: &[FunctionCallOutputContent]) -> String {
    content
        .iter()
        .map(|item| match item {
            FunctionCallOutputContent::InputText { text } => text.as_str(),
            FunctionCallOutputContent::InputImage { .. } => "[image output]",
            FunctionCallOutputContent::InputAudio { .. } => "[audio output]",
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn elapsed(started_at: Instant) -> Result<Option<u64>, AppError> {
    u64::try_from(started_at.elapsed().as_millis())
        .map(Some)
        .map_err(|_| AppError::State("Code Mode duration overflowed".into()))
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::time::Duration;

    use tokio::sync::{Barrier, Notify};

    use super::*;
    use crate::engine::ThreadItem;
    use crate::engine::native::tools::ToolRegistry;

    #[test]
    fn nested_function_tools_reject_non_object_arguments() {
        let error = function_arguments("read_file", Some(json!("bad")))
            .expect_err("non-object input must fail");
        assert!(error.contains("expects an object"));
    }

    #[test]
    fn cancelled_nested_tools_produce_a_terminal_failed_item_before_propagation() {
        let prepared = ToolRegistry
            .prepare(
                "read-cancelled".into(),
                "read_file",
                r#"{"path":"src/main.rs","start_line":1,"end_line":1}"#,
            )
            .expect("read_file should prepare");
        let settlement = settle_nested_execution(
            &prepared,
            Path::new("C:\\workspace"),
            Err(AppError::Cancelled("turn interrupted".into())),
        );

        assert_eq!(
            settlement.cancellation_error.as_deref(),
            Some("turn interrupted")
        );
        assert!(matches!(
            settlement.result.completed_item,
            ThreadItem::ToolExecution {
                status: ActivityStatus::Failed,
                ..
            }
        ));
    }

    #[test]
    fn truncation_preserves_utf8_boundaries_and_both_ends() {
        let text = format!("começo-{}-fim", "á".repeat(100));
        let truncated = truncate_text(&text, 80);
        assert!(truncated.starts_with("começo"));
        assert!(truncated.ends_with("fim"));
        assert!(truncated.contains("truncated Code Mode output"));
    }

    #[tokio::test]
    async fn parallel_safe_nested_tools_can_overlap() {
        let gate = Arc::new(NestedToolExecutionGate::default());
        let barrier = Arc::new(Barrier::new(3));
        let mut tasks = Vec::new();
        for _ in 0..2 {
            let gate = Arc::clone(&gate);
            let barrier = Arc::clone(&barrier);
            tasks.push(tokio::spawn(async move {
                gate.run(true, barrier.wait()).await;
            }));
        }

        tokio::time::timeout(Duration::from_secs(1), barrier.wait())
            .await
            .expect("parallel-safe nested tools should reach the barrier together");
        for task in tasks {
            task.await.expect("parallel-safe task should not panic");
        }
    }

    #[tokio::test]
    async fn mutating_nested_tools_exclude_all_other_nested_execution() {
        let gate = Arc::new(NestedToolExecutionGate::default());
        let entered_mutation = Arc::new(Notify::new());
        let release_mutation = Arc::new(Notify::new());
        let entered_reader = Arc::new(Notify::new());

        let mutation = {
            let gate = Arc::clone(&gate);
            let entered_mutation = Arc::clone(&entered_mutation);
            let release_mutation = Arc::clone(&release_mutation);
            tokio::spawn(async move {
                gate.run(false, async move {
                    entered_mutation.notify_one();
                    release_mutation.notified().await;
                })
                .await;
            })
        };
        entered_mutation.notified().await;

        let reader = {
            let gate = Arc::clone(&gate);
            let entered_reader = Arc::clone(&entered_reader);
            tokio::spawn(async move {
                gate.run(true, async move {
                    entered_reader.notify_one();
                })
                .await;
            })
        };
        assert!(
            tokio::time::timeout(Duration::from_millis(25), entered_reader.notified())
                .await
                .is_err(),
            "parallel-safe work must not enter while a mutation owns the gate"
        );

        release_mutation.notify_one();
        tokio::time::timeout(Duration::from_secs(1), entered_reader.notified())
            .await
            .expect("reader should enter after the mutation releases the gate");
        mutation.await.expect("mutation task should not panic");
        reader.await.expect("reader task should not panic");
    }

    #[tokio::test]
    async fn nested_read_cache_invalidation_advances_the_cache_epoch() {
        let cache = NestedReadCache::default();
        let first = cache.snapshot().await;
        assert!(Arc::ptr_eq(&first, &cache.snapshot().await));

        cache.invalidate().await;
        let second = cache.snapshot().await;
        assert!(!Arc::ptr_eq(&first, &second));
        assert!(Arc::ptr_eq(&second, &cache.snapshot().await));
    }
}
