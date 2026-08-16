mod client;
mod integrity;
mod models;
mod stream;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tokio::sync::{Mutex, RwLock, watch};

use self::client::{ChatClient, ChatConversationRequest};
use self::models::{ChatModelCatalog, SelectedChatModel};
use self::stream::{ChatStreamEvent, MAX_MESSAGE_TEXT_BYTES};
use super::NativeEngineInner;
use super::agent::{
    PreparedTurn, RunCompletion, automatic_provider_retry_wait, automatic_rate_limit_wait,
    describe_duration,
};
use super::auth::ChatGptAuth;
use super::content_references::strip_content_reference_markers;
use super::diagnostics::RuntimeDiagnostics;
use super::provider::{ResponseContent, ResponseItem};
use super::stream_notifications::StreamNotificationBatcher;
use crate::engine::{
    ChatModelListResponse, DiagnosticStream, EngineNotification, ItemNotification, MessagePhase,
    StreamDelta, ThreadItem,
};
use crate::error::AppError;

const MAX_MODELS: usize = 100;

#[derive(Default)]
pub(super) struct ChatGptConsumerProvider {
    client: ChatClient,
    catalog: RwLock<Option<Arc<ChatModelCatalog>>>,
    refresh_gate: Mutex<()>,
}

impl ChatGptConsumerProvider {
    pub async fn initialize(&self, app: &AppHandle) -> Result<(), AppError> {
        self.client.initialize(app).await
    }

    pub async fn list_models(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
    ) -> Result<ChatModelListResponse, AppError> {
        let catalog = self.catalog(app, auth).await?;
        Ok(ChatModelListResponse {
            data: catalog
                .models()
                .iter()
                .map(SelectedChatModel::summary)
                .collect(),
        })
    }

    pub async fn select_model(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
        requested: Option<&str>,
    ) -> Result<SelectedChatModel, AppError> {
        let catalog = self.catalog(app, auth).await?;
        catalog.select(requested)
    }

    async fn start_conversation(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
        diagnostics: &RuntimeDiagnostics,
        request: ChatConversationRequest,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<stream::ChatStream, AppError> {
        let session = auth.session(app).await?;
        self.client
            .start_conversation(app, diagnostics, &session, request, cancellation)
            .await
    }

    pub async fn clear_session_state(&self) {
        let _refresh_guard = self.refresh_gate.lock().await;
        *self.catalog.write().await = None;
    }

    async fn catalog(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
    ) -> Result<Arc<ChatModelCatalog>, AppError> {
        if let Some(catalog) = self.catalog.read().await.clone() {
            return Ok(catalog);
        }
        let _refresh_guard = self.refresh_gate.lock().await;
        if let Some(catalog) = self.catalog.read().await.clone() {
            return Ok(catalog);
        }
        let session = auth.session(app).await?;
        let wire = self.client.fetch_models(&session).await?;
        let catalog = Arc::new(ChatModelCatalog::from_wire(wire, MAX_MODELS)?);
        *self.catalog.write().await = Some(Arc::clone(&catalog));
        Ok(catalog)
    }
}

pub(super) struct ChatTurnRun {
    pub thread_id: String,
    pub turn_id: String,
    pub user_message_id: String,
    pub prompt: String,
    pub model: SelectedChatModel,
    pub timezone: String,
    pub timezone_offset_min: i32,
    pub cancellation: watch::Receiver<bool>,
}

pub(super) fn prompt_from_prepared_turn(prepared: &PreparedTurn) -> Result<String, AppError> {
    let ResponseItem::Message { role, content, .. } = &prepared.provider_item else {
        return Err(AppError::State(
            "prepared ChatGPT input is not a user message".into(),
        ));
    };
    if role != "user" {
        return Err(AppError::State(
            "prepared ChatGPT input has an unexpected role".into(),
        ));
    }
    let mut prompt = String::new();
    for part in content {
        match part {
            ResponseContent::InputText { text } => {
                if !prompt.is_empty() {
                    prompt.push_str("\n\n");
                }
                prompt.push_str(text);
            }
            ResponseContent::InputImage { .. } => {
                return Err(AppError::InvalidAttachment(
                    "Chat mode requires ChatGPT file upload before an image can be referenced; image uploads are not available in this client yet"
                        .into(),
                ));
            }
            ResponseContent::OutputText { .. } | ResponseContent::Refusal { .. } => {
                return Err(AppError::State(
                    "prepared ChatGPT input contains response-only content".into(),
                ));
            }
        }
    }
    if prompt.trim().is_empty() {
        return Err(AppError::Protocol(
            "Chat mode requires a non-empty text prompt".into(),
        ));
    }
    Ok(prompt)
}

pub(super) async fn run_turn(
    inner: Arc<NativeEngineInner>,
    app: AppHandle,
    mut run: ChatTurnRun,
) -> Result<RunCompletion, AppError> {
    let conversation = inner
        .storage
        .chat_conversation_state(run.thread_id.clone())
        .await?;
    let mut conversation_id = conversation.conversation_id.clone();
    let request = ChatConversationRequest::new(
        conversation.conversation_id,
        conversation.parent_message_id,
        run.user_message_id,
        run.prompt,
        run.model.model().to_string(),
        run.model.thinking_effort(),
        run.timezone,
        run.timezone_offset_min,
    );
    let mut messages = BTreeMap::<String, String>::new();
    let mut message_order = Vec::<String>::new();
    let stream_deltas = StreamNotificationBatcher::new(
        Arc::clone(&inner),
        app.clone(),
        run.thread_id.clone(),
        run.turn_id.clone(),
    );

    let result = async {
        let mut transient_failure_count = 0u32;
        'conversation: loop {
            let mut stream = match inner
                .chat
                .start_conversation(
                    &app,
                    &inner.auth,
                    &inner.diagnostics,
                    request.clone(),
                    &mut run.cancellation,
                )
                .await
            {
                Ok(stream) => stream,
                Err(AppError::Cancelled(_)) => return Ok(RunCompletion::Interrupted),
                Err(error) => {
                    match wait_for_recoverable_chat_error(
                        &inner,
                        &app,
                        &mut run.cancellation,
                        &error,
                        &mut transient_failure_count,
                    )
                    .await
                    {
                        Some(true) => continue 'conversation,
                        Some(false) => return Ok(RunCompletion::Interrupted),
                        None => return Err(error),
                    }
                }
            };
            let mut saw_completed = false;

            loop {
                let event = match stream.next_event(&mut run.cancellation).await {
                    Ok(Some(event)) => event,
                    Ok(None) => break,
                    Err(error) => {
                        stream_deltas.flush().await?;
                        match wait_for_recoverable_chat_error(
                            &inner,
                            &app,
                            &mut run.cancellation,
                            &error,
                            &mut transient_failure_count,
                        )
                        .await
                        {
                            Some(true) => continue 'conversation,
                            Some(false) => return Ok(RunCompletion::Interrupted),
                            None => return Err(error),
                        }
                    }
                };
                transient_failure_count = 0;
                match event {
                    ChatStreamEvent::ConversationId(id) => conversation_id = Some(id),
                    ChatStreamEvent::Message(snapshot) => {
                        if let Some(id) = snapshot.conversation_id {
                            conversation_id = Some(id);
                        }
                        if !messages.contains_key(&snapshot.id) {
                            message_order.push(snapshot.id.clone());
                        }
                        let previous = messages.get(&snapshot.id).map_or("", String::as_str);
                        if snapshot.text.starts_with(previous) {
                            let delta = &snapshot.text[previous.len()..];
                            emit_text_delta(&stream_deltas, &snapshot.id, delta).await?;
                        }
                        messages.insert(snapshot.id, snapshot.text);
                    }
                    ChatStreamEvent::MessageDelta(update) => {
                        if let Some(id) = update.conversation_id {
                            conversation_id = Some(id);
                        }
                        if !messages.contains_key(&update.id) {
                            message_order.push(update.id.clone());
                        }
                        let text = messages.entry(update.id.clone()).or_default();
                        let next_length =
                            text.len().checked_add(update.delta.len()).ok_or_else(|| {
                                AppError::Provider("ChatGPT message size overflowed".into())
                            })?;
                        if next_length > MAX_MESSAGE_TEXT_BYTES {
                            return Err(AppError::Provider(format!(
                                "ChatGPT assistant message exceeds {MAX_MESSAGE_TEXT_BYTES} bytes"
                            )));
                        }
                        emit_text_delta(&stream_deltas, &update.id, &update.delta).await?;
                        text.push_str(&update.delta);
                    }
                    ChatStreamEvent::Completed => {
                        stream_deltas.flush().await?;
                        saw_completed = true;
                        break;
                    }
                    ChatStreamEvent::Interrupted => {
                        stream_deltas.flush().await?;
                        return Ok(RunCompletion::Interrupted);
                    }
                }
            }
            stream_deltas.flush().await?;
            if !saw_completed {
                return Err(AppError::Provider(
                    "ChatGPT response stream ended before completion".into(),
                ));
            }
            break 'conversation;
        }
        let conversation_id = conversation_id.ok_or_else(|| {
            AppError::Provider("ChatGPT completed without a conversation id".into())
        })?;
        let completed_messages = message_order
            .into_iter()
            .filter_map(|id| {
                messages
                    .remove(&id)
                    .filter(|text| !text.is_empty())
                    .map(|text| (id, text))
            })
            .collect::<Vec<_>>();
        let parent_message_id = completed_messages
            .last()
            .map(|(id, _)| id.clone())
            .ok_or_else(|| {
                AppError::Provider("ChatGPT completed without an assistant message".into())
            })?;

        for (id, text) in completed_messages {
            let item = ThreadItem::AgentMessage {
                id,
                text: strip_content_reference_markers(&text),
                phase: Some(MessagePhase::FinalAnswer),
            };
            let item = inner
                .storage
                .append_thread_item(run.turn_id.clone(), item, None)
                .await?;
            inner.emit_notification(
                &app,
                EngineNotification::ItemCompleted(ItemNotification {
                    thread_id: run.thread_id.clone(),
                    turn_id: run.turn_id.clone(),
                    item,
                }),
            )?;
        }
        inner
            .storage
            .update_chat_conversation_state(run.thread_id, conversation_id, parent_message_id)
            .await?;
        Ok(RunCompletion::Completed)
    }
    .await;
    stream_deltas.flush().await?;
    result
}

async fn wait_for_recoverable_chat_error(
    inner: &NativeEngineInner,
    app: &AppHandle,
    cancellation: &mut watch::Receiver<bool>,
    error: &AppError,
    transient_failure_count: &mut u32,
) -> Option<bool> {
    let (wait, message) = match error {
        AppError::RateLimited {
            retry_after_seconds,
            ..
        } => {
            *transient_failure_count = 0;
            let wait = automatic_rate_limit_wait(retry_after_seconds.unwrap_or(60));
            (
                wait,
                format!(
                    "ChatGPT usage limit reached; keeping the turn active and retrying in {}.",
                    describe_duration(wait.as_secs())
                ),
            )
        }
        _ if error.is_transient() => {
            *transient_failure_count = transient_failure_count.saturating_add(1);
            let wait = automatic_provider_retry_wait(*transient_failure_count);
            (
                wait,
                format!(
                    "Transient ChatGPT provider failure; keeping the turn active and retrying in {}: {error}",
                    describe_duration(wait.as_secs())
                ),
            )
        }
        _ => return None,
    };
    inner.emit_diagnostic(app, DiagnosticStream::Runtime, message);
    Some(wait_for_chat_retry(wait, cancellation).await)
}

async fn wait_for_chat_retry(wait: Duration, cancellation: &mut watch::Receiver<bool>) -> bool {
    if *cancellation.borrow() {
        return false;
    }
    let sleep = tokio::time::sleep(wait);
    tokio::pin!(sleep);
    loop {
        tokio::select! {
            _ = &mut sleep => return true,
            changed = cancellation.changed() => {
                if changed.is_err() || *cancellation.borrow() {
                    return false;
                }
            }
        }
    }
}

async fn emit_text_delta(
    stream_deltas: &StreamNotificationBatcher,
    item_id: &str,
    delta: &str,
) -> Result<(), AppError> {
    stream_deltas
        .push(StreamDelta::AgentText {
            item_id: item_id.to_string(),
            delta: delta.to_string(),
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::prompt_from_prepared_turn;
    use crate::engine::native::agent::PreparedTurn;
    use crate::engine::native::provider::{ResponseContent, ResponseItem};
    use crate::engine::{ThreadItem, UserContent};

    #[test]
    fn chat_prompt_reuses_validated_text_and_rejects_unuploaded_images() {
        let text = PreparedTurn {
            user_item: ThreadItem::UserMessage {
                id: "user".into(),
                content: vec![UserContent::Text {
                    text: "Olá".into()
                }],
            },
            provider_item: ResponseItem::user_content(vec![ResponseContent::InputText {
                text: "Olá".into(),
            }]),
            preview: "Olá".into(),
        };
        assert_eq!(
            prompt_from_prepared_turn(&text).expect("text should be accepted"),
            "Olá"
        );

        let image = PreparedTurn {
            provider_item: ResponseItem::user_content(vec![ResponseContent::InputImage {
                image_url: "data:image/png;base64,AA==".into(),
                detail: None,
            }]),
            ..text
        };
        assert!(prompt_from_prepared_turn(&image).is_err());
    }
}
