use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Weak;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU8;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use futures_util::future::join_all;
use tauri::AppHandle;
use tokio::sync::Mutex;
use tokio::sync::Notify;
use tokio::sync::watch;
use uuid::Uuid;

use super::ExecCommandArgs;
use super::Ripgrep;
use super::StoredToolOutput;
use super::command_output_stream::CommandOutputEmitter;
use super::command_output_stream::CommandTranscript;
use super::command_output_stream::CommandTranscriptOutputMode;
use super::command_output_stream::CommandTranscriptPollSnapshot;
use super::command_output_stream::CommandTranscriptSnapshot;
use super::exec::CommandOutput;
use super::exec::execute_command;
use super::workspace::display_workspace_path;
use crate::engine::ActivityStatus;
use crate::engine::CommandLiveOutput;
use crate::engine::CommandSource;
use crate::engine::DiagnosticStream;
use crate::engine::ThreadItem;
use crate::engine::ThreadOutput;
use crate::engine::native::NativeEngineInner;
use crate::engine::native::agent::emit_item_notification;
use crate::engine::native::stream_notifications::StreamNotificationBatcher;
use crate::error::AppError;

const DELIVERY_FOREGROUND: u8 = 0;
const DELIVERY_BACKGROUND: u8 = 1;
const DELIVERY_CONSUMED: u8 = 2;
const MAX_COMMAND_SESSIONS: usize = 32;
const MAX_POLL_PREVIEW_BYTES: usize = 32 * 1_024;
const SESSION_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub(in crate::engine::native) struct CommandSessionManager {
    sessions: Mutex<HashMap<String, Arc<CommandSession>>>,
}

pub(super) enum CommandStartOutcome {
    Completed(CommandOutput),
    Running(BackgroundCommandStart),
}

pub(super) struct BackgroundCommandStart {
    pub lease: BackgroundCommandLease,
    pub provider_output: String,
    pub live_output: CommandLiveOutput,
}

pub(in crate::engine::native) struct BackgroundCommandLease {
    session: Arc<CommandSession>,
    settled: bool,
}

#[derive(Clone)]
struct CommandTerminal {
    status: ActivityStatus,
    exit_code: Option<i32>,
    duration_ms: u64,
    output: Option<ThreadOutput>,
    summary: String,
}

struct CommandSession {
    id: String,
    thread_id: String,
    turn_id: String,
    item_id: String,
    command: String,
    cwd: String,
    started_at_ms: i64,
    started_at: Instant,
    app: Option<AppHandle>,
    engine: Weak<NativeEngineInner>,
    transcript: CommandTranscript,
    cancellation: watch::Sender<bool>,
    result: Mutex<Option<Result<CommandOutput, AppError>>>,
    terminal: Mutex<Option<CommandTerminal>>,
    interaction: Mutex<()>,
    finished: AtomicBool,
    terminal_ready: AtomicBool,
    persisted: AtomicBool,
    discarded: AtomicBool,
    finalizer_started: AtomicBool,
    delivery: AtomicU8,
    finished_notify: Notify,
    persisted_notify: Notify,
    terminal_notify: Notify,
}

struct ForegroundSessionGuard {
    session: Arc<CommandSession>,
    armed: bool,
}

impl BackgroundCommandLease {
    fn new(session: Arc<CommandSession>) -> Self {
        Self {
            session,
            settled: false,
        }
    }

    pub(super) fn session_id(&self) -> &str {
        &self.session.id
    }

    pub(in crate::engine::native) fn commit(mut self) {
        self.session.persisted.store(true, Ordering::Release);
        self.session.persisted_notify.notify_waiters();
        self.settled = true;
    }

    pub(in crate::engine::native) fn discard(mut self) {
        self.session.discard_before_persistence();
        self.settled = true;
    }
}

impl fmt::Debug for BackgroundCommandLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BackgroundCommandLease")
            .field("session_id", &self.session.id)
            .finish_non_exhaustive()
    }
}

impl Drop for BackgroundCommandLease {
    fn drop(&mut self) {
        if !self.settled {
            self.session.discard_before_persistence();
        }
    }
}

impl CommandSessionManager {
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn start(
        &self,
        engine: Weak<NativeEngineInner>,
        app: Option<AppHandle>,
        workspace: PathBuf,
        args: ExecCommandArgs,
        ripgrep: Ripgrep,
        stream_deltas: Option<StreamNotificationBatcher>,
        item_id: String,
        thread_id: String,
        turn_id: String,
        started_at_ms: i64,
        yield_time: Duration,
        turn_cancellation: &mut watch::Receiver<bool>,
    ) -> Result<CommandStartOutcome, AppError> {
        let id = Uuid::now_v7().to_string();
        let transcript = CommandTranscript::default();
        let emitter = match stream_deltas {
            Some(stream_deltas) => {
                CommandOutputEmitter::new(stream_deltas, item_id.clone(), transcript.clone())
            }
            None => CommandOutputEmitter::without_notifications(transcript.clone()),
        };
        let flush_emitter = emitter.clone();
        let (cancellation, mut cancellation_receiver) = watch::channel(false);
        let session = Arc::new(CommandSession {
            id,
            thread_id,
            turn_id,
            item_id,
            command: args.command.clone(),
            cwd: display_workspace_path(&workspace, &args.cwd),
            started_at_ms,
            started_at: Instant::now(),
            app,
            engine,
            transcript,
            cancellation,
            result: Mutex::new(None),
            terminal: Mutex::new(None),
            interaction: Mutex::new(()),
            finished: AtomicBool::new(false),
            terminal_ready: AtomicBool::new(false),
            persisted: AtomicBool::new(false),
            discarded: AtomicBool::new(false),
            finalizer_started: AtomicBool::new(false),
            delivery: AtomicU8::new(DELIVERY_FOREGROUND),
            finished_notify: Notify::new(),
            persisted_notify: Notify::new(),
            terminal_notify: Notify::new(),
        });
        self.insert(Arc::clone(&session)).await?;

        let worker_session = Arc::clone(&session);
        tokio::spawn(async move {
            let execution = tokio::spawn(async move {
                execute_command(
                    &workspace,
                    &args,
                    &ripgrep,
                    emitter,
                    &mut cancellation_receiver,
                )
                .await
            })
            .await
            .map_err(|error| AppError::Tool(format!("command task failed: {error}")))
            .and_then(std::convert::identity);
            let result = match flush_emitter.flush().await {
                Ok(()) => execution,
                Err(error) if execution.is_ok() => Err(error),
                Err(_) => execution,
            };
            worker_session.finish(result).await;
        });

        let mut guard = ForegroundSessionGuard {
            session: Arc::clone(&session),
            armed: true,
        };
        let wait_for_finish = session.wait_finished();
        tokio::pin!(wait_for_finish);
        let outcome = tokio::select! {
            () = &mut wait_for_finish => {
                self.consume_foreground(&session).await.map(CommandStartOutcome::Completed)
            }
            changed = turn_cancellation.changed() => {
                if changed.is_err() || *turn_cancellation.borrow() {
                    session.cancel();
                    session.wait_finished().await;
                    match self.consume_foreground(&session).await {
                        Ok(output) => Ok(CommandStartOutcome::Completed(output)),
                        Err(AppError::Cancelled(message)) => Err(AppError::Cancelled(message)),
                        Err(error) => Err(error),
                    }
                } else {
                    Err(AppError::State(
                        "turn cancellation changed without becoming active".into(),
                    ))
                }
            }
            () = tokio::time::sleep(yield_time) => {
                if session.finished.load(Ordering::Acquire) {
                    self.consume_foreground(&session).await.map(CommandStartOutcome::Completed)
                } else {
                    session.promote_to_background();
                    let snapshot = session.transcript.snapshot().await;
                    Ok(CommandStartOutcome::Running(BackgroundCommandStart {
                        lease: BackgroundCommandLease::new(Arc::clone(&session)),
                        provider_output: running_provider_output(&session, &snapshot),
                        live_output: snapshot.live_output,
                    }))
                }
            }
        };
        guard.armed = session.delivery.load(Ordering::Acquire) == DELIVERY_FOREGROUND;
        outcome
    }

    pub(super) async fn poll(
        &self,
        thread_id: &str,
        session_id: &str,
        cursor: Option<u64>,
        wait: Duration,
    ) -> Result<String, AppError> {
        let session = self.session(session_id).await?;
        if session.thread_id != thread_id {
            return Err(AppError::State(
                "command session does not belong to this thread".into(),
            ));
        }
        let _interaction_guard = session.interaction.lock().await;
        let requested_revision = cursor.unwrap_or(0);
        let current_revision = session.transcript.revision().await;
        if requested_revision > current_revision {
            return Err(AppError::Tool(format!(
                "command cursor {requested_revision} exceeds the current revision {current_revision}"
            )));
        }
        let prefer_incremental = cursor.is_some();
        let snapshot = if session.terminal.lock().await.is_some() {
            session
                .transcript
                .poll_snapshot_since(requested_revision, prefer_incremental)
                .await
        } else {
            tokio::select! {
                snapshot = session.transcript.poll_snapshot_after(
                    requested_revision,
                    wait,
                    prefer_incremental,
                ) => snapshot,
                () = session.wait_terminal() => {
                    session.transcript
                        .poll_snapshot_since(requested_revision, prefer_incremental)
                        .await
                },
            }
        };
        let terminal = session.terminal.lock().await.clone();
        Ok(poll_provider_output(
            &session,
            &snapshot,
            cursor,
            terminal.as_ref(),
        ))
    }

    pub(in crate::engine::native) async fn cancel_thread(&self, thread_id: &str) {
        let sessions = self.sessions_for_thread(thread_id).await;
        self.cancel_sessions(sessions).await;
    }

    pub(in crate::engine::native) async fn has_running_for_thread(&self, thread_id: &str) -> bool {
        self.sessions.lock().await.values().any(|session| {
            session.thread_id == thread_id && !session.finished.load(Ordering::Acquire)
        })
    }

    pub(in crate::engine::native) async fn shutdown(&self) {
        let sessions = self
            .sessions
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        self.cancel_sessions(sessions).await;
        self.sessions.lock().await.clear();
    }

    async fn insert(&self, session: Arc<CommandSession>) -> Result<(), AppError> {
        let mut sessions = self.sessions.lock().await;
        if sessions.len() >= MAX_COMMAND_SESSIONS {
            let completed = sessions
                .iter()
                .filter_map(|(id, candidate)| {
                    candidate
                        .terminal_ready
                        .load(Ordering::Acquire)
                        .then_some((id.clone(), candidate.started_at))
                })
                .min_by_key(|(_, started_at)| *started_at)
                .map(|(id, _)| id);
            if let Some(id) = completed {
                sessions.remove(&id);
            }
        }
        if sessions.len() >= MAX_COMMAND_SESSIONS {
            return Err(AppError::Tool(format!(
                "at most {MAX_COMMAND_SESSIONS} command sessions may run at once"
            )));
        }
        sessions.insert(session.id.clone(), session);
        Ok(())
    }

    async fn consume_foreground(
        &self,
        session: &Arc<CommandSession>,
    ) -> Result<CommandOutput, AppError> {
        session
            .delivery
            .compare_exchange(
                DELIVERY_FOREGROUND,
                DELIVERY_CONSUMED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .map_err(|_| AppError::State("command session left foreground ownership".into()))?;
        let result = session.take_result().await;
        self.sessions.lock().await.remove(&session.id);
        result
    }

    async fn session(&self, session_id: &str) -> Result<Arc<CommandSession>, AppError> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::State("command session does not exist".into()))
    }

    async fn sessions_for_thread(&self, thread_id: &str) -> Vec<Arc<CommandSession>> {
        self.sessions
            .lock()
            .await
            .values()
            .filter(|session| session.thread_id == thread_id)
            .cloned()
            .collect()
    }

    async fn cancel_sessions(&self, sessions: Vec<Arc<CommandSession>>) {
        self.cancel_sessions_with_timeout(sessions, SESSION_SHUTDOWN_TIMEOUT)
            .await;
    }

    async fn cancel_sessions_with_timeout(
        &self,
        sessions: Vec<Arc<CommandSession>>,
        timeout: Duration,
    ) {
        for session in &sessions {
            session.promote_to_background();
            session.cancel();
        }
        let waits = sessions.iter().map(|session| session.wait_terminal());
        let _ = tokio::time::timeout(timeout, join_all(waits)).await;
    }

    async fn remove(&self, session_id: &str) {
        self.sessions.lock().await.remove(session_id);
    }
}

impl CommandSession {
    fn discard_before_persistence(self: &Arc<Self>) {
        self.discarded.store(true, Ordering::Release);
        self.persisted_notify.notify_waiters();
        self.cancel();
        self.promote_to_background();
    }

    async fn finish(self: &Arc<Self>, result: Result<CommandOutput, AppError>) {
        *self.result.lock().await = Some(result);
        self.finished.store(true, Ordering::Release);
        self.finished_notify.notify_waiters();
        if self.delivery.load(Ordering::Acquire) == DELIVERY_BACKGROUND {
            self.start_finalizer();
        }
    }

    fn promote_to_background(self: &Arc<Self>) {
        if self
            .delivery
            .compare_exchange(
                DELIVERY_FOREGROUND,
                DELIVERY_BACKGROUND,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
            || self.delivery.load(Ordering::Acquire) == DELIVERY_BACKGROUND
        {
            self.start_finalizer();
        }
    }

    fn start_finalizer(self: &Arc<Self>) {
        if self.finalizer_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let session = Arc::clone(self);
        tokio::spawn(async move {
            session.finalize_background().await;
        });
    }

    async fn finalize_background(self: Arc<Self>) {
        self.wait_finished().await;
        self.wait_persisted_or_discarded().await;
        if self.discarded.load(Ordering::Acquire) {
            self.publish_terminal(CommandTerminal {
                status: ActivityStatus::Failed,
                exit_code: None,
                duration_ms: self.elapsed_millis(),
                output: None,
                summary: "Command session was discarded before persistence.".into(),
            })
            .await;
            if let Some(engine) = self.engine.upgrade() {
                engine.command_sessions.remove(&self.id).await;
            }
            return;
        }
        let result = self.take_result().await;
        let Some(engine) = self.engine.upgrade() else {
            self.publish_terminal(CommandTerminal {
                status: ActivityStatus::Failed,
                exit_code: None,
                duration_ms: self.elapsed_millis(),
                output: None,
                summary: "Native engine stopped before command finalization.".into(),
            })
            .await;
            return;
        };
        let (source, provider_output, exit_code, status) = match result {
            Ok(output) => match StoredToolOutput::Command(output).into_output().await {
                Ok(output) => (
                    output.source,
                    output.provider_output,
                    output.exit_code,
                    output.status,
                ),
                Err(error) => {
                    self.fail_finalization(&engine, error).await;
                    return;
                }
            },
            Err(error) => {
                let snapshot = self.transcript.snapshot().await;
                let detail = render_transcript(&snapshot, MAX_POLL_PREVIEW_BYTES);
                let output = if detail.is_empty() {
                    error.to_string()
                } else {
                    format!("{}\n\n{}", error, detail)
                };
                (
                    crate::engine::native::output::OutputSource::text(output),
                    format!("Command failed: {error}"),
                    None,
                    ActivityStatus::Failed,
                )
            }
        };
        let duration_ms = self.elapsed_millis();
        let item = ThreadItem::CommandExecution {
            id: self.item_id.clone(),
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            process_id: Some(self.id.clone()),
            started_at: Some(self.started_at_ms),
            source: CommandSource::Agent,
            status,
            aggregated_output: None,
            live_output: None,
            exit_code,
            duration_ms: Some(duration_ms),
        };
        let item = match engine
            .storage
            .complete_background_command(self.turn_id.clone(), item, source)
            .await
        {
            Ok(item) => item,
            Err(error) => {
                self.fail_finalization(&engine, error).await;
                return;
            }
        };
        let output = match &item {
            ThreadItem::CommandExecution {
                aggregated_output, ..
            } => aggregated_output.clone(),
            _ => None,
        };
        if let Some(app) = &self.app
            && let Err(error) =
                emit_item_notification(&engine, app, &self.thread_id, &self.turn_id, item, false)
        {
            engine.emit_diagnostic(app, DiagnosticStream::Runtime, error.to_string());
        }
        self.publish_terminal(CommandTerminal {
            status,
            exit_code,
            duration_ms,
            output,
            summary: provider_output,
        })
        .await;
    }

    async fn fail_finalization(&self, engine: &NativeEngineInner, error: AppError) {
        if let Some(app) = &self.app {
            engine.emit_diagnostic(
                app,
                DiagnosticStream::Runtime,
                format!(
                    "background command `{}` could not finalize: {error}",
                    self.id
                ),
            );
        }
        self.publish_terminal(CommandTerminal {
            status: ActivityStatus::Failed,
            exit_code: None,
            duration_ms: self.elapsed_millis(),
            output: None,
            summary: format!("Command finalization failed: {error}"),
        })
        .await;
    }

    async fn publish_terminal(&self, terminal: CommandTerminal) {
        *self.terminal.lock().await = Some(terminal);
        self.terminal_ready.store(true, Ordering::Release);
        self.terminal_notify.notify_waiters();
    }

    async fn take_result(&self) -> Result<CommandOutput, AppError> {
        self.result
            .lock()
            .await
            .take()
            .ok_or_else(|| AppError::State("command session result is unavailable".into()))?
    }

    async fn wait_finished(&self) {
        wait_for_flag(&self.finished_notify, || {
            self.finished.load(Ordering::Acquire)
        })
        .await;
    }

    async fn wait_persisted_or_discarded(&self) {
        wait_for_flag(&self.persisted_notify, || {
            self.persisted.load(Ordering::Acquire) || self.discarded.load(Ordering::Acquire)
        })
        .await;
    }

    async fn wait_terminal(&self) {
        wait_for_flag(&self.terminal_notify, || {
            self.terminal_ready.load(Ordering::Acquire)
        })
        .await;
    }

    fn cancel(&self) {
        self.cancellation.send_replace(true);
    }

    fn elapsed_millis(&self) -> u64 {
        u64::try_from(self.started_at.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

impl Drop for ForegroundSessionGuard {
    fn drop(&mut self) {
        if self.armed {
            self.session.promote_to_background();
        }
    }
}

async fn wait_for_flag(notify: &Notify, is_ready: impl Fn() -> bool) {
    loop {
        let notified = notify.notified();
        if is_ready() {
            return;
        }
        notified.await;
    }
}

fn running_provider_output(
    session: &CommandSession,
    snapshot: &CommandTranscriptSnapshot,
) -> String {
    let output = render_live_output(&snapshot.live_output, MAX_POLL_PREVIEW_BYTES);
    format!(
        "Command is still running.\nsession_id: {}\nstatus: running\nelapsed_ms: {}\ncursor: {}\noutput_mode: snapshot\nUse poll_command with this session_id to wait for more output while other independent work continues.\noutput:\n{}",
        session.id,
        session.elapsed_millis(),
        snapshot.revision,
        if output.is_empty() {
            "[no output yet]"
        } else {
            &output
        }
    )
}

fn poll_provider_output(
    session: &CommandSession,
    snapshot: &CommandTranscriptPollSnapshot,
    requested_cursor: Option<u64>,
    terminal: Option<&CommandTerminal>,
) -> String {
    let changed = requested_cursor.is_none_or(|cursor| snapshot.revision > cursor);
    let (output_mode, output) = if changed {
        let mode = match snapshot.mode {
            CommandTranscriptOutputMode::Snapshot => "snapshot",
            CommandTranscriptOutputMode::Delta => "delta",
        };
        let rendered = render_live_output(&snapshot.output, MAX_POLL_PREVIEW_BYTES);
        let output = if rendered.is_empty() {
            "[no visible output change]".into()
        } else {
            rendered
        };
        (mode, output)
    } else {
        (
            "unchanged",
            format!(
                "[no output change since cursor {}]",
                requested_cursor.unwrap_or(0)
            ),
        )
    };
    match terminal {
        Some(terminal) => format!(
            "session_id: {}\nstatus: {}\nelapsed_ms: {}\ncursor: {}\noutput_mode: {}\nexit_code: {}\noutput_id: {}\nresult:\n{}\noutput:\n{}",
            session.id,
            if terminal.status == ActivityStatus::Completed {
                "completed"
            } else {
                "failed"
            },
            terminal.duration_ms,
            snapshot.revision,
            output_mode,
            terminal
                .exit_code
                .map_or_else(|| "null".into(), |code| code.to_string()),
            terminal
                .output
                .as_ref()
                .map_or("null", |output| output.id.as_str()),
            terminal.summary,
            output
        ),
        None => format!(
            "session_id: {}\nstatus: running\nelapsed_ms: {}\ncursor: {}\noutput_mode: {}\noutput:\n{}",
            session.id,
            session.elapsed_millis(),
            snapshot.revision,
            output_mode,
            output
        ),
    }
}

fn render_transcript(snapshot: &CommandTranscriptSnapshot, maximum_bytes: usize) -> String {
    render_live_output(&snapshot.live_output, maximum_bytes)
}

fn render_live_output(live_output: &CommandLiveOutput, maximum_bytes: usize) -> String {
    let per_stream = maximum_bytes / 2;
    let stdout = utf8_suffix(&live_output.stdout, per_stream);
    let stderr = utf8_suffix(&live_output.stderr, per_stream);
    let mut output = String::new();
    if !stdout.is_empty() {
        output.push_str("stdout:\n");
        output.push_str(stdout);
    }
    if !stderr.is_empty() {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str("stderr:\n");
        output.push_str(stderr);
    }
    if live_output.truncated {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str("[live transcript truncated; full output is preserved after completion]");
    }
    output
}

fn utf8_suffix(value: &str, maximum_bytes: usize) -> &str {
    if value.len() <= maximum_bytes {
        return value;
    }
    let mut start = value.len() - maximum_bytes;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

#[cfg(test)]
mod tests {
    use std::hint::black_box;
    use std::sync::Arc;
    use std::sync::Weak;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::AtomicU8;
    use std::sync::atomic::Ordering;
    use std::time::Duration;
    use std::time::Instant;

    use tempfile::TempDir;
    use tokio::sync::Mutex;
    use tokio::sync::Notify;
    use tokio::sync::watch;

    use super::BackgroundCommandLease;
    use super::CommandSession;
    use super::CommandSessionManager;
    use super::CommandStartOutcome;
    use super::CommandTerminal;
    use super::CommandTranscriptOutputMode;
    use super::DELIVERY_BACKGROUND;
    use crate::engine::ActivityStatus;
    use crate::engine::CommandOutputStream;
    use crate::engine::ThreadOutput;
    use crate::engine::native::NativeEngineInner;
    use crate::engine::native::terminal_output::TerminalOperation;
    use crate::engine::native::tools::ExecCommandArgs;
    use crate::engine::native::tools::Ripgrep;
    use crate::engine::native::tools::command_output_stream::CommandTranscript;

    const BACKGROUND_COMMAND_BENCHMARK_SAMPLE_COUNT: usize = 5;
    const POLL_COPY_ELISION_ITERATIONS: usize = 2_000;
    const POLL_COPY_ELISION_TRANSCRIPT_BYTES: usize = 256 * 1_024;

    #[tokio::test]
    async fn polling_reports_revisions_and_terminal_metadata() {
        let manager = CommandSessionManager::default();
        let session = test_session("session-a", "thread-a");
        session
            .transcript
            .apply(
                CommandOutputStream::Stdout,
                &[TerminalOperation::Append("running\n".into())],
            )
            .await;
        manager
            .sessions
            .lock()
            .await
            .insert(session.id.clone(), Arc::clone(&session));

        let running = manager
            .poll("thread-a", "session-a", None, Duration::ZERO)
            .await
            .expect("running session should poll");
        assert!(running.contains("status: running"));
        assert!(running.contains("cursor: 1"));
        assert!(running.contains("stdout:\nrunning"));

        session
            .publish_terminal(CommandTerminal {
                status: ActivityStatus::Completed,
                exit_code: Some(0),
                duration_ms: 1_250,
                output: Some(ThreadOutput {
                    id: "output-a".into(),
                    preview: "done".into(),
                    byte_length: 4,
                    next_cursor: None,
                }),
                summary: "done".into(),
            })
            .await;
        let completed = manager
            .poll("thread-a", "session-a", Some(1), Duration::ZERO)
            .await
            .expect("completed session should poll");
        assert!(completed.contains("status: completed"));
        assert!(completed.contains("elapsed_ms: 1250"));
        assert!(completed.contains("exit_code: 0"));
        assert!(completed.contains("output_id: output-a"));
        assert!(completed.contains("[no output change since cursor 1]"));
    }

    #[tokio::test]
    async fn polling_returns_only_new_append_only_output_after_a_cursor() {
        let manager = CommandSessionManager::default();
        let session = test_session("session-a", "thread-a");
        let historical_output = format!("historical-only:{}\n", "a".repeat(16 * 1_024));
        session
            .transcript
            .apply(
                CommandOutputStream::Stdout,
                &[TerminalOperation::Append(historical_output)],
            )
            .await;
        manager
            .sessions
            .lock()
            .await
            .insert(session.id.clone(), Arc::clone(&session));
        let initial = manager
            .poll("thread-a", "session-a", None, Duration::ZERO)
            .await
            .expect("initial poll should return a snapshot");

        session
            .transcript
            .apply(
                CommandOutputStream::Stdout,
                &[TerminalOperation::Append("new-only\n".into())],
            )
            .await;
        let incremental = manager
            .poll("thread-a", "session-a", Some(1), Duration::ZERO)
            .await
            .expect("incremental poll should return a delta");

        assert!(initial.contains("output_mode: snapshot"));
        assert!(incremental.contains("output_mode: delta"));
        assert!(incremental.contains("new-only"));
        assert!(!incremental.contains("historical-only"));
        assert!(
            initial.len() > incremental.len() * 30,
            "incremental polling should avoid repeating the command history"
        );
    }

    #[tokio::test]
    async fn polling_rejects_a_cursor_ahead_of_the_transcript() {
        let manager = CommandSessionManager::default();
        let session = test_session("session-a", "thread-a");
        manager
            .sessions
            .lock()
            .await
            .insert(session.id.clone(), session);

        let error = manager
            .poll("thread-a", "session-a", Some(1), Duration::ZERO)
            .await
            .expect_err("a future cursor must be rejected");
        assert!(error.to_string().contains("exceeds the current revision"));
    }

    #[tokio::test]
    async fn polling_is_scoped_to_the_owning_thread() {
        let manager = CommandSessionManager::default();
        let session = test_session("session-a", "thread-a");
        manager
            .sessions
            .lock()
            .await
            .insert(session.id.clone(), session);

        let error = manager
            .poll("thread-b", "session-a", None, Duration::ZERO)
            .await
            .expect_err("another thread must not read the session");
        assert!(error.to_string().contains("does not belong"));
    }

    #[tokio::test]
    async fn background_command_lease_has_explicit_commit_and_discard_ownership() {
        let committed = test_session("session-committed", "thread-a");
        committed.persisted.store(false, Ordering::Release);
        BackgroundCommandLease::new(Arc::clone(&committed)).commit();
        assert!(committed.persisted.load(Ordering::Acquire));
        assert!(!committed.discarded.load(Ordering::Acquire));

        let discarded = test_session("session-discarded", "thread-a");
        discarded.persisted.store(false, Ordering::Release);
        BackgroundCommandLease::new(Arc::clone(&discarded)).discard();
        assert!(discarded.discarded.load(Ordering::Acquire));
        assert_eq!(
            discarded.delivery.load(Ordering::Acquire),
            DELIVERY_BACKGROUND
        );
    }

    #[tokio::test]
    async fn external_cancellation_does_not_claim_persistence_ownership() {
        let manager = CommandSessionManager::default();
        let session = test_session("session-cancelled", "thread-a");
        session.persisted.store(false, Ordering::Release);
        session
            .publish_terminal(CommandTerminal {
                status: ActivityStatus::Failed,
                exit_code: None,
                duration_ms: 1,
                output: None,
                summary: "cancelled".into(),
            })
            .await;
        let lease = BackgroundCommandLease::new(Arc::clone(&session));

        manager.cancel_sessions(vec![Arc::clone(&session)]).await;
        assert!(!session.persisted.load(Ordering::Acquire));
        assert!(!session.discarded.load(Ordering::Acquire));

        lease.commit();
        assert!(session.persisted.load(Ordering::Acquire));
        assert!(!session.discarded.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn cancellation_uses_one_global_shutdown_budget() {
        let manager = CommandSessionManager::default();
        let sessions = (0..4)
            .map(|index| test_session(&format!("session-{index}"), "thread-a"))
            .collect::<Vec<_>>();
        let shutdown_budget = Duration::from_millis(100);
        let started_at = Instant::now();

        manager
            .cancel_sessions_with_timeout(sessions, shutdown_budget)
            .await;

        assert!(
            started_at.elapsed() < Duration::from_millis(250),
            "the shutdown budget must apply to the whole session set"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn long_command_yields_and_remains_pollable() {
        let manager = CommandSessionManager::default();
        let workspace = TempDir::new().expect("workspace should exist");
        let workspace = tokio::fs::canonicalize(workspace.path())
            .await
            .expect("workspace should canonicalize");
        let args = ExecCommandArgs {
            command:
                "[Console]::Out.WriteLine('session-started'); Start-Sleep -Seconds 5; [Console]::Out.WriteLine('session-finished')"
                    .into(),
            cwd: ".".into(),
            reason: "test background yield".into(),
            parallel_safe: false,
            yield_time_ms: Some(2_000),
            timeout_seconds: Some(30),
        };
        let (_turn_cancellation, mut turn_receiver) = watch::channel(false);

        let outcome = manager
            .start(
                Weak::<NativeEngineInner>::new(),
                None,
                workspace,
                args,
                Ripgrep::for_project_tests(),
                None,
                "item-a".into(),
                "thread-a".into(),
                "turn-a".into(),
                1,
                Duration::from_secs(2),
                &mut turn_receiver,
            )
            .await
            .expect("long command should start");
        let session = match outcome {
            CommandStartOutcome::Running(session) => session,
            CommandStartOutcome::Completed(_) => panic!("long command should yield"),
        };
        assert!(session.provider_output.contains("status: running"));
        let session_id = session.lease.session_id().to_owned();
        let polled = manager
            .poll("thread-a", &session_id, None, Duration::from_secs(2))
            .await
            .expect("yielded command should poll");
        assert!(polled.contains("status: running"));
        assert!(polled.contains("session-started"));

        session.lease.discard();
        manager.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn short_command_returns_without_leaving_a_session() {
        let manager = CommandSessionManager::default();
        let workspace = TempDir::new().expect("workspace should exist");
        let workspace = tokio::fs::canonicalize(workspace.path())
            .await
            .expect("workspace should canonicalize");
        let args = ExecCommandArgs {
            command: "[Console]::Out.WriteLine('short-command')".into(),
            cwd: ".".into(),
            reason: "test foreground completion".into(),
            parallel_safe: false,
            yield_time_ms: Some(5_000),
            timeout_seconds: Some(30),
        };
        let (_turn_cancellation, mut turn_receiver) = watch::channel(false);

        let outcome = manager
            .start(
                Weak::<NativeEngineInner>::new(),
                None,
                workspace,
                args,
                Ripgrep::for_project_tests(),
                None,
                "item-a".into(),
                "thread-a".into(),
                "turn-a".into(),
                1,
                Duration::from_secs(5),
                &mut turn_receiver,
            )
            .await
            .expect("short command should execute");
        assert!(matches!(outcome, CommandStartOutcome::Completed(_)));
        assert!(manager.sessions.lock().await.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "performance benchmark"]
    async fn benchmark_background_command_yield_and_incremental_polling() {
        run_background_command_benchmark_sample(0).await;
        let mut samples = Vec::with_capacity(BACKGROUND_COMMAND_BENCHMARK_SAMPLE_COUNT);
        for sample_index in 1..=BACKGROUND_COMMAND_BENCHMARK_SAMPLE_COUNT {
            samples.push(run_background_command_benchmark_sample(sample_index).await);
        }

        let mut yield_times = samples
            .iter()
            .map(|sample| sample.yield_time)
            .collect::<Vec<_>>();
        let mut independent_times = samples
            .iter()
            .map(|sample| sample.independent_time)
            .collect::<Vec<_>>();
        let mut total_times = samples
            .iter()
            .map(|sample| sample.total_time)
            .collect::<Vec<_>>();
        let mut responsiveness_speedups = samples
            .iter()
            .map(|sample| sample.responsiveness_speedup)
            .collect::<Vec<_>>();
        let mut payload_reductions = samples
            .iter()
            .map(|sample| sample.payload_reduction)
            .collect::<Vec<_>>();
        yield_times.sort_unstable();
        independent_times.sort_unstable();
        total_times.sort_unstable();
        responsiveness_speedups.sort_by(f64::total_cmp);
        payload_reductions.sort_by(f64::total_cmp);
        let median_index = samples.len() / 2;
        let median_speedup = responsiveness_speedups[median_index];
        let median_payload_reduction = payload_reductions[median_index];
        let (full_snapshot_time, incremental_poll_time, copy_elision_speedup) =
            benchmark_poll_copy_elision().await;

        assert!(
            median_speedup >= 4.0,
            "background yield should expose at least a 4x median responsiveness improvement"
        );
        assert!(
            median_payload_reduction >= 20.0,
            "incremental polling should reduce the median repeated payload by at least 20x"
        );
        assert!(
            copy_elision_speedup >= 10.0,
            "incremental polling should avoid full transcript copies by at least 10x"
        );
        eprintln!(
            "background_command_benchmark samples={} yield_median_ms={} yield_range_ms={}..{} independent_median_ms={} independent_range_ms={}..{} total_median_ms={} total_range_ms={}..{} responsiveness_speedup_median={median_speedup:.2}x responsiveness_speedup_range={:.2}x..{:.2}x snapshot_bytes={} incremental_bytes={} payload_reduction_median={median_payload_reduction:.2}x poll_iterations={} full_snapshot_total_us={} incremental_poll_total_us={} copy_elision_speedup={copy_elision_speedup:.2}x",
            samples.len(),
            yield_times[median_index].as_millis(),
            yield_times[0].as_millis(),
            yield_times[yield_times.len() - 1].as_millis(),
            independent_times[median_index].as_millis(),
            independent_times[0].as_millis(),
            independent_times[independent_times.len() - 1].as_millis(),
            total_times[median_index].as_millis(),
            total_times[0].as_millis(),
            total_times[total_times.len() - 1].as_millis(),
            responsiveness_speedups[0],
            responsiveness_speedups[responsiveness_speedups.len() - 1],
            samples[0].snapshot_bytes,
            samples[0].incremental_bytes,
            POLL_COPY_ELISION_ITERATIONS,
            full_snapshot_time.as_micros(),
            incremental_poll_time.as_micros(),
        );
    }

    async fn benchmark_poll_copy_elision() -> (Duration, Duration, f64) {
        let transcript = CommandTranscript::default();
        transcript
            .apply(
                CommandOutputStream::Stdout,
                &[TerminalOperation::Append(
                    "x".repeat(POLL_COPY_ELISION_TRANSCRIPT_BYTES),
                )],
            )
            .await;
        let cursor = transcript.revision().await;

        let full_snapshot_started_at = Instant::now();
        for _ in 0..POLL_COPY_ELISION_ITERATIONS {
            let snapshot = transcript.snapshot().await;
            black_box(snapshot.live_output.stdout.len());
        }
        let full_snapshot_time = full_snapshot_started_at.elapsed();

        let incremental_poll_started_at = Instant::now();
        for _ in 0..POLL_COPY_ELISION_ITERATIONS {
            let snapshot = transcript.poll_snapshot_since(cursor, true).await;
            assert_eq!(snapshot.mode, CommandTranscriptOutputMode::Delta);
            black_box(snapshot.output.stdout.len());
        }
        let incremental_poll_time = incremental_poll_started_at.elapsed();
        let speedup = full_snapshot_time.as_secs_f64()
            / incremental_poll_time.as_secs_f64().max(f64::EPSILON);
        (full_snapshot_time, incremental_poll_time, speedup)
    }

    #[derive(Clone, Copy)]
    struct BackgroundCommandBenchmarkSample {
        yield_time: Duration,
        independent_time: Duration,
        total_time: Duration,
        responsiveness_speedup: f64,
        snapshot_bytes: usize,
        incremental_bytes: usize,
        payload_reduction: f64,
    }

    async fn run_background_command_benchmark_sample(
        sample_index: usize,
    ) -> BackgroundCommandBenchmarkSample {
        let manager = CommandSessionManager::default();
        let workspace = TempDir::new().expect("workspace should exist");
        let workspace = tokio::fs::canonicalize(workspace.path())
            .await
            .expect("workspace should canonicalize");
        let args = ExecCommandArgs {
            command: "[Console]::Out.Write((-join ('h' * 16384))); [Console]::Out.WriteLine('history-ready'); Start-Sleep -Seconds 2; [Console]::Out.WriteLine('benchmark-finished')".into(),
            cwd: ".".into(),
            reason: "benchmark background responsiveness".into(),
            parallel_safe: false,
            yield_time_ms: Some(250),
            timeout_seconds: Some(30),
        };
        let (_turn_cancellation, mut turn_receiver) = watch::channel(false);
        let started_at = Instant::now();
        let outcome = manager
            .start(
                Weak::<NativeEngineInner>::new(),
                None,
                workspace.clone(),
                args,
                Ripgrep::for_project_tests(),
                None,
                format!("item-a-{sample_index}"),
                "thread-a".into(),
                "turn-a".into(),
                1,
                Duration::from_millis(250),
                &mut turn_receiver,
            )
            .await
            .expect("benchmark command should start");
        let yielded_at = started_at.elapsed();
        let session = match outcome {
            CommandStartOutcome::Running(session) => session,
            CommandStartOutcome::Completed(_) => panic!("benchmark command should yield"),
        };
        let session_id = session.lease.session_id().to_owned();
        let tracked = manager
            .session(&session_id)
            .await
            .expect("benchmark session should remain registered");
        let initial_snapshot = tokio::time::timeout(Duration::from_secs(1), async {
            let mut snapshot = tracked.transcript.snapshot().await;
            while !snapshot.live_output.stdout.contains("history-ready") {
                snapshot = tracked
                    .transcript
                    .snapshot_after(snapshot.revision, Duration::from_secs(1))
                    .await;
            }
            snapshot
        })
        .await
        .expect("initial benchmark output should arrive");
        let snapshot_payload = manager
            .poll("thread-a", &session_id, None, Duration::ZERO)
            .await
            .expect("initial benchmark snapshot should poll");
        session.lease.commit();

        let independent_started_at = Instant::now();
        let independent_args = ExecCommandArgs {
            command: "[Console]::Out.WriteLine('independent-finished')".into(),
            cwd: ".".into(),
            reason: "benchmark independent work".into(),
            parallel_safe: true,
            yield_time_ms: Some(5_000),
            timeout_seconds: Some(30),
        };
        let independent = manager
            .start(
                Weak::<NativeEngineInner>::new(),
                None,
                workspace,
                independent_args,
                Ripgrep::for_project_tests(),
                None,
                format!("item-b-{sample_index}"),
                "thread-a".into(),
                "turn-a".into(),
                1,
                Duration::from_secs(5),
                &mut turn_receiver,
            )
            .await
            .expect("independent command should execute while the first command runs");
        assert!(matches!(independent, CommandStartOutcome::Completed(_)));
        let independent_elapsed = independent_started_at.elapsed();

        let incremental_payload = manager
            .poll(
                "thread-a",
                &session_id,
                Some(initial_snapshot.revision),
                Duration::from_secs(5),
            )
            .await
            .expect("completed benchmark command should poll");
        let total_elapsed = started_at.elapsed();
        let responsiveness_speedup =
            total_elapsed.as_secs_f64() / yielded_at.as_secs_f64().max(f64::EPSILON);
        let payload_reduction =
            snapshot_payload.len() as f64 / incremental_payload.len().max(1) as f64;

        assert!(incremental_payload.contains("benchmark-finished"));
        assert!(!incremental_payload.contains("history-ready"));
        manager.shutdown().await;
        BackgroundCommandBenchmarkSample {
            yield_time: yielded_at,
            independent_time: independent_elapsed,
            total_time: total_elapsed,
            responsiveness_speedup,
            snapshot_bytes: snapshot_payload.len(),
            incremental_bytes: incremental_payload.len(),
            payload_reduction,
        }
    }

    fn test_session(id: &str, thread_id: &str) -> Arc<CommandSession> {
        let (cancellation, _receiver) = watch::channel(false);
        Arc::new(CommandSession {
            id: id.into(),
            thread_id: thread_id.into(),
            turn_id: "turn-a".into(),
            item_id: "item-a".into(),
            command: "Get-Date".into(),
            cwd: ".".into(),
            started_at_ms: 1,
            started_at: Instant::now(),
            app: None,
            engine: Weak::<NativeEngineInner>::new(),
            transcript: CommandTranscript::default(),
            cancellation,
            result: Mutex::new(None),
            terminal: Mutex::new(None),
            interaction: Mutex::new(()),
            finished: AtomicBool::new(false),
            terminal_ready: AtomicBool::new(false),
            persisted: AtomicBool::new(true),
            discarded: AtomicBool::new(false),
            finalizer_started: AtomicBool::new(false),
            delivery: AtomicU8::new(DELIVERY_BACKGROUND),
            finished_notify: Notify::new(),
            persisted_notify: Notify::new(),
            terminal_notify: Notify::new(),
        })
    }
}
