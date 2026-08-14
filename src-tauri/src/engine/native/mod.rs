mod agent;
mod apply_patch;
mod approval;
pub(crate) mod auth;
mod chat;
mod compaction;
mod content_references;
mod context_window;
mod provider;
mod storage;
mod tools;

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter as _, Manager as _};
use tokio::sync::{Mutex, oneshot, watch};
use tokio::task::JoinSet;

use self::agent::{RunCompletion, TurnRun};
use self::approval::ApprovalBroker;
use self::auth::ChatGptAuth;
use self::chat::ChatGptConsumerProvider;
use self::provider::ChatGptCodexProvider;
use self::storage::NativeStorage;
use self::tools::ToolRegistry;
use crate::engine::{
    AccountRateLimitsResponse, ChatModelListResponse, CodexThread, ConfigReadResponse,
    ConfigUpdate, ConfigUpdateResponse, ConversationMode, DiagnosticStream, EngineCapability,
    EngineDescriptor, EngineNotification, EngineStartResponse, EngineStorage, EngineTransport,
    ItemNotification, ModelListResponse, NOTIFICATION_EVENT, OperationAck, OperationFailure,
    PermissionProfile, RUNTIME_DIAGNOSTIC_EVENT, RUNTIME_STATUS_EVENT, ReasoningEffort,
    RuntimeDiagnostic, RuntimeState, RuntimeStatus, ServerResponse, ThreadArchivedNotification,
    ThreadCompactStartResponse, ThreadDeletedNotification, ThreadForkResponse, ThreadListResponse,
    ThreadNotification, ThreadReadResponse, ThreadResumeResponse, ThreadStartResponse,
    ThreadUnarchiveResponse, ThreadUnarchivedNotification, TurnCompletedNotification, TurnInput,
    TurnNotification, TurnStartResponse, TurnStatus,
};
use crate::error::AppError;

const CONTRACT_SCHEMA_VERSION: u32 = 4;
const PROJECTLESS_WORKSPACE_DIRECTORY: &str = "projectless-workspace";
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);

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

struct ActiveTurn {
    turn_id: String,
    cancellation: watch::Sender<bool>,
    accepting_steers: bool,
    steer_pending: bool,
    pending_deletion: Option<oneshot::Sender<Result<OperationAck, AppError>>>,
    deletion_in_progress: bool,
}

impl ActiveTurn {
    fn can_accept_steer(&self) -> bool {
        !*self.cancellation.borrow() && self.accepting_steers
    }

    fn queue_steer(&mut self) {
        self.steer_pending = true;
    }

    fn should_continue_after_response(&mut self, has_pending_tools: bool) -> bool {
        if has_pending_tools {
            return true;
        }
        if self.steer_pending {
            self.steer_pending = false;
            return true;
        }
        self.accepting_steers = false;
        false
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
    approvals: ApprovalBroker,
    active_turns: Mutex<HashMap<String, ActiveTurn>>,
    thread_lifecycle_gate: Mutex<()>,
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
                chat: ChatGptConsumerProvider::default(),
                provider: ChatGptCodexProvider::default(),
                storage: NativeStorage::default(),
                tools: ToolRegistry,
                approvals: ApprovalBroker::default(),
                active_turns: Mutex::new(HashMap::new()),
                thread_lifecycle_gate: Mutex::new(()),
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
                self.inner.chat.initialize(app).await?;
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
        let thread = self
            .inner
            .storage
            .create_thread(cwd, project_path, mode)
            .await?;
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
        archived: bool,
    ) -> Result<ThreadListResponse, AppError> {
        self.ensure_started()?;
        self.inner.storage.list_threads(cursor, archived).await
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
        let thread = self
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
                thread: thread.clone(),
            }),
        )?;
        Ok(ThreadUnarchiveResponse { thread })
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
        let thread = self.inner.storage.fork_thread(thread_id).await?;
        self.inner.emit_notification(
            app,
            EngineNotification::ThreadCreated(ThreadNotification {
                thread: thread.clone(),
            }),
        )?;
        Ok(ThreadForkResponse { thread })
    }

    pub async fn thread_compact_start(
        &self,
        app: &AppHandle,
        thread_id: String,
    ) -> Result<ThreadCompactStartResponse, AppError> {
        self.ensure_started()?;
        self.reap_finished_tasks().await;
        let thread = self.inner.storage.read_thread(thread_id.clone()).await?;
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
        let (cancellation, receiver) = watch::channel(false);
        let ownership_collision = {
            let mut active_turns = self.inner.active_turns.lock().await;
            match active_turns.entry(thread_id.clone()) {
                Entry::Vacant(entry) => {
                    entry.insert(ActiveTurn {
                        turn_id: turn.id.clone(),
                        cancellation,
                        accepting_steers: false,
                        steer_pending: false,
                        pending_deletion: None,
                        deletion_in_progress: false,
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
                    thread_id.clone(),
                    turn.id.clone(),
                    TurnStatus::Failed,
                    Some(message.clone()),
                )
                .await?;
            return Err(AppError::State(message));
        }
        drop(lifecycle_guard);

        if let Err(error) = self.inner.emit_notification(
            app,
            EngineNotification::TurnStarted(TurnNotification {
                thread_id: thread_id.clone(),
                turn: turn.clone(),
            }),
        ) {
            return Err(self
                .inner
                .rollback_unspawned_turn(app, &thread_id, &turn.id, error)
                .await);
        }
        let active_thread = match self.inner.storage.read_thread(thread_id.clone()).await {
            Ok(thread) => thread,
            Err(error) => {
                return Err(self
                    .inner
                    .rollback_unspawned_turn(app, &thread_id, &turn.id, error)
                    .await);
            }
        };
        if let Err(error) = self.inner.emit_notification(
            app,
            EngineNotification::ThreadUpdated(ThreadNotification {
                thread: active_thread,
            }),
        ) {
            return Err(self
                .inner
                .rollback_unspawned_turn(app, &thread_id, &turn.id, error)
                .await);
        }

        let run = TurnRun {
            thread_id,
            turn_id: turn.id.clone(),
            workspace: thread.cwd.into(),
            mode: thread.mode,
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
            let result = agent::run_compaction(task_inner, app_handle.clone(), run).await;
            inner
                .finalize_turn(&app_handle, result, &background_turn_id)
                .await;
        });

        Ok(ThreadCompactStartResponse {})
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
        if thread.mode == ConversationMode::Chat {
            return self.start_chat_turn(app, request, thread).await;
        }
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
        let (cancellation, receiver) = watch::channel(false);
        let ownership_collision = {
            let mut active_turns = self.inner.active_turns.lock().await;
            match active_turns.entry(request.thread_id.clone()) {
                Entry::Vacant(entry) => {
                    entry.insert(ActiveTurn {
                        turn_id: turn.id.clone(),
                        cancellation,
                        accepting_steers: true,
                        steer_pending: false,
                        pending_deletion: None,
                        deletion_in_progress: false,
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
        drop(lifecycle_guard);

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
        let active_thread = match self
            .inner
            .storage
            .read_thread(request.thread_id.clone())
            .await
        {
            Ok(thread) => thread,
            Err(error) => {
                return Err(self
                    .inner
                    .rollback_unspawned_turn(app, &request.thread_id, &turn.id, error)
                    .await);
            }
        };
        if let Err(error) = self.inner.emit_notification(
            app,
            EngineNotification::ThreadUpdated(ThreadNotification {
                thread: active_thread,
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
            mode: thread.mode,
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

    async fn start_chat_turn(
        &self,
        app: &AppHandle,
        request: StartTurn,
        thread: CodexThread,
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
        let (cancellation, receiver) = watch::channel(false);
        let ownership_collision = {
            let mut active_turns = self.inner.active_turns.lock().await;
            match active_turns.entry(request.thread_id.clone()) {
                Entry::Vacant(entry) => {
                    entry.insert(ActiveTurn {
                        turn_id: turn.id.clone(),
                        cancellation,
                        accepting_steers: false,
                        steer_pending: false,
                        pending_deletion: None,
                        deletion_in_progress: false,
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
        drop(lifecycle_guard);

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
        let active_thread = match self
            .inner
            .storage
            .read_thread(request.thread_id.clone())
            .await
        {
            Ok(thread) => thread,
            Err(error) => {
                return Err(self
                    .inner
                    .rollback_unspawned_turn(app, &request.thread_id, &turn.id, error)
                    .await);
            }
        };
        if let Err(error) = self.inner.emit_notification(
            app,
            EngineNotification::ThreadUpdated(ThreadNotification {
                thread: active_thread,
            }),
        ) {
            return Err(self
                .inner
                .rollback_unspawned_turn(app, &request.thread_id, &turn.id, error)
                .await);
        }

        let run = chat::ChatTurnRun {
            thread_id: request.thread_id,
            turn_id: turn.id.clone(),
            user_message_id: request.client_user_message_id,
            prompt,
            model,
            timezone: request.timezone,
            timezone_offset_min: request.timezone_offset_min,
            cancellation: receiver,
        };
        debug_assert_eq!(thread.mode, ConversationMode::Chat);
        let inner = Arc::clone(&self.inner);
        let task_inner = Arc::clone(&self.inner);
        let app_handle = app.clone();
        let background_turn_id = turn.id.clone();
        self.inner.tasks.lock().await.spawn(async move {
            let result = chat::run_turn(task_inner, app_handle.clone(), run).await;
            inner
                .finalize_turn(&app_handle, result, &background_turn_id)
                .await;
        });
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
            .read_thread(request.thread_id.clone())
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
            self.inner
                .storage
                .append_turn_input(
                    request.thread_id.clone(),
                    request.expected_turn_id.clone(),
                    prepared.user_item,
                    prepared.provider_item,
                )
                .await?;
            active.queue_steer();
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
        match self.inner.storage.read_thread(request.thread_id).await {
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

    pub(super) async fn should_continue_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
        has_pending_tools: bool,
    ) -> Result<bool, AppError> {
        let mut active_turns = self.active_turns.lock().await;
        let active = active_turns
            .get_mut(thread_id)
            .ok_or_else(|| AppError::State("active-turn ownership was lost".into()))?;
        if active.turn_id != turn_id {
            return Err(AppError::State(
                "active-turn ownership changed during execution".into(),
            ));
        }
        Ok(active.should_continue_after_response(has_pending_tools))
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
            .complete_turn(
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

        let turn = completion?;
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

#[cfg(test)]
mod tests {
    use tokio::sync::watch;

    use super::ActiveTurn;
    use crate::engine::OperationAck;

    fn active_turn() -> ActiveTurn {
        let (cancellation, _receiver) = watch::channel(false);
        ActiveTurn {
            turn_id: "turn-1".into(),
            cancellation,
            accepting_steers: true,
            steer_pending: false,
            pending_deletion: None,
            deletion_in_progress: false,
        }
    }

    #[test]
    fn a_queued_steer_forces_exactly_one_follow_up_sampling_round() {
        let mut active = active_turn();
        active.queue_steer();

        assert!(active.should_continue_after_response(false));
        assert!(active.can_accept_steer());
        assert!(!active.should_continue_after_response(false));
        assert!(!active.can_accept_steer());
    }

    #[test]
    fn pending_tools_keep_the_steer_window_open() {
        let mut active = active_turn();

        assert!(active.should_continue_after_response(true));
        assert!(active.can_accept_steer());
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
