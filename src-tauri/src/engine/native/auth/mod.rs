mod callback;
mod error;
mod oauth;
mod pkce;
mod storage;
mod token;

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use chrono::Utc;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use tauri::AppHandle;
use tauri::Emitter as _;
use tokio::sync::Mutex;
use tokio::sync::Notify;
use tokio::sync::OnceCell;
use uuid::Uuid;

use self::callback::CallbackServer;
use self::error::AuthError;
use self::oauth::OAuthClient;
use self::pkce::PkceCodes;
use self::pkce::generate_pkce;
use self::pkce::generate_state;
use self::storage::CredentialStorage;
use self::token::AuthRecord;
use self::token::StoredAuthMode;
use super::super::EngineNotification;
use super::super::EngineOperation;
use super::super::NOTIFICATION_EVENT;
use super::super::RUNTIME_DIAGNOSTIC_EVENT;
use super::super::RuntimeDiagnostic;
use crate::error::AppError;

struct AuthContext {
    storage: CredentialStorage,
    oauth: OAuthClient,
    operation_gate: Mutex<()>,
}

struct PendingLogin {
    login_id: String,
    cancellation: Arc<LoginCancellation>,
}

struct LoginCancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

impl LoginCancellation {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        let notified = self.notify.notified();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }
}

struct AuthInner {
    context: OnceCell<AuthContext>,
    pending_login: Mutex<Option<PendingLogin>>,
}

pub struct ChatGptAuth {
    inner: Arc<AuthInner>,
}

impl Default for ChatGptAuth {
    fn default() -> Self {
        Self {
            inner: Arc::new(AuthInner {
                context: OnceCell::new(),
                pending_login: Mutex::new(None),
            }),
        }
    }
}

impl ChatGptAuth {
    pub async fn initialize(&self, app: &AppHandle) -> Result<(), AppError> {
        self.inner
            .context(app)
            .await
            .map(|_| ())
            .map_err(Into::into)
    }

    pub async fn execute(
        &self,
        app: &AppHandle,
        operation: EngineOperation,
    ) -> Result<Value, AppError> {
        let value = match operation {
            EngineOperation::AccountRead => {
                serde_json::to_value(self.inner.read_account(app).await?)
            }
            EngineOperation::LoginChatGpt => {
                serde_json::to_value(self.inner.start_login(app).await?)
            }
            EngineOperation::CancelLogin { login_id } => {
                serde_json::to_value(self.inner.cancel_login(&login_id).await)
            }
            EngineOperation::Logout => serde_json::to_value(self.inner.logout(app).await?),
            _ => {
                return Err(AppError::Engine(
                    "the ChatGPT auth module received a non-auth operation".into(),
                ));
            }
        };
        value.map_err(|error| AppError::Auth(format!("could not encode auth response: {error}")))
    }

    pub async fn stop(&self) {
        self.inner.cancel_pending_login().await;
    }
}

impl AuthInner {
    async fn context(&self, app: &AppHandle) -> Result<&AuthContext, AuthError> {
        self.context
            .get_or_try_init(|| async {
                Ok(AuthContext {
                    storage: CredentialStorage::new(app)?,
                    oauth: OAuthClient::new()?,
                    operation_gate: Mutex::new(()),
                })
            })
            .await
    }

    async fn read_account(&self, app: &AppHandle) -> Result<AccountReadResponse, AuthError> {
        let context = self.context(app).await?;
        let _operation_guard = context.operation_gate.lock().await;
        let Some(record) = context.storage.load().await? else {
            return Ok(AccountReadResponse::signed_out());
        };

        let outcome =
            if record.mode() == StoredAuthMode::ChatGpt && record.should_refresh(Utc::now()) {
                self.refresh_record(app, context, record).await?
            } else {
                RefreshOutcome {
                    record: Some(record),
                    refresh: RefreshResult::not_required(),
                }
            };
        let account = outcome
            .record
            .as_ref()
            .map(account_from_record)
            .transpose()?;
        Ok(AccountReadResponse {
            account,
            requires_openai_auth: true,
            refresh: outcome.refresh,
        })
    }

    async fn refresh_record(
        &self,
        app: &AppHandle,
        context: &AuthContext,
        mut record: AuthRecord,
    ) -> Result<RefreshOutcome, AuthError> {
        let refresh_token = match record.tokens() {
            Ok(tokens) => &tokens.refresh_token,
            Err(error) => return Err(error),
        };
        let patch = match context.oauth.refresh(refresh_token).await {
            Ok(patch) => patch,
            Err(error) => {
                return Ok(RefreshOutcome {
                    record: Some(record),
                    refresh: RefreshResult::failed(error.to_string()),
                });
            }
        };

        let current = match context.storage.load().await {
            Ok(current) => current,
            Err(error) => {
                report_cleanup_error(app, context.oauth.revoke_patch(&patch).await);
                return Err(error);
            }
        };
        match current {
            Some(current) if record.same_refresh_source(&current) => {
                record.apply_refresh(patch)?;
                if let Err(save_error) = context.storage.save(&record).await {
                    let mut failures = vec![save_error.to_string()];
                    if let Ok(tokens) = record.tokens()
                        && let Err(error) = context.oauth.revoke_tokens(tokens).await
                    {
                        failures.push(format!("refreshed token cleanup failed: {error}"));
                    }
                    if let Err(error) = context.storage.delete().await {
                        failures.push(format!("stale credential cleanup failed: {error}"));
                    }
                    return Err(AuthError::CredentialStorage(failures.join("; ")));
                }
                Ok(RefreshOutcome {
                    record: Some(record),
                    refresh: RefreshResult::succeeded(),
                })
            }
            Some(current) => {
                report_cleanup_error(app, context.oauth.revoke_patch(&patch).await);
                Ok(RefreshOutcome {
                    record: Some(current),
                    refresh: RefreshResult::superseded(),
                })
            }
            None => {
                report_cleanup_error(app, context.oauth.revoke_patch(&patch).await);
                Ok(RefreshOutcome {
                    record: None,
                    refresh: RefreshResult::superseded(),
                })
            }
        }
    }

    async fn start_login(self: &Arc<Self>, app: &AppHandle) -> Result<LoginResponse, AuthError> {
        let context = self.context(app).await?;
        let mut pending = self.pending_login.lock().await;
        if pending.is_some() {
            return Err(AuthError::LoginInProgress);
        }
        let _operation_guard = context.operation_gate.lock().await;
        if context.storage.load().await?.is_some() {
            return Err(AuthError::AlreadyAuthenticated);
        }

        let callback = CallbackServer::bind().await?;
        let pkce = generate_pkce();
        let state = generate_state();
        let login_id = Uuid::now_v7().to_string();
        let auth_url = context
            .oauth
            .authorize_url(callback.redirect_uri(), &pkce, &state)?;
        let flow = LoginFlow {
            callback,
            pkce,
            state,
        };
        let cancellation = Arc::new(LoginCancellation::new());
        *pending = Some(PendingLogin {
            login_id: login_id.clone(),
            cancellation: Arc::clone(&cancellation),
        });
        drop(pending);

        let inner = Arc::clone(self);
        let app_handle = app.clone();
        let background_login_id = login_id.clone();
        tokio::spawn(async move {
            let result = inner.complete_login(&app_handle, flow, cancellation).await;
            inner
                .finish_login(&app_handle, &background_login_id, result)
                .await;
        });

        Ok(LoginResponse {
            account_type: "chatgpt",
            login_id,
            auth_url,
        })
    }

    async fn complete_login(
        &self,
        app: &AppHandle,
        flow: LoginFlow,
        cancellation: Arc<LoginCancellation>,
    ) -> Result<(), AuthError> {
        let context = self.context(app).await?;
        let redirect_uri = flow.callback.redirect_uri().to_owned();
        let callback = tokio::select! {
            result = flow.callback.wait_for_authorization(&flow.state) => result?,
            () = cancellation.cancelled() => return Err(AuthError::LoginCancelled),
        };
        let _operation_guard = context.operation_gate.lock().await;
        if cancellation.is_cancelled() {
            report_browser_response_error(app, callback.respond_failure().await);
            return Err(AuthError::LoginCancelled);
        }
        let exchange = context
            .oauth
            .exchange(&callback.code, &redirect_uri, &flow.pkce)
            .await;
        let record = match exchange.and_then(AuthRecord::from_exchange) {
            Ok(record) => record,
            Err(error) => {
                report_browser_response_error(app, callback.respond_failure().await);
                return Err(error);
            }
        };

        if cancellation.is_cancelled() {
            report_cleanup_error(app, context.oauth.revoke_tokens(record.tokens()?).await);
            report_browser_response_error(app, callback.respond_failure().await);
            return Err(AuthError::LoginCancelled);
        }
        if let Err(error) = context.storage.save(&record).await {
            let cleanup = match record.tokens() {
                Ok(tokens) => context.oauth.revoke_tokens(tokens).await,
                Err(error) => Err(error),
            };
            report_cleanup_error(app, cleanup);
            report_browser_response_error(app, callback.respond_failure().await);
            return Err(error);
        }
        if cancellation.is_cancelled() {
            report_cleanup_error(app, context.oauth.revoke_tokens(record.tokens()?).await);
            context.storage.delete().await?;
            report_browser_response_error(app, callback.respond_failure().await);
            return Err(AuthError::LoginCancelled);
        }
        if let Err(error) = callback.respond_success().await {
            emit_diagnostic(
                app,
                format!("login completed, but the browser response failed: {error}"),
            );
        }
        Ok(())
    }

    async fn finish_login(&self, app: &AppHandle, login_id: &str, result: Result<(), AuthError>) {
        let mut pending = self.pending_login.lock().await;
        if pending
            .as_ref()
            .is_some_and(|current| current.login_id == login_id)
        {
            *pending = None;
        }
        drop(pending);

        let (success, error) = match result {
            Ok(()) => (true, None),
            Err(error) => (false, Some(error.to_string())),
        };
        emit_notification(
            app,
            "account/login/completed",
            json!({
                "loginId": login_id,
                "success": success,
                "error": error,
            }),
        );
        if success {
            emit_notification(app, "account/updated", json!({ "authMode": "chatgpt" }));
        }
    }

    async fn logout(&self, app: &AppHandle) -> Result<LogoutResponse, AuthError> {
        self.cancel_pending_login().await;
        let context = self.context(app).await?;
        let _operation_guard = context.operation_gate.lock().await;
        let record = context.storage.load().await?;

        let (remote_revocation, remote_revocation_error) = match record.as_ref() {
            Some(record) if record.mode() == StoredAuthMode::ChatGpt => match record.tokens() {
                Ok(tokens) => match context.oauth.revoke_tokens(tokens).await {
                    Ok(()) => (RemoteRevocation::Succeeded, None),
                    Err(error) => (RemoteRevocation::Failed, Some(error.to_string())),
                },
                Err(error) => (RemoteRevocation::Failed, Some(error.to_string())),
            },
            Some(_) | None => (RemoteRevocation::NotApplicable, None),
        };
        let local_credentials_removed = context.storage.delete().await?;
        emit_notification(app, "account/updated", json!({ "authMode": null }));
        Ok(LogoutResponse {
            local_credentials_removed,
            remote_revocation,
            remote_revocation_error,
        })
    }

    async fn cancel_login(&self, login_id: &str) -> CancelLoginResponse {
        let mut pending = self.pending_login.lock().await;
        let matches = pending
            .as_ref()
            .is_some_and(|current| current.login_id == login_id);
        if !matches {
            return CancelLoginResponse {
                status: CancelLoginStatus::NotFound,
            };
        }
        if let Some(pending) = pending.take() {
            pending.cancellation.cancel();
        }
        CancelLoginResponse {
            status: CancelLoginStatus::Canceled,
        }
    }

    async fn cancel_pending_login(&self) {
        if let Some(pending) = self.pending_login.lock().await.take() {
            pending.cancellation.cancel();
        }
    }
}

struct LoginFlow {
    callback: CallbackServer,
    pkce: PkceCodes,
    state: token::SecretString,
}

struct RefreshOutcome {
    record: Option<AuthRecord>,
    refresh: RefreshResult,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginResponse {
    #[serde(rename = "type")]
    account_type: &'static str,
    login_id: String,
    auth_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountReadResponse {
    account: Option<Account>,
    requires_openai_auth: bool,
    refresh: RefreshResult,
}

impl AccountReadResponse {
    fn signed_out() -> Self {
        Self {
            account: None,
            requires_openai_auth: true,
            refresh: RefreshResult::not_required(),
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum Account {
    #[serde(rename = "chatgpt")]
    ChatGpt {
        email: Option<String>,
        #[serde(rename = "planType")]
        plan_type: Option<String>,
    },
    #[serde(rename = "apiKey")]
    ApiKey,
}

fn account_from_record(record: &AuthRecord) -> Result<Account, AuthError> {
    match record.mode() {
        StoredAuthMode::ChatGpt => {
            let claims = record.account_claims()?;
            Ok(Account::ChatGpt {
                email: claims.email,
                plan_type: claims.plan_type,
            })
        }
        StoredAuthMode::ApiKey => Ok(Account::ApiKey),
        StoredAuthMode::Other(mode) => Err(AuthError::CredentialStorage(format!(
            "stored authentication mode `{mode}` is not supported by the native engine"
        ))),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RefreshResult {
    status: RefreshStatus,
    error: Option<String>,
}

impl RefreshResult {
    fn not_required() -> Self {
        Self {
            status: RefreshStatus::NotRequired,
            error: None,
        }
    }

    fn succeeded() -> Self {
        Self {
            status: RefreshStatus::Succeeded,
            error: None,
        }
    }

    fn superseded() -> Self {
        Self {
            status: RefreshStatus::Superseded,
            error: None,
        }
    }

    fn failed(error: String) -> Self {
        Self {
            status: RefreshStatus::Failed,
            error: Some(error),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum RefreshStatus {
    NotRequired,
    Succeeded,
    Superseded,
    Failed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogoutResponse {
    local_credentials_removed: bool,
    remote_revocation: RemoteRevocation,
    remote_revocation_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum RemoteRevocation {
    NotApplicable,
    Succeeded,
    Failed,
}

#[derive(Serialize)]
struct CancelLoginResponse {
    status: CancelLoginStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum CancelLoginStatus {
    Canceled,
    NotFound,
}

fn emit_notification(app: &AppHandle, method: &str, params: Value) {
    let _ = app.emit(
        NOTIFICATION_EVENT,
        EngineNotification {
            method: method.into(),
            params,
        },
    );
}

fn emit_diagnostic(app: &AppHandle, message: String) {
    let _ = app.emit(
        RUNTIME_DIAGNOSTIC_EVENT,
        RuntimeDiagnostic {
            stream: "stderr",
            message,
        },
    );
}

fn report_cleanup_error(app: &AppHandle, result: Result<(), AuthError>) {
    if let Err(error) = result {
        emit_diagnostic(app, format!("OAuth credential cleanup failed: {error}"));
    }
}

fn report_browser_response_error(app: &AppHandle, result: Result<(), AuthError>) {
    if let Err(error) = result {
        emit_diagnostic(app, format!("OAuth browser response failed: {error}"));
    }
}
