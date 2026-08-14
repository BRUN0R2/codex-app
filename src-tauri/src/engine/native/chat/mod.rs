mod client;
mod integrity;
mod models;
mod stream;

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use tauri::AppHandle;
use tokio::sync::{RwLock, watch};

use self::client::{ChatClient, ChatConversationRequest};
use self::models::{ChatModelCatalog, SelectedChatModel};
use self::stream::ChatStreamEvent;
use super::NativeEngineInner;
use super::agent::{PreparedTurn, RunCompletion};
use super::auth::ChatGptAuth;
use super::content_references::strip_content_reference_markers;
use super::provider::{ResponseContent, ResponseItem};
use crate::engine::{
    ChatModelListResponse, EngineNotification, ItemNotification, MessagePhase,
    TextDeltaNotification, ThreadItem,
};
use crate::error::AppError;

const MAX_MODELS: usize = 100;
const MAX_STREAM_DELTA_BYTES: usize = 64 * 1_024;

#[derive(Default)]
pub(super) struct ChatGptConsumerProvider {
    client: ChatClient,
    catalog: RwLock<Option<Arc<ChatModelCatalog>>>,
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
        let catalog = self.refresh_catalog(app, auth).await?;
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
        let catalog = match self.catalog.read().await.clone() {
            Some(catalog) => catalog,
            None => self.refresh_catalog(app, auth).await?,
        };
        catalog.select(requested)
    }

    async fn start_conversation(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
        request: ChatConversationRequest,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<stream::ChatStream, AppError> {
        let session = auth.session(app).await?;
        self.client
            .start_conversation(&session, request, cancellation)
            .await
    }

    pub async fn clear_session_state(&self) {
        *self.catalog.write().await = None;
    }

    async fn refresh_catalog(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
    ) -> Result<Arc<ChatModelCatalog>, AppError> {
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
    let mut stream = match inner
        .chat
        .start_conversation(&app, &inner.auth, request, &mut run.cancellation)
        .await
    {
        Ok(stream) => stream,
        Err(AppError::Cancelled(_)) => return Ok(RunCompletion::Interrupted),
        Err(error) => return Err(error),
    };

    let mut messages = BTreeMap::<String, String>::new();
    let mut message_order = Vec::<String>::new();
    let mut emitted = HashMap::<String, String>::new();
    let mut saw_completed = false;

    while let Some(event) = stream.next_event(&mut run.cancellation).await? {
        match event {
            ChatStreamEvent::ConversationId(id) => conversation_id = Some(id),
            ChatStreamEvent::Message(snapshot) => {
                if let Some(id) = snapshot.conversation_id {
                    conversation_id = Some(id);
                }
                if !messages.contains_key(&snapshot.id) {
                    message_order.push(snapshot.id.clone());
                }
                let previous = emitted.entry(snapshot.id.clone()).or_default();
                if snapshot.text.starts_with(previous.as_str()) {
                    let delta = &snapshot.text[previous.len()..];
                    emit_text_delta(
                        &inner,
                        &app,
                        &run.thread_id,
                        &run.turn_id,
                        &snapshot.id,
                        delta,
                    )?;
                }
                *previous = snapshot.text.clone();
                messages.insert(snapshot.id, snapshot.text);
            }
            ChatStreamEvent::Completed => {
                saw_completed = true;
                break;
            }
            ChatStreamEvent::Interrupted => return Ok(RunCompletion::Interrupted),
        }
    }
    if !saw_completed {
        return Err(AppError::Provider(
            "ChatGPT response stream ended before completion".into(),
        ));
    }
    let conversation_id = conversation_id
        .ok_or_else(|| AppError::Provider("ChatGPT completed without a conversation id".into()))?;
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
        inner
            .storage
            .append_thread_item(run.turn_id.clone(), item.clone())
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

fn emit_text_delta(
    inner: &NativeEngineInner,
    app: &AppHandle,
    thread_id: &str,
    turn_id: &str,
    item_id: &str,
    delta: &str,
) -> Result<(), AppError> {
    let mut remaining = delta;
    while !remaining.is_empty() {
        let mut boundary = remaining.len().min(MAX_STREAM_DELTA_BYTES);
        while !remaining.is_char_boundary(boundary) {
            boundary -= 1;
        }
        let (chunk, rest) = remaining.split_at(boundary);
        inner.emit_notification(
            app,
            EngineNotification::AgentTextDelta(TextDeltaNotification {
                thread_id: thread_id.to_string(),
                turn_id: turn_id.to_string(),
                item_id: item_id.to_string(),
                delta: chunk.to_string(),
            }),
        )?;
        remaining = rest;
    }
    Ok(())
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
