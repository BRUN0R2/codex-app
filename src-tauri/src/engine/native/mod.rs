mod agent;
mod apply_patch;
mod approval;
pub(crate) mod auth;
mod automation;
mod chat;
mod compaction;
mod content_references;
mod context_window;
mod diagnostics;
mod output;
mod output_compaction;
mod provider;
mod provider_error;
mod storage;
mod stream_notifications;
mod terminal_output;
mod text;
mod tools;

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter as _, Manager as _};
use tokio::sync::{Mutex, Notify, oneshot, watch};
use tokio::task::{JoinHandle, JoinSet};
use uuid::Uuid;

use self::agent::{RunCompletion, TurnRun};
use self::approval::ApprovalBroker;
use self::auth::ChatGptAuth;
use self::automation::{
    AutomationDraft, AutomationUpdate, ClaimedAutomationRun, MAX_CONCURRENT_AUTOMATION_RUNS,
};
use self::chat::ChatGptConsumerProvider;
use self::diagnostics::RuntimeDiagnostics;
use self::provider::ChatGptCodexProvider;
use self::storage::NativeStorage;
use self::tools::{Ripgrep, ToolRegistry};
use crate::engine::{
    AccountRateLimitsResponse, Automation, AutomationDeletedNotification, AutomationListResponse,
    AutomationNotification, AutomationRun, AutomationRunNotification, ChatModelListResponse,
    ConfigUpdate, ConfigUpdateResponse, ConversationMode, DiagnosticStream, EngineCapability,
    EngineDescriptor, EngineNotification, EngineStartResponse, EngineStorage, EngineTransport,
    ItemNotification, ModelContextWindowPreference, ModelListResponse, NOTIFICATION_EVENT,
    OperationAck, OperationFailure, OutputReadResponse, PermissionProfile, RUNTIME_STATUS_EVENT,
    ReasoningEffort, RuntimeDiagnosticSubsystem, RuntimeState, RuntimeStatus, ServerResponse,
    ThreadArchivedNotification, ThreadCompactStartResponse, ThreadDeletedNotification,
    ThreadForkResponse, ThreadItem, ThreadListResponse, ThreadNotification, ThreadReadResponse,
    ThreadResumeResponse, ThreadStartResponse, ThreadSummary, ThreadUnarchiveResponse,
    ThreadUnarchivedNotification, TurnCompletedNotification, TurnInput, TurnNotification,
    TurnStartResponse, TurnStatus, TurnSummary,
};
use crate::error::AppError;

pub(super) const CONTRACT_SCHEMA_VERSION: u32 = 12;
const PROJECTLESS_WORKSPACE_DIRECTORY: &str = "projectless-workspace";
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);
const AUTOMATION_SCHEDULER_MAX_SLEEP: Duration = Duration::from_secs(15 * 60);
const AUTOMATION_SCHEDULER_RETRY_DELAY: Duration = Duration::from_secs(15);

pub struct StartTurn {
    pub thread_id: String,
    pub client_user_message_id: String,
    pub input: Vec<TurnInput>,
    pub model: Option<String>,
    pub effort: Option<ReasoningEffort>,
    pub service_tier: Option<String>,
    pub timezone: String,
    pub timezone_offset_min: i32,
}

pub struct SteerTurn {
    pub thread_id: String,
    pub expected_turn_id: String,
    pub client_user_message_id: String,
    pub input: Vec<TurnInput>,
}

pub struct CreateAutomation {
    pub name: String,
    pub prompt: String,
    pub project_path: Option<String>,
    pub enabled: bool,
    pub interval_minutes: u32,
    pub timezone: String,
    pub timezone_offset_min: i32,
}

pub struct UpdateAutomation {
    pub id: String,
    pub expected_version: u64,
    pub name: String,
    pub prompt: String,
    pub project_path: Option<String>,
    pub enabled: bool,
    pub interval_minutes: u32,
    pub timezone: String,
    pub timezone_offset_min: i32,
}

struct ActiveTurn {
    turn_id: String,
    cancellation: watch::Sender<bool>,
    accepting_steers: bool,
    latest_steer_sequence: Option<i64>,
    pending_deletion: Option<oneshot::Sender<Result<OperationAck, AppError>>>,
    deletion_in_progress: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TurnContinuation {
    Complete,
    Continue { pending_steer_sequence: Option<i64> },
}

struct AutomationSchedulerTask {
    shutdown: watch::Sender<bool>,
    handle: JoinHandle<()>,
}

impl ActiveTurn {
    fn can_accept_steer(&self) -> bool {
        !*self.cancellation.borrow() && self.accepting_steers
    }

    fn record_steer(&mut self, pending_sequence: i64) {
        debug_assert!(pending_sequence > 0);
        self.latest_steer_sequence = Some(
            self.latest_steer_sequence
                .map_or(pending_sequence, |current| current.max(pending_sequence)),
        );
    }

    fn continuation_after_response(
        &mut self,
        sampled_through_steer_sequence: i64,
        has_pending_tools: bool,
    ) -> TurnContinuation {
        let pending_steer_sequence = self
            .latest_steer_sequence
            .filter(|sequence| *sequence > sampled_through_steer_sequence);
        if has_pending_tools || pending_steer_sequence.is_some() {
            return TurnContinuation::Continue {
                pending_steer_sequence,
            };
        }
        self.accepting_steers = false;
        TurnContinuation::Complete
    }

    fn request_deletion(
        &mut self,
    ) -> Result<oneshot::Receiver<Result<OperationAck, AppError>>, AppError> {
        if self.pending_deletion.is_some() || self.deletion_in_progress {
            return Err(AppError::State(
                "thread deletion is already in progress".into(),
            ));
        }
        let (sender, receiver) = oneshot::channel();
        self.pending_deletion = Some(sender);
        self.accepting_steers = false;
        self.cancellation.send_replace(true);
        Ok(receiver)
    }

    fn begin_deletion(&mut self) -> Option<oneshot::Sender<Result<OperationAck, AppError>>> {
        let pending = self.pending_deletion.take();
        self.deletion_in_progress = pending.is_some();
        pending
    }
}

pub(super) struct NativeEngineInner {
    auth: ChatGptAuth,
    chat: ChatGptConsumerProvider,
    provider: ChatGptCodexProvider,
    storage: NativeStorage,
    tools: ToolRegistry,
    ripgrep: Ripgrep,
    approvals: ApprovalBroker,
    diagnostics: Arc<RuntimeDiagnostics>,
    active_turns: Mutex<HashMap<String, ActiveTurn>>,
    thread_lifecycle_gate: Mutex<()>,
    tasks: Mutex<JoinSet<()>>,
    automation_scheduler: Mutex<Option<AutomationSchedulerTask>>,
    automation_wake: Notify,
    start_gate: Mutex<()>,
    started: AtomicBool,
}

#[derive(Clone)]
pub struct NativeEngine {
    inner: Arc<NativeEngineInner>,
}

impl Default for NativeEngine {
    fn default() -> Self {
        Self::new(Arc::new(RuntimeDiagnostics::default()))
    }
}

impl NativeEngine {
    fn new(diagnostics: Arc<RuntimeDiagnostics>) -> Self {
        Self {
            inner: Arc::new(NativeEngineInner {
                auth: ChatGptAuth::new(Arc::clone(&diagnostics)),
                chat: ChatGptConsumerProvider::default(),
                provider: ChatGptCodexProvider::default(),
                storage: NativeStorage::default(),
                tools: ToolRegistry,
                ripgrep: Ripgrep::default(),
                approvals: ApprovalBroker::default(),
                diagnostics,
                active_turns: Mutex::new(HashMap::new()),
                thread_lifecycle_gate: Mutex::new(()),
                tasks: Mutex::new(JoinSet::new()),
                automation_scheduler: Mutex::new(None),
                automation_wake: Notify::new(),
                start_gate: Mutex::new(()),
                started: AtomicBool::new(false),
            }),
        }
    }

    pub fn has_active_turns(&self) -> bool {
        self.inner
            .active_turns
            .try_lock()
            .map_or(true, |active_turns| !active_turns.is_empty())
    }

    /// Runs a turn body on the shared task set and finalizes its ownership record.
    async fn spawn_turn_task<F>(&self, app: &AppHandle, turn_id: &str, task: F)
    where
        F: Future<Output = Result<RunCompletion, AppError>> + Send + 'static,
    {
        let inner = Arc::clone(&self.inner);
        let app_handle = app.clone();
        let background_turn_id = turn_id.to_string();
        self.inner.tasks.lock().await.spawn(async move {
            let result = task.await;
            inner
                .finalize_turn(&app_handle, result, &background_turn_id)
                .await;
        });
    }

    async fn ensure_automation_scheduler(&self, app: &AppHandle) {
        let mut scheduler = self.inner.automation_scheduler.lock().await;
        if scheduler.is_some() {
            return;
        }
        let (shutdown, receiver) = watch::channel(false);
        let engine = self.clone();
        let app_handle = app.clone();
        let handle = tokio::spawn(async move {
            engine.run_automation_scheduler(app_handle, receiver).await;
        });
        *scheduler = Some(AutomationSchedulerTask { shutdown, handle });
    }

    async fn stop_automation_scheduler(&self, app: &AppHandle) {
        let task = self.inner.automation_scheduler.lock().await.take();
        let Some(task) = task else {
            return;
        };
        task.shutdown.send_replace(true);
        self.inner.automation_wake.notify_waiters();
        let mut handle = task.handle;
        if tokio::time::timeout(Duration::from_secs(2), &mut handle)
            .await
            .is_err()
        {
            handle.abort();
            if let Err(error) = handle.await
                && !error.is_cancelled()
            {
                self.inner.emit_diagnostic(
                    app,
                    DiagnosticStream::Runtime,
                    format!("automation scheduler failed during shutdown: {error}"),
                );
            }
        }
    }

    async fn run_automation_scheduler(&self, app: AppHandle, mut shutdown: watch::Receiver<bool>) {
        loop {
            if *shutdown.borrow() {
                return;
            }
            self.run_due_automations(&app).await;
            let delay = self.automation_scheduler_delay(&app).await;
            tokio::select! {
                result = shutdown.changed() => {
                    if result.is_err() || *shutdown.borrow() {
                        return;
                    }
                }
                () = self.inner.automation_wake.notified() => {}
                () = tokio::time::sleep(delay) => {}
            }
        }
    }

    async fn automation_scheduler_delay(&self, app: &AppHandle) -> Duration {
        match self.inner.storage.next_automation_run_at().await {
            Ok(None) => AUTOMATION_SCHEDULER_MAX_SLEEP,
            Ok(Some(next_run_at)) => {
                let now = current_unix_timestamp().unwrap_or(next_run_at);
                if next_run_at <= now {
                    AUTOMATION_SCHEDULER_RETRY_DELAY
                } else {
                    Duration::from_secs(
                        u64::try_from(next_run_at - now)
                            .unwrap_or(AUTOMATION_SCHEDULER_MAX_SLEEP.as_secs())
                            .min(AUTOMATION_SCHEDULER_MAX_SLEEP.as_secs()),
                    )
                }
            }
            Err(error) => {
                self.inner.emit_diagnostic(
                    app,
                    DiagnosticStream::Runtime,
                    format!("could not read the next automation schedule: {error}"),
                );
                AUTOMATION_SCHEDULER_RETRY_DELAY
            }
        }
    }

    async fn run_due_automations(&self, app: &AppHandle) {
        for _ in 0..MAX_CONCURRENT_AUTOMATION_RUNS {
            let claim = match self.inner.storage.claim_due_automation().await {
                Ok(Some(claim)) => claim,
                Ok(None) => return,
                Err(error) => {
                    self.inner.emit_diagnostic(
                        app,
                        DiagnosticStream::Runtime,
                        format!("could not claim a due automation: {error}"),
                    );
                    return;
                }
            };
            self.emit_automation_claim(app, &claim);
            if let Err(error) = self.launch_automation_claim(app, claim).await {
                self.inner.emit_diagnostic(
                    app,
                    DiagnosticStream::Runtime,
                    format!("could not launch a claimed automation: {error}"),
                );
            }
        }
    }

    fn emit_automation_claim(&self, app: &AppHandle, claim: &ClaimedAutomationRun) {
        for notification in [
            EngineNotification::AutomationChanged(AutomationNotification {
                automation: claim.automation.clone(),
            }),
            EngineNotification::AutomationRunUpdated(AutomationRunNotification {
                run: claim.run.clone(),
            }),
        ] {
            if let Err(error) = self.inner.emit_notification(app, notification) {
                self.inner
                    .emit_diagnostic(app, DiagnosticStream::Runtime, error.to_string());
            }
        }
    }

    async fn launch_automation_claim(
        &self,
        app: &AppHandle,
        claim: ClaimedAutomationRun,
    ) -> Result<AutomationRun, AppError> {
        let run_id = claim.run.id.clone();
        let launch = async {
            if let Some(project_path) = claim.automation.project_path.as_deref() {
                let metadata = tokio::fs::metadata(project_path)
                    .await
                    .map_err(|error| AppError::FileSystem(error.to_string()))?;
                if !metadata.is_dir() {
                    return Err(AppError::FileSystem(
                        "automation project path is no longer a directory".into(),
                    ));
                }
            }
            let thread = self
                .thread_start(
                    app,
                    claim.automation.project_path.clone(),
                    ConversationMode::Codex,
                )
                .await?;
            let attached = self
                .inner
                .storage
                .attach_automation_run_thread(run_id.clone(), thread.thread.id.clone())
                .await?;
            self.inner.emit_notification(
                app,
                EngineNotification::AutomationRunUpdated(AutomationRunNotification {
                    run: attached,
                }),
            )?;
            let (_, run) = self
                .turn_start_bound(
                    app,
                    StartTurn {
                        thread_id: thread.thread.id.clone(),
                        client_user_message_id: Uuid::now_v7().to_string(),
                        input: vec![TurnInput::Text(claim.automation.prompt.clone())],
                        model: None,
                        effort: None,
                        service_tier: None,
                        timezone: claim.automation.timezone.clone(),
                        timezone_offset_min: claim.automation.timezone_offset_min,
                    },
                    Some(run_id.clone()),
                )
                .await?;
            run.ok_or_else(|| {
                AppError::State("automation turn started without a linked run".into())
            })
        }
        .await;

        match launch {
            Ok(run) => Ok(run),
            Err(error) => {
                let message = error.to_string();
                self.inner.emit_diagnostic(
                    app,
                    DiagnosticStream::Runtime,
                    format!("automation run `{run_id}` failed to start: {message}"),
                );
                if let Some(run) = self
                    .inner
                    .storage
                    .fail_automation_run(run_id.clone(), message)
                    .await?
                {
                    if let Err(notification_error) = self.inner.emit_notification(
                        app,
                        EngineNotification::AutomationRunUpdated(AutomationRunNotification {
                            run: run.clone(),
                        }),
                    ) {
                        self.inner.emit_diagnostic(
                            app,
                            DiagnosticStream::Runtime,
                            notification_error.to_string(),
                        );
                    }
                    self.inner.automation_wake.notify_one();
                    return Ok(run);
                }
                self.inner.storage.read_automation_run(run_id).await
            }
        }
    }

    pub async fn start(&self, app: &AppHandle) -> Result<EngineStartResponse, AppError> {
        let diagnostic_log_path = self.inner.diagnostics.initialize(app)?;
        self.inner.emit_status(app, RuntimeState::Starting, None)?;
        let _start_guard = self.inner.start_gate.lock().await;
        if !self.inner.started.load(Ordering::Acquire) {
            let result = async {
                tokio::try_join!(
                    self.inner.storage.initialize(app),
                    self.inner.auth.initialize(app),
                    self.inner.chat.initialize(app),
                    self.inner.provider.initialize(),
                    self.inner.ripgrep.initialize(),
                )?;
                Ok::<(), AppError>(())
            }
            .await;
            if let Err(error) = result {
                let message = error.to_string();
                self.inner.emit_diagnostic(
                    app,
                    DiagnosticStream::Runtime,
                    format!("engine startup failed: {message}"),
                );
                if let Err(status_error) =
                    self.inner
                        .emit_status(app, RuntimeState::Failed, Some(message))
                {
                    self.inner.emit_diagnostic(
                        app,
                        DiagnosticStream::Runtime,
                        status_error.to_string(),
                    );
                }
                return Err(error);
            }
            self.inner.started.store(true, Ordering::Release);
        }
        self.ensure_automation_scheduler(app).await;
        let config = self.inner.storage.read_config().await?;
        self.inner.emit_status(app, RuntimeState::Ready, None)?;
        Ok(EngineStartResponse {
            engine: descriptor(),
            schema_version: CONTRACT_SCHEMA_VERSION,
            diagnostic_log_path,
            config,
            permission_profiles: vec![
                PermissionProfile::read_only(),
                PermissionProfile::workspace_write(),
                PermissionProfile::full_access(),
            ],
        })
    }

    pub async fn account_read(
        &self,
        app: &AppHandle,
    ) -> Result<auth::AccountReadResponse, AppError> {
        self.ensure_started()?;
        self.inner.auth.read_account(app).await
    }

    pub async fn account_profile_read(
        &self,
        app: &AppHandle,
    ) -> Result<auth::AccountProfileResponse, AppError> {
        self.ensure_started()?;
        self.inner.auth.read_profile(app).await
    }

    pub async fn account_rate_limits_read(
        &self,
        app: &AppHandle,
    ) -> Result<AccountRateLimitsResponse, AppError> {
        self.ensure_started()?;
        self.inner
            .provider
            .read_rate_limits(app, &self.inner.auth)
            .await
    }

    pub async fn login_chatgpt(&self, app: &AppHandle) -> Result<auth::LoginResponse, AppError> {
        self.ensure_started()?;
        self.inner.auth.start_login(app).await
    }

    pub async fn login_cancel(&self, login_id: &str) -> auth::CancelLoginResponse {
        self.inner.auth.cancel_login(login_id).await
    }

    pub async fn logout(&self, app: &AppHandle) -> Result<auth::LogoutResponse, AppError> {
        self.ensure_started()?;
        if !self.inner.active_turns.lock().await.is_empty() {
            return Err(AppError::State(
                "interrupt active turns before signing out".into(),
            ));
        }
        let response = self.inner.auth.logout(app).await?;
        self.inner.chat.clear_session_state().await;
        self.inner.provider.clear_session_state().await;
        Ok(response)
    }

    pub async fn thread_start(
        &self,
        app: &AppHandle,
        project_path: Option<String>,
        mode: ConversationMode,
    ) -> Result<ThreadStartResponse, AppError> {
        self.ensure_started()?;
        let cwd = match project_path.as_ref() {
            Some(path) => path.clone(),
            None => {
                let directory = app
                    .path()
                    .app_data_dir()
                    .map_err(|error| AppError::Storage(error.to_string()))?
                    .join(PROJECTLESS_WORKSPACE_DIRECTORY);
                tokio::fs::create_dir_all(&directory)
                    .await
                    .map_err(|error| AppError::FileSystem(error.to_string()))?;
                directory.to_string_lossy().into_owned()
            }
        };
        let page = self
            .inner
            .storage
            .create_thread(cwd, project_path, mode)
            .await?;
        self.inner.emit_notification(
            app,
            EngineNotification::ThreadCreated(ThreadNotification {
                thread: page.thread.summary.clone(),
            }),
        )?;
        Ok(ThreadStartResponse {
            thread: page.thread,
            next_cursor: page.next_cursor,
        })
    }

    pub async fn thread_list(
        &self,
        cursor: Option<String>,
        archived: bool,
    ) -> Result<ThreadListResponse, AppError> {
        self.ensure_started()?;
        self.inner.storage.list_threads(cursor, archived).await
    }

    pub async fn thread_resume(&self, thread_id: String) -> Result<ThreadResumeResponse, AppError> {
        self.ensure_started()?;
        let page = self.inner.storage.read_thread_page(thread_id, None).await?;
        Ok(ThreadResumeResponse {
            cwd: page.thread.cwd.clone(),
            thread: page.thread,
            next_cursor: page.next_cursor,
        })
    }

    pub async fn thread_read(
        &self,
        thread_id: String,
        cursor: Option<String>,
    ) -> Result<ThreadReadResponse, AppError> {
        self.ensure_started()?;
        let page = self
            .inner
            .storage
            .read_thread_page(thread_id, cursor)
            .await?;
        Ok(ThreadReadResponse {
            thread: page.thread,
            next_cursor: page.next_cursor,
        })
    }

    pub async fn output_read(
        &self,
        output_id: String,
        cursor: Option<String>,
    ) -> Result<OutputReadResponse, AppError> {
        self.ensure_started()?;
        self.inner.storage.read_output(output_id, cursor).await
    }

    pub async fn thread_set_name(
        &self,
        app: &AppHandle,
        thread_id: String,
        name: String,
    ) -> Result<OperationAck, AppError> {
        self.ensure_started()?;
        let thread = self.inner.storage.set_thread_name(thread_id, name).await?;
        self.inner.emit_notification(
            app,
            EngineNotification::ThreadUpdated(ThreadNotification { thread }),
        )?;
        Ok(OperationAck { applied: true })
    }

    pub async fn thread_archive(
        &self,
        app: &AppHandle,
        thread_id: String,
    ) -> Result<OperationAck, AppError> {
        self.ensure_started()?;
        if self
            .inner
            .active_turns
            .lock()
            .await
            .contains_key(&thread_id)
        {
            return Err(AppError::State(
                "interrupt the active turn before archiving its thread".into(),
            ));
        }
        let response = self.inner.storage.archive_thread(thread_id.clone()).await?;
        self.inner.emit_notification(
            app,
            EngineNotification::ThreadArchived(ThreadArchivedNotification { thread_id }),
        )?;
        Ok(response)
    }

    pub async fn thread_unarchive(
        &self,
        app: &AppHandle,
        thread_id: String,
    ) -> Result<ThreadUnarchiveResponse, AppError> {
        self.ensure_started()?;
        let page = self
            .inner
            .storage
            .unarchive_thread(thread_id.clone())
            .await?;
        self.inner.emit_notification(
            app,
            EngineNotification::ThreadUnarchived(ThreadUnarchivedNotification { thread_id }),
        )?;
        self.inner.emit_notification(
            app,
            EngineNotification::ThreadUpdated(ThreadNotification {
                thread: page.thread.summary.clone(),
            }),
        )?;
        Ok(ThreadUnarchiveResponse {
            thread: page.thread,
            next_cursor: page.next_cursor,
        })
    }

    pub async fn thread_delete(
        &self,
        app: &AppHandle,
        thread_id: String,
    ) -> Result<OperationAck, AppError> {
        self.ensure_started()?;
        let active_deletion = {
            let lifecycle_guard = self.inner.thread_lifecycle_gate.lock().await;
            let mut active_turns = self.inner.active_turns.lock().await;
            let pending = active_turns
                .get_mut(&thread_id)
                .map(ActiveTurn::request_deletion)
                .transpose()?;
            drop(active_turns);
            let Some(pending) = pending else {
                let response = self.inner.storage.delete_thread(thread_id.clone()).await?;
                drop(lifecycle_guard);
                self.inner.emit_notification(
                    app,
                    EngineNotification::ThreadDeleted(ThreadDeletedNotification { thread_id }),
                )?;
                return Ok(response);
            };
            pending
        };
        active_deletion.await.map_err(|_| {
            AppError::State("active thread deletion lost its completion channel".into())
        })?
    }

    pub async fn thread_fork(
        &self,
        app: &AppHandle,
        thread_id: String,
    ) -> Result<ThreadForkResponse, AppError> {
        self.ensure_started()?;
        if self
            .inner
            .active_turns
            .lock()
            .await
            .contains_key(&thread_id)
        {
            return Err(AppError::State(
                "wait for the active turn to complete before forking its thread".into(),
            ));
        }
        let page = self.inner.storage.fork_thread(thread_id).await?;
        self.inner.emit_notification(
            app,
            EngineNotification::ThreadCreated(ThreadNotification {
                thread: page.thread.summary.clone(),
            }),
        )?;
        Ok(ThreadForkResponse {
            thread: page.thread,
            next_cursor: page.next_cursor,
        })
    }

    pub async fn thread_compact_start(
        &self,
        app: &AppHandle,
        thread_id: String,
    ) -> Result<ThreadCompactStartResponse, AppError> {
        self.ensure_started()?;
        self.reap_finished_tasks(app).await;
        let thread = self
            .inner
            .storage
            .read_thread_summary(thread_id.clone())
            .await?;
        if thread.mode == ConversationMode::Chat {
            return Err(AppError::Protocol(
                "ChatGPT consumer threads are compacted by ChatGPT and cannot be compacted by the Codex engine"
                    .into(),
            ));
        }
        let config = self.inner.storage.read_config().await?.config;
        let model = self
            .inner
            .provider
            .select_model(app, &self.inner.auth, config.model.as_deref())
            .await?;
        let context_preference = config
            .model_context_window_preferences
            .get(model.id())
            .copied()
            .unwrap_or(ModelContextWindowPreference::Default);
        let model = model.with_context_window_preference(context_preference)?;
        let reasoning_effort = config
            .model_reasoning_effort
            .or_else(|| model.default_reasoning_effort());
        if let Some(reasoning_effort) = reasoning_effort
            && !model.supports_reasoning_effort(reasoning_effort)
        {
            return Err(AppError::Protocol(format!(
                "reasoning effort `{}` is not supported by model `{}`",
                reasoning_effort.as_str(),
                model.id()
            )));
        }
        let service_tier = model.select_service_tier(None)?;
        let lifecycle_guard = self.inner.thread_lifecycle_gate.lock().await;
        let turn = self
            .inner
            .storage
            .begin_compaction_turn(
                thread_id.clone(),
                model.id().into(),
                reasoning_effort.map(|effort| effort.as_str().to_string()),
            )
            .await?;
        let cancellation = self
            .inner
            .claim_active_turn(&thread_id, &turn, false)
            .await?;
        drop(lifecycle_guard);

        self.inner
            .announce_turn_start(app, &thread_id, &turn, None)
            .await?;

        let run = TurnRun {
            thread_id,
            turn_id: turn.id.clone(),
            workspace: thread.cwd.into(),
            mode: thread.mode,
            model,
            config,
            reasoning_effort,
            service_tier,
            cancellation,
        };
        let task_inner = Arc::clone(&self.inner);
        let app_handle = app.clone();
        self.spawn_turn_task(app, &turn.id, async move {
            agent::run_compaction(task_inner, app_handle, run).await
        })
        .await;

        Ok(ThreadCompactStartResponse {})
    }

    pub async fn turn_start(
        &self,
        app: &AppHandle,
        request: StartTurn,
    ) -> Result<TurnStartResponse, AppError> {
        self.turn_start_bound(app, request, None)
            .await
            .map(|(response, _)| response)
    }

    async fn turn_start_bound(
        &self,
        app: &AppHandle,
        request: StartTurn,
        automation_run_id: Option<String>,
    ) -> Result<(TurnStartResponse, Option<AutomationRun>), AppError> {
        self.ensure_started()?;
        self.reap_finished_tasks(app).await;
        let thread = self
            .inner
            .storage
            .read_thread_summary(request.thread_id.clone())
            .await?;
        if thread.mode == ConversationMode::Chat {
            if automation_run_id.is_some() {
                return Err(AppError::State(
                    "automation runs cannot target ChatGPT consumer threads".into(),
                ));
            }
            return self
                .start_chat_turn(app, request, thread)
                .await
                .map(|response| (response, None));
        }
        let config = self.inner.storage.read_config().await?.config;
        let requested_model = request.model.as_deref().or(config.model.as_deref());
        let model = self
            .inner
            .provider
            .select_model(app, &self.inner.auth, requested_model)
            .await?;
        let context_preference = config
            .model_context_window_preferences
            .get(model.id())
            .copied()
            .unwrap_or(ModelContextWindowPreference::Default);
        let model = model.with_context_window_preference(context_preference)?;
        let reasoning_effort = request
            .effort
            .or(config.model_reasoning_effort)
            .or_else(|| model.default_reasoning_effort());
        if let Some(reasoning_effort) = reasoning_effort
            && !model.supports_reasoning_effort(reasoning_effort)
        {
            return Err(AppError::Protocol(format!(
                "reasoning effort `{}` is not supported by model `{}`",
                reasoning_effort.as_str(),
                model.id()
            )));
        }
        let service_tier = model.select_service_tier(request.service_tier.as_deref())?;
        let prepared =
            agent::prepare_user_input(request.client_user_message_id, request.input).await?;
        let user_item = prepared.user_item.clone();
        let lifecycle_guard = self.inner.thread_lifecycle_gate.lock().await;
        let turn = self
            .inner
            .storage
            .begin_turn(
                request.thread_id.clone(),
                model.id().into(),
                reasoning_effort.map(|effort| effort.as_str().to_string()),
                prepared.user_item,
                prepared.provider_item,
                prepared.preview,
            )
            .await?;
        let cancellation = self
            .inner
            .claim_active_turn(&request.thread_id, &turn, true)
            .await?;
        drop(lifecycle_guard);

        let automation_run = if let Some(run_id) = automation_run_id {
            match self
                .inner
                .storage
                .start_automation_run(run_id, request.thread_id.clone(), turn.id.clone())
                .await
            {
                Ok(run) => {
                    if let Err(error) = self.inner.emit_notification(
                        app,
                        EngineNotification::AutomationRunUpdated(AutomationRunNotification {
                            run: run.clone(),
                        }),
                    ) {
                        self.inner.emit_diagnostic(
                            app,
                            DiagnosticStream::Runtime,
                            error.to_string(),
                        );
                    }
                    Some(run)
                }
                Err(error) => {
                    return Err(self
                        .inner
                        .rollback_unspawned_turn(app, &request.thread_id, &turn.id, error)
                        .await);
                }
            }
        } else {
            None
        };

        self.inner
            .announce_turn_start(app, &request.thread_id, &turn, Some(user_item))
            .await?;

        let run = TurnRun {
            thread_id: request.thread_id,
            turn_id: turn.id.clone(),
            workspace: thread.cwd.into(),
            mode: thread.mode,
            model,
            config,
            reasoning_effort,
            service_tier,
            cancellation,
        };
        let task_inner = Arc::clone(&self.inner);
        let app_handle = app.clone();
        self.spawn_turn_task(app, &turn.id, async move {
            agent::run_turn(task_inner, app_handle, run).await
        })
        .await;

        Ok((TurnStartResponse { turn }, automation_run))
    }

    async fn start_chat_turn(
        &self,
        app: &AppHandle,
        request: StartTurn,
        thread: ThreadSummary,
    ) -> Result<TurnStartResponse, AppError> {
        if request.effort.is_some() || request.service_tier.is_some() {
            return Err(AppError::Protocol(
                "Chat turns use a consumer model option from the ChatGPT catalog and cannot use Codex reasoning effort or service tier settings"
                    .into(),
            ));
        }
        let model = self
            .inner
            .chat
            .select_model(app, &self.inner.auth, request.model.as_deref())
            .await?;
        let prepared =
            agent::prepare_user_input(request.client_user_message_id.clone(), request.input)
                .await?;
        let prompt = chat::prompt_from_prepared_turn(&prepared)?;
        let user_item = prepared.user_item.clone();
        let lifecycle_guard = self.inner.thread_lifecycle_gate.lock().await;
        let turn = self
            .inner
            .storage
            .begin_chat_turn(
                request.thread_id.clone(),
                model.model().to_string(),
                model
                    .thinking_effort()
                    .map(|effort| effort.as_str().to_string()),
                prepared.user_item,
                prepared.preview,
            )
            .await?;
        let cancellation = self
            .inner
            .claim_active_turn(&request.thread_id, &turn, false)
            .await?;
        drop(lifecycle_guard);

        self.inner
            .announce_turn_start(app, &request.thread_id, &turn, Some(user_item))
            .await?;

        let run = chat::ChatTurnRun {
            thread_id: request.thread_id,
            turn_id: turn.id.clone(),
            user_message_id: request.client_user_message_id,
            prompt,
            model,
            timezone: request.timezone,
            timezone_offset_min: request.timezone_offset_min,
            cancellation,
        };
        debug_assert_eq!(thread.mode, ConversationMode::Chat);
        let task_inner = Arc::clone(&self.inner);
        let app_handle = app.clone();
        self.spawn_turn_task(app, &turn.id, async move {
            chat::run_turn(task_inner, app_handle, run).await
        })
        .await;
        Ok(TurnStartResponse { turn })
    }

    pub async fn turn_steer(
        &self,
        app: &AppHandle,
        request: SteerTurn,
    ) -> Result<OperationAck, AppError> {
        self.ensure_started()?;
        let thread = self
            .inner
            .storage
            .read_thread_summary(request.thread_id.clone())
            .await?;
        if thread.mode == ConversationMode::Chat {
            return Err(AppError::Protocol(
                "an active ChatGPT consumer response cannot be steered; queue the follow-up for the next turn"
                    .into(),
            ));
        }
        let prepared =
            agent::prepare_user_input(request.client_user_message_id, request.input).await?;
        let user_item = prepared.user_item.clone();

        {
            let mut active_turns = self.inner.active_turns.lock().await;
            let active = active_turns
                .get_mut(&request.thread_id)
                .ok_or_else(|| AppError::State("thread has no active turn".into()))?;
            if active.turn_id != request.expected_turn_id {
                return Err(AppError::State(
                    "expected turn id does not match the active turn".into(),
                ));
            }
            if !active.can_accept_steer() {
                return Err(AppError::State(
                    "active turn is already completing and cannot accept more input".into(),
                ));
            }
            let pending_sequence = self
                .inner
                .storage
                .append_turn_input(
                    request.thread_id.clone(),
                    request.expected_turn_id.clone(),
                    prepared.user_item,
                    prepared.provider_item,
                )
                .await?;
            active.record_steer(pending_sequence);
        }

        if let Err(error) = self.inner.emit_notification(
            app,
            EngineNotification::ItemCompleted(ItemNotification {
                thread_id: request.thread_id.clone(),
                turn_id: request.expected_turn_id,
                item: user_item,
            }),
        ) {
            self.inner
                .emit_diagnostic(app, DiagnosticStream::Runtime, error.to_string());
        }
        match self
            .inner
            .storage
            .read_thread_summary(request.thread_id)
            .await
        {
            Ok(thread) => {
                if let Err(error) = self.inner.emit_notification(
                    app,
                    EngineNotification::ThreadUpdated(ThreadNotification { thread }),
                ) {
                    self.inner
                        .emit_diagnostic(app, DiagnosticStream::Runtime, error.to_string());
                }
            }
            Err(error) => self.inner.emit_diagnostic(
                app,
                DiagnosticStream::Runtime,
                format!("could not refresh steered thread: {error}"),
            ),
        }
        Ok(OperationAck { applied: true })
    }

    pub async fn turn_interrupt(
        &self,
        thread_id: String,
        turn_id: String,
    ) -> Result<OperationAck, AppError> {
        self.ensure_started()?;
        let active_turns = self.inner.active_turns.lock().await;
        let active = active_turns
            .get(&thread_id)
            .ok_or_else(|| AppError::State("thread has no active turn".into()))?;
        if active.turn_id != turn_id {
            return Err(AppError::State(
                "turn id does not match the active turn".into(),
            ));
        }
        active
            .cancellation
            .send(true)
            .map_err(|_| AppError::State("active turn is no longer listening".into()))?;
        Ok(OperationAck { applied: true })
    }

    pub async fn automation_list(&self) -> Result<AutomationListResponse, AppError> {
        self.ensure_started()?;
        self.inner.storage.list_automations().await
    }

    pub async fn automation_create(
        &self,
        app: &AppHandle,
        request: CreateAutomation,
    ) -> Result<Automation, AppError> {
        self.ensure_started()?;
        let automation = self
            .inner
            .storage
            .create_automation(AutomationDraft {
                name: request.name,
                prompt: request.prompt,
                project_path: request.project_path,
                enabled: request.enabled,
                interval_minutes: request.interval_minutes,
                timezone: request.timezone,
                timezone_offset_min: request.timezone_offset_min,
            })
            .await?;
        self.inner.emit_notification(
            app,
            EngineNotification::AutomationChanged(AutomationNotification {
                automation: automation.clone(),
            }),
        )?;
        self.inner.automation_wake.notify_one();
        Ok(automation)
    }

    pub async fn automation_update(
        &self,
        app: &AppHandle,
        request: UpdateAutomation,
    ) -> Result<Automation, AppError> {
        self.ensure_started()?;
        let automation = self
            .inner
            .storage
            .update_automation(AutomationUpdate {
                id: request.id,
                expected_version: request.expected_version,
                name: request.name,
                prompt: request.prompt,
                project_path: request.project_path,
                enabled: request.enabled,
                interval_minutes: request.interval_minutes,
                timezone: request.timezone,
                timezone_offset_min: request.timezone_offset_min,
            })
            .await?;
        self.inner.emit_notification(
            app,
            EngineNotification::AutomationChanged(AutomationNotification {
                automation: automation.clone(),
            }),
        )?;
        self.inner.automation_wake.notify_one();
        Ok(automation)
    }

    pub async fn automation_delete(
        &self,
        app: &AppHandle,
        automation_id: String,
    ) -> Result<OperationAck, AppError> {
        self.ensure_started()?;
        let response = self
            .inner
            .storage
            .delete_automation(automation_id.clone())
            .await?;
        self.inner.emit_notification(
            app,
            EngineNotification::AutomationDeleted(AutomationDeletedNotification { automation_id }),
        )?;
        self.inner.automation_wake.notify_one();
        Ok(response)
    }

    pub async fn automation_run_now(
        &self,
        app: &AppHandle,
        automation_id: String,
    ) -> Result<AutomationRun, AppError> {
        self.ensure_started()?;
        let claim = self
            .inner
            .storage
            .claim_automation_now(automation_id)
            .await?;
        self.emit_automation_claim(app, &claim);
        self.launch_automation_claim(app, claim).await
    }

    pub async fn automation_run_mark_reviewed(
        &self,
        app: &AppHandle,
        run_id: String,
    ) -> Result<OperationAck, AppError> {
        self.ensure_started()?;
        let response = self
            .inner
            .storage
            .mark_automation_run_reviewed(run_id.clone())
            .await?;
        let run = self.inner.storage.read_automation_run(run_id).await?;
        self.inner.emit_notification(
            app,
            EngineNotification::AutomationRunUpdated(AutomationRunNotification { run }),
        )?;
        Ok(response)
    }

    pub async fn config_update(
        &self,
        expected_version: u64,
        update: ConfigUpdate,
    ) -> Result<ConfigUpdateResponse, AppError> {
        self.ensure_started()?;
        self.inner
            .storage
            .update_config(expected_version, update)
            .await
    }

    pub async fn model_list(&self, app: &AppHandle) -> Result<ModelListResponse, AppError> {
        self.ensure_started()?;
        self.inner.provider.list_models(app, &self.inner.auth).await
    }

    pub async fn chat_model_list(
        &self,
        app: &AppHandle,
    ) -> Result<ChatModelListResponse, AppError> {
        self.ensure_started()?;
        self.inner.chat.list_models(app, &self.inner.auth).await
    }

    pub async fn server_request_respond(
        &self,
        request_id: String,
        response: ServerResponse,
    ) -> Result<OperationAck, AppError> {
        self.ensure_started()?;
        self.inner.approvals.respond(request_id, response).await
    }

    pub fn report_runtime_error(
        &self,
        app: &AppHandle,
        subsystem: RuntimeDiagnosticSubsystem,
        message: String,
    ) {
        self.inner.diagnostics.emit(app, subsystem, message);
    }

    pub fn persist_runtime_error(
        &self,
        subsystem: RuntimeDiagnosticSubsystem,
        message: &str,
    ) -> Result<(), AppError> {
        self.inner.diagnostics.record_error(subsystem, message)
    }

    pub async fn stop(&self, app: &AppHandle) {
        let _lifecycle_guard = self.inner.start_gate.lock().await;
        if !self.inner.started.swap(false, Ordering::AcqRel) {
            return;
        }
        self.stop_automation_scheduler(app).await;
        let cancellations = self
            .inner
            .active_turns
            .lock()
            .await
            .values()
            .map(|turn| turn.cancellation.clone())
            .collect::<Vec<_>>();
        for cancellation in cancellations {
            let _receiver_already_closed = cancellation.send(true);
        }
        self.inner.approvals.cancel_all().await;
        self.inner.auth.stop().await;

        let mut tasks = self.inner.tasks.lock().await;
        let diagnostics = Arc::clone(&self.inner.diagnostics);
        let app_handle = app.clone();
        let drain = async {
            while let Some(result) = tasks.join_next().await {
                if let Err(error) = result {
                    diagnostics.emit(
                        &app_handle,
                        RuntimeDiagnosticSubsystem::Runtime,
                        format!("native turn task failed during shutdown: {error}"),
                    );
                }
            }
        };
        if tokio::time::timeout(SHUTDOWN_TIMEOUT, drain).await.is_err() {
            tasks.abort_all();
            while let Some(result) = tasks.join_next().await {
                if let Err(error) = result
                    && !error.is_cancelled()
                {
                    self.inner.diagnostics.emit(
                        app,
                        RuntimeDiagnosticSubsystem::Runtime,
                        format!("native turn task failed after forced shutdown: {error}"),
                    );
                }
            }
        }
        if let Err(error) = self.inner.emit_status(app, RuntimeState::Stopped, None) {
            self.inner
                .emit_diagnostic(app, DiagnosticStream::Runtime, error.to_string());
        }
    }

    fn ensure_started(&self) -> Result<(), AppError> {
        if self.inner.started.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(AppError::State("native engine is not started".into()))
        }
    }

    async fn reap_finished_tasks(&self, app: &AppHandle) {
        let mut tasks = self.inner.tasks.lock().await;
        while let Some(result) = tasks.try_join_next() {
            if let Err(error) = result {
                self.inner.diagnostics.emit(
                    app,
                    RuntimeDiagnosticSubsystem::Runtime,
                    format!("native turn task failed: {error}"),
                );
            }
        }
    }
}

impl NativeEngineInner {
    fn emit_notification(
        &self,
        app: &AppHandle,
        notification: EngineNotification,
    ) -> Result<(), AppError> {
        app.emit(NOTIFICATION_EVENT, notification)
            .map_err(|error| AppError::State(format!("notification delivery failed: {error}")))
    }

    fn emit_status(
        &self,
        app: &AppHandle,
        state: RuntimeState,
        message: Option<String>,
    ) -> Result<(), AppError> {
        app.emit(RUNTIME_STATUS_EVENT, RuntimeStatus { state, message })
            .map_err(|error| AppError::State(format!("runtime status delivery failed: {error}")))
    }

    fn emit_diagnostic(&self, app: &AppHandle, stream: DiagnosticStream, message: String) {
        let subsystem = match stream {
            DiagnosticStream::Runtime => RuntimeDiagnosticSubsystem::Runtime,
        };
        self.diagnostics.emit(app, subsystem, message);
    }

    pub(super) async fn turn_continuation(
        &self,
        thread_id: &str,
        turn_id: &str,
        sampled_through_steer_sequence: i64,
        has_pending_tools: bool,
    ) -> Result<TurnContinuation, AppError> {
        let mut active_turns = self.active_turns.lock().await;
        let active = active_turns
            .get_mut(thread_id)
            .ok_or_else(|| AppError::State("active-turn ownership was lost".into()))?;
        if active.turn_id != turn_id {
            return Err(AppError::State(
                "active-turn ownership changed during execution".into(),
            ));
        }
        Ok(active.continuation_after_response(sampled_through_steer_sequence, has_pending_tools))
    }

    async fn finalize_turn(
        &self,
        app: &AppHandle,
        result: Result<RunCompletion, AppError>,
        turn_id: &str,
    ) {
        let thread_id = {
            let active_turns = self.active_turns.lock().await;
            active_turns.iter().find_map(|(thread_id, active)| {
                (active.turn_id == turn_id).then(|| thread_id.clone())
            })
        };
        let Some(thread_id) = thread_id else {
            self.emit_diagnostic(
                app,
                DiagnosticStream::Runtime,
                format!("completed turn `{turn_id}` lost its active ownership record"),
            );
            return;
        };
        let (status, failure) = match result {
            Ok(RunCompletion::Completed) => (TurnStatus::Completed, None),
            Ok(RunCompletion::Interrupted) => (TurnStatus::Interrupted, None),
            Err(error) => {
                let message = error.to_string();
                self.emit_diagnostic(
                    app,
                    DiagnosticStream::Runtime,
                    format!("turn `{turn_id}` failed: {message}"),
                );
                let failure = OperationFailure {
                    code: error.public_code(),
                    message,
                };
                (TurnStatus::Failed, Some(failure))
            }
        };
        if let Err(error) = self
            .settle_turn(app, thread_id, turn_id, status, failure)
            .await
        {
            self.emit_diagnostic(
                app,
                DiagnosticStream::Runtime,
                format!("could not finalize turn `{turn_id}`: {error}"),
            );
        }
    }

    async fn settle_turn(
        &self,
        app: &AppHandle,
        thread_id: String,
        turn_id: &str,
        status: TurnStatus,
        failure: Option<OperationFailure>,
    ) -> Result<(), AppError> {
        let lifecycle_guard = self.thread_lifecycle_gate.lock().await;
        let completion = self
            .storage
            .complete_turn_settlement(
                thread_id.clone(),
                turn_id.into(),
                status,
                failure.as_ref().map(|failure| failure.message.clone()),
            )
            .await;
        let pending_deletion = {
            let mut active_turns = self.active_turns.lock().await;
            let active = active_turns
                .get_mut(&thread_id)
                .ok_or_else(|| AppError::State("active-turn ownership was lost".into()))?;
            if active.turn_id != turn_id {
                return Err(AppError::State(
                    "active-turn ownership changed during finalization".into(),
                ));
            }
            let pending = active.begin_deletion();
            if pending.is_none() {
                active_turns.remove(&thread_id);
            }
            pending
        };

        if let Some(sender) = pending_deletion {
            let deletion = if completion.is_ok() {
                self.storage.delete_thread(thread_id.clone()).await
            } else {
                self.storage
                    .delete_owned_active_thread(thread_id.clone(), turn_id.into())
                    .await
            };
            self.active_turns.lock().await.remove(&thread_id);
            drop(lifecycle_guard);
            match deletion {
                Ok(response) => {
                    if let Ok(settlement) = &completion
                        && let Some(run) = settlement.automation_run.clone()
                    {
                        if let Err(error) = self.emit_notification(
                            app,
                            EngineNotification::AutomationRunUpdated(AutomationRunNotification {
                                run,
                            }),
                        ) {
                            self.emit_diagnostic(app, DiagnosticStream::Runtime, error.to_string());
                        }
                        self.automation_wake.notify_one();
                    }
                    let result = self
                        .emit_notification(
                            app,
                            EngineNotification::ThreadDeleted(ThreadDeletedNotification {
                                thread_id,
                            }),
                        )
                        .map(|()| response);
                    if let Err(error) = &result {
                        self.emit_diagnostic(app, DiagnosticStream::Runtime, error.to_string());
                    }
                    let _receiver_was_closed = sender.send(result);
                    return Ok(());
                }
                Err(error) => {
                    let _receiver_was_closed = sender.send(Err(error));
                }
            }
        } else {
            drop(lifecycle_guard);
        }

        let settlement = completion?;
        if let Some(run) = settlement.automation_run {
            if let Err(error) = self.emit_notification(
                app,
                EngineNotification::AutomationRunUpdated(AutomationRunNotification { run }),
            ) {
                self.emit_diagnostic(app, DiagnosticStream::Runtime, error.to_string());
            }
            self.automation_wake.notify_one();
        }
        let turn = settlement.turn;
        if let Err(error) = self.emit_notification(
            app,
            EngineNotification::TurnCompleted(TurnCompletedNotification {
                thread_id: thread_id.clone(),
                turn,
                error: failure,
            }),
        ) {
            self.emit_diagnostic(app, DiagnosticStream::Runtime, error.to_string());
        }
        match self.storage.read_thread_summary(thread_id).await {
            Ok(thread) => {
                if let Err(error) = self.emit_notification(
                    app,
                    EngineNotification::ThreadUpdated(ThreadNotification { thread }),
                ) {
                    self.emit_diagnostic(app, DiagnosticStream::Runtime, error.to_string());
                }
            }
            Err(error) => self.emit_diagnostic(
                app,
                DiagnosticStream::Runtime,
                format!("could not refresh completed thread: {error}"),
            ),
        }
        Ok(())
    }

    /// Registers exclusive ownership of a freshly persisted turn. The caller must hold the
    /// thread lifecycle gate across the storage write and this call, and drop it afterwards.
    async fn claim_active_turn(
        &self,
        thread_id: &str,
        turn: &TurnSummary,
        accepting_steers: bool,
    ) -> Result<watch::Receiver<bool>, AppError> {
        let (cancellation, receiver) = watch::channel(false);
        let collision = {
            let mut active_turns = self.active_turns.lock().await;
            match active_turns.entry(thread_id.to_string()) {
                Entry::Vacant(entry) => {
                    entry.insert(ActiveTurn {
                        turn_id: turn.id.clone(),
                        cancellation,
                        accepting_steers,
                        latest_steer_sequence: None,
                        pending_deletion: None,
                        deletion_in_progress: false,
                    });
                    None
                }
                Entry::Occupied(_) => Some("active-turn ownership collision".to_string()),
            }
        };
        match collision {
            None => Ok(receiver),
            Some(message) => {
                self.storage
                    .complete_turn(
                        thread_id.to_string(),
                        turn.id.clone(),
                        TurnStatus::Failed,
                        Some(message.clone()),
                    )
                    .await?;
                Err(AppError::State(message))
            }
        }
    }

    /// Emits the turn-start announcement sequence and rolls the turn back on any failure.
    async fn announce_turn_start(
        &self,
        app: &AppHandle,
        thread_id: &str,
        turn: &TurnSummary,
        user_item: Option<ThreadItem>,
    ) -> Result<(), AppError> {
        let started = self.emit_notification(
            app,
            EngineNotification::TurnStarted(TurnNotification {
                thread_id: thread_id.to_string(),
                turn: turn.clone(),
            }),
        );
        if let Err(error) = started {
            return Err(self
                .rollback_unspawned_turn(app, thread_id, &turn.id, error)
                .await);
        }
        if let Some(item) = user_item {
            let completed = self.emit_notification(
                app,
                EngineNotification::ItemCompleted(ItemNotification {
                    thread_id: thread_id.to_string(),
                    turn_id: turn.id.clone(),
                    item,
                }),
            );
            if let Err(error) = completed {
                return Err(self
                    .rollback_unspawned_turn(app, thread_id, &turn.id, error)
                    .await);
            }
        }
        let active_thread = match self
            .storage
            .read_thread_summary(thread_id.to_string())
            .await
        {
            Ok(thread) => thread,
            Err(error) => {
                return Err(self
                    .rollback_unspawned_turn(app, thread_id, &turn.id, error)
                    .await);
            }
        };
        let updated = self.emit_notification(
            app,
            EngineNotification::ThreadUpdated(ThreadNotification {
                thread: active_thread,
            }),
        );
        if let Err(error) = updated {
            return Err(self
                .rollback_unspawned_turn(app, thread_id, &turn.id, error)
                .await);
        }
        Ok(())
    }

    async fn rollback_unspawned_turn(
        &self,
        app: &AppHandle,
        thread_id: &str,
        turn_id: &str,
        cause: AppError,
    ) -> AppError {
        let cause_message = cause.to_string();
        let rollback = self
            .settle_turn(
                app,
                thread_id.into(),
                turn_id,
                TurnStatus::Failed,
                Some(OperationFailure {
                    code: cause.public_code(),
                    message: cause_message.clone(),
                }),
            )
            .await;
        if let Err(rollback_error) = rollback {
            return AppError::State(format!(
                "{cause_message}; failed to roll back unspawned turn `{turn_id}`: {rollback_error}"
            ));
        }
        cause
    }
}

fn current_unix_timestamp() -> Result<i64, AppError> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| AppError::State(error.to_string()))?
        .as_secs();
    i64::try_from(seconds).map_err(|error| AppError::State(error.to_string()))
}

fn descriptor() -> EngineDescriptor {
    EngineDescriptor {
        id: "native-engine",
        name: "Native Engine",
        provider: "ChatGPT Codex",
        auth: "ChatGPT OAuth",
        transport: EngineTransport::HttpsSse,
        storage: EngineStorage::Sqlite,
        capabilities: vec![
            EngineCapability::ChatGptOauth,
            EngineCapability::LocalThreads,
            EngineCapability::ModelStreaming,
            EngineCapability::NativeTools,
            EngineCapability::ExplicitApprovals,
            EngineCapability::ScheduledAutomations,
        ],
    }
}

#[cfg(test)]
mod tests {
    use tokio::sync::watch;

    use super::{ActiveTurn, NativeEngine, TurnContinuation};
    use crate::engine::OperationAck;

    fn active_turn() -> ActiveTurn {
        let (cancellation, _receiver) = watch::channel(false);
        ActiveTurn {
            turn_id: "turn-1".into(),
            cancellation,
            accepting_steers: true,
            latest_steer_sequence: None,
            pending_deletion: None,
            deletion_in_progress: false,
        }
    }

    #[test]
    fn a_fresh_engine_does_not_block_normal_window_close() {
        assert!(!NativeEngine::default().has_active_turns());
    }

    #[test]
    fn a_steer_after_the_sampling_snapshot_forces_one_follow_up_round() {
        let mut active = active_turn();
        active.record_steer(12);

        assert_eq!(
            active.continuation_after_response(11, false),
            TurnContinuation::Continue {
                pending_steer_sequence: Some(12),
            }
        );
        assert!(active.can_accept_steer());
        assert_eq!(
            active.continuation_after_response(12, false),
            TurnContinuation::Complete
        );
        assert!(!active.can_accept_steer());
    }

    #[test]
    fn a_steer_already_in_the_sampling_snapshot_does_not_add_an_empty_round() {
        let mut active = active_turn();
        active.record_steer(12);

        assert_eq!(
            active.continuation_after_response(12, false),
            TurnContinuation::Complete
        );
        assert!(!active.can_accept_steer());
    }

    #[test]
    fn the_latest_of_multiple_steers_controls_the_follow_up_watermark() {
        let mut active = active_turn();
        active.record_steer(12);
        active.record_steer(14);

        assert_eq!(
            active.continuation_after_response(13, false),
            TurnContinuation::Continue {
                pending_steer_sequence: Some(14),
            }
        );
        assert!(active.can_accept_steer());
        assert_eq!(
            active.continuation_after_response(14, false),
            TurnContinuation::Complete
        );
        assert!(!active.can_accept_steer());
    }

    #[test]
    fn tool_continuation_does_not_leave_an_included_steer_pending() {
        let mut active = active_turn();
        active.record_steer(12);

        assert_eq!(
            active.continuation_after_response(11, true),
            TurnContinuation::Continue {
                pending_steer_sequence: Some(12),
            }
        );
        assert!(active.can_accept_steer());
        assert_eq!(
            active.continuation_after_response(12, false),
            TurnContinuation::Complete
        );
        assert!(!active.can_accept_steer());
    }

    #[test]
    fn cancellation_closes_the_steer_window() {
        let active = active_turn();
        active.cancellation.send_replace(true);

        assert!(!active.can_accept_steer());
    }

    #[tokio::test]
    async fn deletion_cancels_the_turn_and_has_one_completion_owner() {
        let mut active = active_turn();
        let completion = active
            .request_deletion()
            .expect("the first deletion request should register");

        assert!(*active.cancellation.borrow());
        assert!(!active.can_accept_steer());
        assert!(active.request_deletion().is_err());

        let sender = active
            .begin_deletion()
            .expect("finalization should own the pending request");
        assert!(active.request_deletion().is_err());
        sender
            .send(Ok(OperationAck { applied: true }))
            .expect("the command should still be waiting");

        assert!(
            completion
                .await
                .expect("the completion channel should remain open")
                .expect("deletion should succeed")
                .applied
        );
    }
}
