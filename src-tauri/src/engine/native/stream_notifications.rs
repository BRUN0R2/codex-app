use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tokio::sync::Mutex;

use super::NativeEngineInner;
use crate::engine::{DiagnosticStream, EngineNotification, StreamDelta, StreamDeltasNotification};
use crate::error::AppError;

const STREAM_BATCH_INTERVAL: Duration = Duration::from_millis(8);
const MAX_STREAM_BATCH_ENTRIES: usize = 128;
const MAX_STREAM_BATCH_BYTES: usize = 512 * 1_024;
const MAX_STREAM_DELTA_BYTES: usize = 64 * 1_024;

#[derive(Clone)]
pub(super) struct StreamNotificationBatcher {
    inner: Arc<BatcherInner>,
}

struct BatcherInner {
    engine: Arc<NativeEngineInner>,
    app: AppHandle,
    thread_id: String,
    turn_id: String,
    state: Mutex<BatchState>,
}

#[derive(Default)]
struct BatchState {
    pending: Vec<StreamDelta>,
    pending_bytes: usize,
    leading_keys: HashSet<StreamDeltaKey>,
    scheduled_generation: Option<u64>,
    generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum StreamDeltaKey {
    AgentText(String),
    ReasoningSummary(String, usize),
    ReasoningText(String, usize),
}

impl StreamNotificationBatcher {
    pub fn new(
        engine: Arc<NativeEngineInner>,
        app: AppHandle,
        thread_id: String,
        turn_id: String,
    ) -> Self {
        Self {
            inner: Arc::new(BatcherInner {
                engine,
                app,
                thread_id,
                turn_id,
                state: Mutex::new(BatchState::default()),
            }),
        }
    }

    pub async fn push(&self, delta: StreamDelta) -> Result<(), AppError> {
        for chunk in split_stream_delta(delta) {
            self.push_chunk(chunk).await?;
        }
        Ok(())
    }

    async fn push_chunk(&self, delta: StreamDelta) -> Result<(), AppError> {
        if delta_text(&delta).is_empty() {
            return Ok(());
        }
        let key = delta_key(&delta);
        let encoded_bytes = delta_bytes(&delta);
        let mut schedule = None;
        {
            let mut state = self.inner.state.lock().await;
            if state.leading_keys.insert(key) {
                state.cancel_schedule();
                let pending = state.take_pending();
                self.inner.emit(pending)?;
                self.inner.emit(vec![delta])?;
                return Ok(());
            }
            if !state.pending.is_empty()
                && (state.pending.len() >= MAX_STREAM_BATCH_ENTRIES
                    || state.pending_bytes.saturating_add(encoded_bytes) > MAX_STREAM_BATCH_BYTES)
            {
                let pending = state.take_pending();
                self.inner.emit(pending)?;
            }
            state.pending_bytes = state.pending_bytes.saturating_add(encoded_bytes);
            state.pending.push(delta);
            if state.scheduled_generation.is_none() {
                state.generation = state.generation.wrapping_add(1);
                state.scheduled_generation = Some(state.generation);
                schedule = Some(state.generation);
            }
        }
        if let Some(generation) = schedule {
            let batcher = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(STREAM_BATCH_INTERVAL).await;
                batcher.flush_scheduled(generation).await;
            });
        }
        Ok(())
    }

    pub async fn flush(&self) -> Result<(), AppError> {
        let mut state = self.inner.state.lock().await;
        state.cancel_schedule();
        let pending = state.take_pending();
        self.inner.emit(pending)
    }

    async fn flush_scheduled(&self, generation: u64) {
        let mut state = self.inner.state.lock().await;
        if state.scheduled_generation != Some(generation) {
            return;
        }
        state.scheduled_generation = None;
        let pending = state.take_pending();
        if let Err(error) = self.inner.emit(pending) {
            self.inner.engine.emit_diagnostic(
                &self.inner.app,
                DiagnosticStream::Runtime,
                format!("could not emit a stream delta batch: {error}"),
            );
        }
    }
}

impl BatcherInner {
    fn emit(&self, deltas: Vec<StreamDelta>) -> Result<(), AppError> {
        if deltas.is_empty() {
            return Ok(());
        }
        self.engine.emit_notification(
            &self.app,
            EngineNotification::StreamDeltas(StreamDeltasNotification {
                thread_id: self.thread_id.clone(),
                turn_id: self.turn_id.clone(),
                deltas,
            }),
        )
    }
}

impl BatchState {
    fn cancel_schedule(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.scheduled_generation = None;
    }

    fn take_pending(&mut self) -> Vec<StreamDelta> {
        self.pending_bytes = 0;
        std::mem::take(&mut self.pending)
    }
}

fn delta_key(delta: &StreamDelta) -> StreamDeltaKey {
    match delta {
        StreamDelta::AgentText { item_id, .. } => StreamDeltaKey::AgentText(item_id.clone()),
        StreamDelta::ReasoningSummary { item_id, index, .. } => {
            StreamDeltaKey::ReasoningSummary(item_id.clone(), *index)
        }
        StreamDelta::ReasoningText { item_id, index, .. } => {
            StreamDeltaKey::ReasoningText(item_id.clone(), *index)
        }
    }
}

fn delta_text(delta: &StreamDelta) -> &str {
    match delta {
        StreamDelta::AgentText { delta, .. }
        | StreamDelta::ReasoningSummary { delta, .. }
        | StreamDelta::ReasoningText { delta, .. } => delta,
    }
}

fn delta_bytes(delta: &StreamDelta) -> usize {
    let item_bytes = match delta {
        StreamDelta::AgentText { item_id, .. }
        | StreamDelta::ReasoningSummary { item_id, .. }
        | StreamDelta::ReasoningText { item_id, .. } => item_id.len(),
    };
    item_bytes.saturating_add(delta_text(delta).len())
}

fn split_stream_delta(delta: StreamDelta) -> Vec<StreamDelta> {
    if delta_text(&delta).len() <= MAX_STREAM_DELTA_BYTES {
        return vec![delta];
    }
    match delta {
        StreamDelta::AgentText { item_id, delta } => split_text(delta)
            .into_iter()
            .map(|delta| StreamDelta::AgentText {
                item_id: item_id.clone(),
                delta,
            })
            .collect(),
        StreamDelta::ReasoningSummary {
            item_id,
            index,
            delta,
        } => split_text(delta)
            .into_iter()
            .map(|delta| StreamDelta::ReasoningSummary {
                item_id: item_id.clone(),
                index,
                delta,
            })
            .collect(),
        StreamDelta::ReasoningText {
            item_id,
            index,
            delta,
        } => split_text(delta)
            .into_iter()
            .map(|delta| StreamDelta::ReasoningText {
                item_id: item_id.clone(),
                index,
                delta,
            })
            .collect(),
    }
}

fn split_text(text: String) -> Vec<String> {
    let mut chunks = Vec::with_capacity(text.len().div_ceil(MAX_STREAM_DELTA_BYTES));
    let mut remaining = text.as_str();
    while !remaining.is_empty() {
        let mut boundary = remaining.len().min(MAX_STREAM_DELTA_BYTES);
        while !remaining.is_char_boundary(boundary) {
            boundary -= 1;
        }
        let (chunk, rest) = remaining.split_at(boundary);
        chunks.push(chunk.to_string());
        remaining = rest;
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::{MAX_STREAM_DELTA_BYTES, split_stream_delta};
    use crate::engine::StreamDelta;

    #[test]
    fn splits_large_unicode_deltas_without_changing_content() {
        let text = "á".repeat(MAX_STREAM_DELTA_BYTES);
        let chunks = split_stream_delta(StreamDelta::ReasoningText {
            item_id: "reasoning-1".into(),
            index: 2,
            delta: text.clone(),
        });

        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| match chunk {
            StreamDelta::ReasoningText {
                item_id,
                index,
                delta,
            } => item_id == "reasoning-1" && *index == 2 && delta.len() <= MAX_STREAM_DELTA_BYTES,
            _ => false,
        }));
        assert_eq!(
            chunks
                .into_iter()
                .map(|chunk| match chunk {
                    StreamDelta::ReasoningText { delta, .. } => delta,
                    _ => unreachable!("the delta kind is preserved"),
                })
                .collect::<String>(),
            text
        );
    }
}
