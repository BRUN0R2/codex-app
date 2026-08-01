mod agent;
mod approval;
pub(crate) mod auth;
mod provider;
mod storage;
mod tools;

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter as _};
use tokio::sync::{Mutex, watch};
use tokio::task::JoinSet;

use self::agent::{RunCompletion, TurnRun};
use self::approval::ApprovalBroker;
use self::auth::ChatGptAuth;
use self::provider::ChatGptCodexProvider;
use self::storage::NativeStorage;
use self::tools::ToolRegistry;
use crate::engine::{
    AccountRateLimitsResponse, ConfigReadResponse, ConfigUpdate, ConfigUpdateResponse,
    DiagnosticStream, EngineCapability, EngineDescriptor, EngineNotification, EngineStartResponse,
    EngineStorage, EngineTransport, ItemNotification, ModelListResponse, NOTIFICATION_EVENT,
    OperationAck, OperationFailure, PermissionProfile, RUNTIME_DIAGNOSTIC_EVENT,
    RUNTIME_STATUS_EVENT, ReasoningEffort, RuntimeDiagnostic, RuntimeState, RuntimeStatus,
    ServerResponse, ThreadArchivedNotification, ThreadListResponse, ThreadNotification,
    ThreadReadResponse, ThreadResumeResponse, ThreadStartResponse, TurnCompletedNotification,
    TurnInput, TurnNotification, TurnStartResponse, TurnStatus,
};
use crate::error::AppError;

const CONTRACT_SCHEMA_VERSION: u32 = 1;
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);

pub struct StartTurn {
    pub thread_id: String,
    pub client_user_message_id: String,
    pub input: Vec<TurnInput>,
    pub model: Option<String>,
    pub effort: Option<ReasoningEffort>,
}

struct ActiveTurn {
    turn_id: String,
    cancellation: watch::Sender<bool>,
}

pub(super) struct NativeEngineInner {
    auth: ChatGptAuth,
    provider: ChatGptCodexProvider,
    storage: NativeStorage,
    tools: ToolRegistry,
    approvals: ApprovalBroker,
    active_turns: Mutex<HashMap<String, ActiveTurn>>,
    tasks: Mutex<JoinSet<()>>,
    start_gate: Mutex<()>,
    started: AtomicBool,
}

pub struct NativeEngine {
    inner: Arc<NativeEngineInner>,
}

impl Default for NativeEngine {
    fn default() -> Self {
        Self {
            inner: Arc::new(NativeEngineInner {
                auth: ChatGptAuth::default(),
                provider: ChatGptCodexProvider::default(),
                storage: NativeStorage::default(),
                tools: ToolRegistry,
                approvals: ApprovalBroker::default(),
                active_turns: Mutex::new(HashMap::new()),
                tasks: Mutex::new(JoinSet::new()),
                start_gate: Mutex::new(()),
                started: AtomicBool::new(false),
            }),
        }
    }
}

impl NativeEngine {
    pub async fn start(&self, app: &AppHandle) -> Result<EngineStartResponse, AppError> {
        self.inner.emit_status(app, RuntimeState::Starting, None)?;
        let _start_guard = self.inner.start_gate.lock().await;
        if !self.inner.started.load(Ordering::Acquire) {
            let result = async {
                self.inner.storage.initialize(app).await?;
                self.inner.auth.initialize(app).await?;
                self.inner.provider.initialize().await?;
                Ok::<(), AppError>(())
            }
            .await;
            if let Err(error) = result {
                self.inner
                    .emit_status(app, RuntimeState::Failed, Some(error.to_string()))?;
                return Err(error);
            }
            self.inner.started.store(true, Ordering::Release);
        }
        let config = self.inner.storage.read_config().await?;
        self.inner.emit_status(app, RuntimeState::Ready, None)?;
        Ok(EngineStartResponse {
            engine: descriptor(),
            schema_version: CONTRACT_SCHEMA_VERSION,
            permission_profile: config.config.permission_profile,
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
        self.inner.provider.clear_session_state().await;
        Ok(response)
    }

    pub async fn thread_start(
        &self,
        app: &AppHandle,
        cwd: String,
    ) -> Result<ThreadStartResponse, AppError> {
        self.ensure_started()?;
        let thread = self.inner.storage.create_thread(cwd).await?;
        self.inner.emit_notification(
            app,
            EngineNotification::ThreadCreated(ThreadNotification {
                thread: thread.clone(),
            }),
        )?;
        Ok(ThreadStartResponse { thread })
    }

    pub async fn thread_list(
        &self,
        cursor: Option<String>,
    ) -> Result<ThreadListResponse, AppError> {
        self.ensure_started()?;
        self.inner.storage.list_threads(cursor).await
    }

    pub async fn thread_resume(&self, thread_id: String) -> Result<ThreadResumeResponse, AppError> {
        self.ensure_started()?;
        let thread = self.inner.storage.read_thread(thread_id).await?;
        Ok(ThreadResumeResponse {
            cwd: thread.cwd.clone(),
            thread,
        })
    }

    pub async fn thread_read(&self, thread_id: String) -> Result<ThreadReadResponse, AppError> {
        self.ensure_started()?;
        Ok(ThreadReadResponse {
            thread: self.inner.storage.read_thread(thread_id).await?,
        })
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
        let response = self.inner.storage.archive_thread(thread_id.clone()).await?;
        self.inner.emit_notification(
            app,
            EngineNotification::ThreadArchived(ThreadArchivedNotification { thread_id }),
        )?;
        Ok(response)
    }

    pub async fn turn_start(
        &self,
        app: &AppHandle,
        request: StartTurn,
    ) -> Result<TurnStartResponse, AppError> {
        self.ensure_started()?;
        self.reap_finished_tasks().await;
        let thread = self
            .inner
            .storage
            .read_thread(request.thread_id.clone())
            .await?;
        let config = self.inner.storage.read_config().await?.config;
        let requested_model = request.model.as_deref().or(config.model.as_deref());
        let model = self
            .inner
            .provider
            .select_model(app, &self.inner.auth, requested_model)
            .await?;
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
        let service_tier = model.select_service_tier(config.service_tier.as_deref())?;
        let prepared =
            agent::prepare_user_input(request.client_user_message_id, request.input).await?;
        let user_item = prepared.user_item.clone();
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
        let (cancellation, receiver) = watch::channel(false);
        let ownership_collision = {
            let mut active_turns = self.inner.active_turns.lock().await;
            match active_turns.entry(request.thread_id.clone()) {
                Entry::Vacant(entry) => {
                    entry.insert(ActiveTurn {
                        turn_id: turn.id.clone(),
                        cancellation,
                    });
                    false
                }
                Entry::Occupied(_) => true,
            }
        };
        if ownership_collision {
            let message = "active-turn ownership collision".to_string();
            self.inner
                .storage
                .complete_turn(
                    request.thread_id.clone(),
                    turn.id.clone(),
                    TurnStatus::Failed,
                    Some(message.clone()),
                )
                .await?;
            return Err(AppError::State(message));
        }

        if let Err(error) = self.inner.emit_notification(
            app,
            EngineNotification::TurnStarted(TurnNotification {
                thread_id: request.thread_id.clone(),
                turn: turn.clone(),
            }),
        ) {
            return Err(self
                .inner
                .rollback_unspawned_turn(app, &request.thread_id, &turn.id, error)
                .await);
        }
        if let Err(error) = self.inner.emit_notification(
            app,
            EngineNotification::ItemCompleted(ItemNotification {
                thread_id: request.thread_id.clone(),
                turn_id: turn.id.clone(),
                item: user_item,
            }),
        ) {
            return Err(self
                .inner
                .rollback_unspawned_turn(app, &request.thread_id, &turn.id, error)
                .await);
        }

        let run = TurnRun {
            thread_id: request.thread_id,
            turn_id: turn.id.clone(),
            workspace: thread.cwd.into(),
            model,
            config,
            reasoning_effort,
            service_tier,
            cancellation: receiver,
        };
        let inner = Arc::clone(&self.inner);
        let task_inner = Arc::clone(&self.inner);
        let app_handle = app.clone();
        let background_turn_id = turn.id.clone();
        self.inner.tasks.lock().await.spawn(async move {
            let result = agent::run_turn(task_inner, app_handle.clone(), run).await;
            inner
                .finalize_turn(&app_handle, result, &background_turn_id)
                .await;
        });

        Ok(TurnStartResponse { turn })
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

    pub async fn config_read(&self) -> Result<ConfigReadResponse, AppError> {
        self.ensure_started()?;
        self.inner.storage.read_config().await
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

    pub async fn server_request_respond(
        &self,
        request_id: String,
        response: ServerResponse,
    ) -> Result<OperationAck, AppError> {
        self.ensure_started()?;
        self.inner.approvals.respond(request_id, response).await
    }

    pub async fn stop(&self, app: &AppHandle) {
        let _lifecycle_guard = self.inner.start_gate.lock().await;
        if !self.inner.started.swap(false, Ordering::AcqRel) {
            return;
        }
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
        let drain = async {
            while let Some(result) = tasks.join_next().await {
                if let Err(error) = result {
                    eprintln!("native turn task failed during shutdown: {error}");
                }
            }
        };
        if tokio::time::timeout(SHUTDOWN_TIMEOUT, drain).await.is_err() {
            tasks.abort_all();
            while let Some(result) = tasks.join_next().await {
                if let Err(error) = result
                    && !error.is_cancelled()
                {
                    eprintln!("native turn task failed after forced shutdown: {error}");
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

    async fn reap_finished_tasks(&self) {
        let mut tasks = self.inner.tasks.lock().await;
        while let Some(result) = tasks.try_join_next() {
            if let Err(error) = result {
                eprintln!("native turn task failed: {error}");
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
        if let Err(error) = app.emit(
            RUNTIME_DIAGNOSTIC_EVENT,
            RuntimeDiagnostic { stream, message },
        ) {
            eprintln!("runtime diagnostic delivery failed: {error}");
        }
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
                let failure = OperationFailure {
                    code: error.public_code(),
                    message: error.to_string(),
                };
                (TurnStatus::Failed, Some(failure))
            }
        };
        let completion = self
            .storage
            .complete_turn(
                thread_id.clone(),
                turn_id.into(),
                status,
                failure.as_ref().map(|failure| failure.message.clone()),
            )
            .await;
        self.active_turns.lock().await.remove(&thread_id);
        let turn = match completion {
            Ok(turn) => turn,
            Err(error) => {
                self.emit_diagnostic(
                    app,
                    DiagnosticStream::Runtime,
                    format!("could not finalize turn `{turn_id}`: {error}"),
                );
                return;
            }
        };
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
        match self.storage.read_thread(thread_id).await {
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
    }

    async fn rollback_unspawned_turn(
        &self,
        app: &AppHandle,
        thread_id: &str,
        turn_id: &str,
        cause: AppError,
    ) -> AppError {
        let removed = {
            let mut active_turns = self.active_turns.lock().await;
            if active_turns
                .get(thread_id)
                .is_some_and(|active| active.turn_id == turn_id)
            {
                active_turns.remove(thread_id);
                true
            } else {
                false
            }
        };
        if !removed {
            self.emit_diagnostic(
                app,
                DiagnosticStream::Runtime,
                format!("rollback lost ownership of unspawned turn `{turn_id}`"),
            );
        }

        let cause_message = cause.to_string();
        let completion = self
            .storage
            .complete_turn(
                thread_id.into(),
                turn_id.into(),
                TurnStatus::Failed,
                Some(cause_message.clone()),
            )
            .await;
        let turn = match completion {
            Ok(turn) => turn,
            Err(rollback_error) => {
                return AppError::State(format!(
                    "{cause_message}; failed to roll back unspawned turn `{turn_id}`: {rollback_error}"
                ));
            }
        };
        let notification = EngineNotification::TurnCompleted(TurnCompletedNotification {
            thread_id: thread_id.into(),
            turn,
            error: Some(OperationFailure {
                code: cause.public_code(),
                message: cause_message,
            }),
        });
        if let Err(notification_error) = self.emit_notification(app, notification) {
            self.emit_diagnostic(
                app,
                DiagnosticStream::Runtime,
                notification_error.to_string(),
            );
        }
        cause
    }
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
        ],
    }
}
