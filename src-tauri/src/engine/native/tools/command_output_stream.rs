use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;
use tokio::sync::Notify;

use super::super::stream_notifications::StreamNotificationBatcher;
use super::super::terminal_output::TerminalOperation;
use super::super::text::utf8_prefix_length;
use crate::engine::{CommandOutputOperation, CommandOutputStream, StreamDelta};
use crate::error::AppError;

const MAX_LIVE_COMMAND_OUTPUT_BYTES: usize = 256 * 1_024;
const MAX_COMMAND_TRANSCRIPT_STREAM_BYTES: usize = 256 * 1_024;
const MAX_COMMAND_TRANSCRIPT_CHECKPOINTS: usize = 2_048;
const COMMAND_TRANSCRIPT_OMISSION_MARKER: &str = "\n[... earlier output omitted ...]\n";

#[derive(Clone)]
pub(super) struct CommandOutputEmitter {
    inner: Arc<EmitterInner>,
}

struct EmitterInner {
    batcher: Option<StreamNotificationBatcher>,
    item_id: String,
    state: Mutex<EmitterState>,
    transcript: CommandTranscript,
}

#[derive(Default)]
struct EmitterState {
    emitted_bytes: usize,
    truncated: bool,
}

struct AppendPlan {
    visible_bytes: usize,
    became_truncated: bool,
}

struct ControlPlan {
    emit: bool,
    became_truncated: bool,
}

#[derive(Clone, Default)]
pub(super) struct CommandTranscript {
    inner: Arc<TranscriptInner>,
}

#[derive(Default)]
struct TranscriptInner {
    state: Mutex<TranscriptState>,
    changed: Notify,
}

#[derive(Default)]
struct TranscriptState {
    revision: u64,
    stdout: BoundedTerminalText,
    stderr: BoundedTerminalText,
    checkpoints: VecDeque<TranscriptCheckpoint>,
}

#[derive(Default)]
struct BoundedTerminalText {
    text: String,
    truncated: bool,
    generation: u64,
}

#[derive(Clone, Copy, Default)]
struct TerminalTextCheckpoint {
    byte_length: usize,
    generation: u64,
}

#[derive(Clone, Copy)]
struct TranscriptCheckpoint {
    revision: u64,
    stdout: TerminalTextCheckpoint,
    stderr: TerminalTextCheckpoint,
}

#[derive(Clone)]
pub(super) struct CommandTranscriptSnapshot {
    pub revision: u64,
    pub live_output: crate::engine::CommandLiveOutput,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CommandTranscriptOutputMode {
    Snapshot,
    Delta,
}

pub(super) struct CommandTranscriptPollSnapshot {
    pub revision: u64,
    pub output: crate::engine::CommandLiveOutput,
    pub mode: CommandTranscriptOutputMode,
}

impl CommandOutputEmitter {
    pub(super) fn new(
        batcher: StreamNotificationBatcher,
        item_id: String,
        transcript: CommandTranscript,
    ) -> Self {
        Self {
            inner: Arc::new(EmitterInner {
                batcher: Some(batcher),
                item_id,
                state: Mutex::new(EmitterState::default()),
                transcript,
            }),
        }
    }

    pub(super) fn without_notifications(transcript: CommandTranscript) -> Self {
        Self {
            inner: Arc::new(EmitterInner {
                batcher: None,
                item_id: "test-command".into(),
                state: Mutex::new(EmitterState::default()),
                transcript,
            }),
        }
    }

    pub(super) async fn emit(
        &self,
        stream: CommandOutputStream,
        operations: Vec<TerminalOperation>,
    ) -> Result<(), AppError> {
        self.inner.transcript.apply(stream, &operations).await;
        let mut state = self.inner.state.lock().await;
        for operation in operations {
            if state.truncated {
                break;
            }
            match operation {
                TerminalOperation::Append(delta) => {
                    let plan = state.plan_append(&delta);
                    if plan.visible_bytes > 0 {
                        let visible = if plan.visible_bytes == delta.len() {
                            delta
                        } else {
                            delta[..plan.visible_bytes].to_string()
                        };
                        self.push(stream, CommandOutputOperation::Append { delta: visible })
                            .await?;
                    }
                    if plan.became_truncated {
                        self.push(stream, CommandOutputOperation::Truncated).await?;
                    }
                }
                TerminalOperation::Backspace => {
                    let plan = state.plan_control();
                    if plan.emit {
                        self.push(stream, CommandOutputOperation::Backspace).await?;
                    }
                    if plan.became_truncated {
                        self.push(stream, CommandOutputOperation::Truncated).await?;
                    }
                }
                TerminalOperation::ClearCurrentLine => {
                    let plan = state.plan_control();
                    if plan.emit {
                        self.push(stream, CommandOutputOperation::ClearCurrentLine)
                            .await?;
                    }
                    if plan.became_truncated {
                        self.push(stream, CommandOutputOperation::Truncated).await?;
                    }
                }
            }
        }
        Ok(())
    }

    pub(super) async fn flush(&self) -> Result<(), AppError> {
        match &self.inner.batcher {
            Some(batcher) => batcher.flush().await,
            None => Ok(()),
        }
    }

    async fn push(
        &self,
        stream: CommandOutputStream,
        operation: CommandOutputOperation,
    ) -> Result<(), AppError> {
        let Some(batcher) = &self.inner.batcher else {
            return Ok(());
        };
        batcher
            .push(StreamDelta::CommandOutput {
                item_id: self.inner.item_id.clone(),
                stream,
                operation,
            })
            .await
    }
}

impl CommandTranscript {
    pub(super) async fn apply(
        &self,
        stream: CommandOutputStream,
        operations: &[TerminalOperation],
    ) {
        if operations.is_empty() {
            return;
        }
        let mut state = self.inner.state.lock().await;
        let target = match stream {
            CommandOutputStream::Stdout => &mut state.stdout,
            CommandOutputStream::Stderr => &mut state.stderr,
        };
        for operation in operations {
            target.apply(operation);
        }
        state.revision = state.revision.saturating_add(1);
        let checkpoint = state.checkpoint();
        state.checkpoints.push_back(checkpoint);
        if state.checkpoints.len() > MAX_COMMAND_TRANSCRIPT_CHECKPOINTS {
            state.checkpoints.pop_front();
        }
        drop(state);
        self.inner.changed.notify_waiters();
    }

    pub(super) async fn snapshot(&self) -> CommandTranscriptSnapshot {
        let state = self.inner.state.lock().await;
        state.snapshot()
    }

    pub(super) async fn revision(&self) -> u64 {
        self.inner.state.lock().await.revision
    }

    pub(super) async fn poll_snapshot_since(
        &self,
        revision: u64,
        prefer_incremental: bool,
    ) -> CommandTranscriptPollSnapshot {
        let state = self.inner.state.lock().await;
        state.poll_snapshot(revision, prefer_incremental)
    }

    #[cfg(test)]
    pub(super) async fn snapshot_after(
        &self,
        revision: u64,
        wait: Duration,
    ) -> CommandTranscriptSnapshot {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let changed = self.inner.changed.notified();
            let snapshot = self.snapshot().await;
            if snapshot.revision > revision || wait.is_zero() {
                return snapshot;
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return self.snapshot().await;
            }
        }
    }

    pub(super) async fn poll_snapshot_after(
        &self,
        revision: u64,
        wait: Duration,
        prefer_incremental: bool,
    ) -> CommandTranscriptPollSnapshot {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let changed = self.inner.changed.notified();
            let snapshot = self.poll_snapshot_since(revision, prefer_incremental).await;
            if snapshot.revision > revision || wait.is_zero() {
                return snapshot;
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return self.poll_snapshot_since(revision, prefer_incremental).await;
            }
        }
    }
}

impl TranscriptState {
    fn checkpoint(&self) -> TranscriptCheckpoint {
        TranscriptCheckpoint {
            revision: self.revision,
            stdout: self.stdout.checkpoint(),
            stderr: self.stderr.checkpoint(),
        }
    }

    fn snapshot(&self) -> CommandTranscriptSnapshot {
        CommandTranscriptSnapshot {
            revision: self.revision,
            live_output: self.live_output(),
        }
    }

    fn poll_snapshot(
        &self,
        since_revision: u64,
        prefer_incremental: bool,
    ) -> CommandTranscriptPollSnapshot {
        if prefer_incremental && let Some(output) = self.incremental_since(since_revision) {
            return CommandTranscriptPollSnapshot {
                revision: self.revision,
                output,
                mode: CommandTranscriptOutputMode::Delta,
            };
        }
        CommandTranscriptPollSnapshot {
            revision: self.revision,
            output: self.live_output(),
            mode: CommandTranscriptOutputMode::Snapshot,
        }
    }

    fn live_output(&self) -> crate::engine::CommandLiveOutput {
        crate::engine::CommandLiveOutput {
            stdout: self.stdout.text.clone(),
            stderr: self.stderr.text.clone(),
            truncated: self.stdout.truncated || self.stderr.truncated,
        }
    }

    fn incremental_since(&self, revision: u64) -> Option<crate::engine::CommandLiveOutput> {
        let checkpoint = if revision == 0 {
            TranscriptCheckpoint {
                revision,
                stdout: TerminalTextCheckpoint::default(),
                stderr: TerminalTextCheckpoint::default(),
            }
        } else {
            self.checkpoints
                .iter()
                .rev()
                .find(|checkpoint| checkpoint.revision == revision)
                .copied()?
        };
        Some(crate::engine::CommandLiveOutput {
            stdout: self.stdout.delta_since(checkpoint.stdout)?.into(),
            stderr: self.stderr.delta_since(checkpoint.stderr)?.into(),
            truncated: false,
        })
    }
}

impl BoundedTerminalText {
    fn checkpoint(&self) -> TerminalTextCheckpoint {
        TerminalTextCheckpoint {
            byte_length: self.text.len(),
            generation: self.generation,
        }
    }

    fn delta_since(&self, checkpoint: TerminalTextCheckpoint) -> Option<&str> {
        if checkpoint.generation != self.generation
            || checkpoint.byte_length > self.text.len()
            || !self.text.is_char_boundary(checkpoint.byte_length)
        {
            return None;
        }
        Some(&self.text[checkpoint.byte_length..])
    }

    fn apply(&mut self, operation: &TerminalOperation) {
        match operation {
            TerminalOperation::Append(delta) => self.text.push_str(delta),
            TerminalOperation::Backspace => {
                let line_start = self.text.rfind('\n').map_or(0, |index| index + 1);
                if self.text.len() > line_start {
                    self.text.pop();
                    self.generation = self.generation.saturating_add(1);
                }
            }
            TerminalOperation::ClearCurrentLine => {
                let retained_bytes = self.text.rfind('\n').map_or(0, |index| index + 1);
                if retained_bytes != self.text.len() {
                    self.text.truncate(retained_bytes);
                    self.generation = self.generation.saturating_add(1);
                }
            }
        }
        self.rebalance();
    }

    fn rebalance(&mut self) {
        if self.text.len() <= MAX_COMMAND_TRANSCRIPT_STREAM_BYTES {
            return;
        }
        let tail_bytes = MAX_COMMAND_TRANSCRIPT_STREAM_BYTES
            .saturating_sub(COMMAND_TRANSCRIPT_OMISSION_MARKER.len());
        let mut start = self.text.len().saturating_sub(tail_bytes);
        while !self.text.is_char_boundary(start) {
            start += 1;
        }
        let mut retained = String::with_capacity(
            COMMAND_TRANSCRIPT_OMISSION_MARKER.len() + self.text.len() - start,
        );
        retained.push_str(COMMAND_TRANSCRIPT_OMISSION_MARKER);
        retained.push_str(&self.text[start..]);
        self.text = retained;
        self.truncated = true;
        self.generation = self.generation.saturating_add(1);
    }
}

impl EmitterState {
    fn plan_append(&mut self, delta: &str) -> AppendPlan {
        if self.truncated {
            return AppendPlan {
                visible_bytes: 0,
                became_truncated: false,
            };
        }
        let remaining = MAX_LIVE_COMMAND_OUTPUT_BYTES.saturating_sub(self.emitted_bytes);
        let visible_bytes = utf8_prefix_length(delta, remaining);
        self.emitted_bytes = self.emitted_bytes.saturating_add(visible_bytes);
        let became_truncated = delta.len() > remaining;
        self.truncated = became_truncated;
        AppendPlan {
            visible_bytes,
            became_truncated,
        }
    }

    fn plan_control(&mut self) -> ControlPlan {
        if self.truncated {
            return ControlPlan {
                emit: false,
                became_truncated: false,
            };
        }
        if self.emitted_bytes >= MAX_LIVE_COMMAND_OUTPUT_BYTES {
            self.truncated = true;
            return ControlPlan {
                emit: false,
                became_truncated: true,
            };
        }
        self.emitted_bytes += 1;
        ControlPlan {
            emit: true,
            became_truncated: false,
        }
    }
}

#[cfg(test)]
#[path = "command_output_stream_tests.rs"]
mod tests;
