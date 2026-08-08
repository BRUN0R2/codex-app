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
use tauri::AppHandle;
use tauri::Emitter as _;
use tokio::sync::Mutex;
use tokio::sync::Notify;
use tokio::sync::OnceCell;
use uuid::Uuid;

use self::callback::CallbackServer;
use self::error::AuthError;
use self::oauth::AccountProfile;
use self::oauth::OAuthClient;
use self::pkce::PkceCodes;
use self::pkce::generate_pkce;
use self::pkce::generate_state;
use self::storage::CredentialStorage;
use self::token::AuthRecord;
use super::super::AuthLoginCompleted;
use super::super::AuthSessionChanged;
use super::super::DiagnosticStream;
use super::super::EngineNotification;
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

pub(crate) struct AuthSession {
    access_token: token::SecretString,
    account_id: String,
}

impl AuthSession {
    pub fn access_token(&self) -> &str {
        self.access_token.expose()
    }

    pub fn account_id(&self) -> &str {
        &self.account_id
    }
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

    pub async fn read_account(&self, app: &AppHandle) -> Result<AccountReadResponse, AppError> {
        self.inner.read_account(app).await.map_err(Into::into)
    }

    pub async fn start_login(&self, app: &AppHandle) -> Result<LoginResponse, AppError> {
        self.inner.start_login(app).await.map_err(Into::into)
    }

    pub async fn cancel_login(&self, login_id: &str) -> CancelLoginResponse {
        self.inner.cancel_login(login_id).await
    }

    pub async fn logout(&self, app: &AppHandle) -> Result<LogoutResponse, AppError> {
        self.inner.logout(app).await.map_err(Into::into)
    }

    pub(crate) async fn session(&self, app: &AppHandle) -> Result<AuthSession, AppError> {
        self.inner.session(app).await.map_err(Into::into)
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
        let Some(record) = load_cached_record(app, context).await? else {
            return Ok(AccountReadResponse::signed_out());
        };

        let outcome = if record.should_refresh(Utc::now()) {
            self.refresh_record(app, context, record).await?
        } else {
            RefreshOutcome {
                record: Some(record),
                refresh: RefreshResult::not_required(),
            }
        };
        let account = match outcome.record.as_ref() {
            Some(record) => Some(account_from_record(app, context, record).await?),
            None => None,
        };
        Ok(AccountReadResponse {
            account,
            requires_openai_auth: true,
            refresh: outcome.refresh,
        })
    }

    async fn session(&self, app: &AppHandle) -> Result<AuthSession, AuthError> {
        let context = self.context(app).await?;
        let _operation_guard = context.operation_gate.lock().await;
        let mut record = load_cached_record(app, context)
            .await?
            .ok_or_else(|| AuthError::InvalidToken("no ChatGPT account is connected".into()))?;
        if record.should_refresh(Utc::now()) {
            let outcome = self.refresh_record(app, context, record).await?;
            if outcome.refresh.status == RefreshStatus::Failed {
                return Err(AuthError::OAuth(
                    outcome
                        .refresh
                        .error
                        .unwrap_or_else(|| "token refresh failed".into()),
                ));
            }
            record = outcome.record.ok_or_else(|| {
                AuthError::InvalidToken("the ChatGPT session was removed during refresh".into())
            })?;
        }
        let tokens = record.tokens();
        Ok(AuthSession {
            access_token: tokens.access_token.clone(),
            account_id: tokens.account_id.clone(),
        })
    }

    async fn refresh_record(
        &self,
        app: &AppHandle,
        context: &AuthContext,
        mut record: AuthRecord,
    ) -> Result<RefreshOutcome, AuthError> {
        let refresh_token = &record.tokens().refresh_token;
        let patch = match context.oauth.refresh(refresh_token).await {
            Ok(patch) => patch,
            Err(error) => {
                return Ok(RefreshOutcome {
                    record: Some(record),
                    refresh: RefreshResult::failed(error.to_string()),
                });
            }
        };

        let current = match load_cached_record(app, context).await {
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
                    if let Err(error) = context.oauth.revoke_tokens(record.tokens()).await {
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
        if load_cached_record(app, context).await?.is_some() {
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
            report_cleanup_error(app, context.oauth.revoke_tokens(record.tokens()).await);
            report_browser_response_error(app, callback.respond_failure().await);
            return Err(AuthError::LoginCancelled);
        }
        if let Err(error) = context.storage.save(&record).await {
            report_cleanup_error(app, context.oauth.revoke_tokens(record.tokens()).await);
            report_browser_response_error(app, callback.respond_failure().await);
            return Err(error);
        }
        if cancellation.is_cancelled() {
            report_cleanup_error(app, context.oauth.revoke_tokens(record.tokens()).await);
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
            EngineNotification::AuthLoginCompleted(AuthLoginCompleted {
                login_id: login_id.into(),
                success,
                error,
            }),
        );
        if success {
            emit_notification(
                app,
                EngineNotification::AuthSessionChanged(AuthSessionChanged { signed_in: true }),
            );
        }
    }

    async fn logout(&self, app: &AppHandle) -> Result<LogoutResponse, AuthError> {
        self.cancel_pending_login().await;
        let context = self.context(app).await?;
        let _operation_guard = context.operation_gate.lock().await;
        let record = load_cached_record(app, context).await?;

        let (remote_revocation, remote_revocation_error) = match record.as_ref() {
            Some(record) => match context.oauth.revoke_tokens(record.tokens()).await {
                Ok(()) => (RemoteRevocation::Succeeded, None),
                Err(error) => (RemoteRevocation::Failed, Some(error.to_string())),
            },
            None => (RemoteRevocation::NotApplicable, None),
        };
        let local_credentials_removed = context.storage.delete().await?;
        emit_notification(
            app,
            EngineNotification::AuthSessionChanged(AuthSessionChanged { signed_in: false }),
        );
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
pub struct LoginResponse {
    #[serde(rename = "type")]
    account_type: &'static str,
    login_id: String,
    auth_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountReadResponse {
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
pub enum Account {
    #[serde(rename = "chatgpt")]
    ChatGpt {
        email: Option<String>,
        name: Option<String>,
        picture: Option<String>,
        #[serde(rename = "planType")]
        plan_type: Option<String>,
    },
}

async fn account_from_record(
    app: &AppHandle,
    context: &AuthContext,
    record: &AuthRecord,
) -> Result<Account, AuthError> {
    let claims = record.account_claims()?;
    let profile = if claims.email.is_none() || claims.name.is_none() || claims.picture.is_none() {
        match context.oauth.userinfo(&record.tokens().access_token).await {
            Ok(profile) => profile,
            Err(error) => {
                emit_diagnostic(app, format!("could not read the ChatGPT profile: {error}"));
                AccountProfile::default()
            }
        }
    } else {
        AccountProfile::default()
    };
    Ok(Account::ChatGpt {
        email: profile.email.or(claims.email),
        name: profile.name.or(claims.name),
        picture: profile.picture.or(claims.picture),
        plan_type: claims.plan_type,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefreshStatus {
    NotRequired,
    Succeeded,
    Superseded,
    Failed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoutResponse {
    local_credentials_removed: bool,
    remote_revocation: RemoteRevocation,
    remote_revocation_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteRevocation {
    NotApplicable,
    Succeeded,
    Failed,
}

#[derive(Serialize)]
pub struct CancelLoginResponse {
    status: CancelLoginStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CancelLoginStatus {
    Canceled,
    NotFound,
}

fn emit_notification(app: &AppHandle, notification: EngineNotification) {
    if let Err(error) = app.emit(NOTIFICATION_EVENT, notification) {
        emit_diagnostic(
            app,
            format!("could not emit authentication notification: {error}"),
        );
    }
}

fn emit_diagnostic(app: &AppHandle, message: String) {
    if let Err(error) = app.emit(
        RUNTIME_DIAGNOSTIC_EVENT,
        RuntimeDiagnostic {
            stream: DiagnosticStream::Runtime,
            message,
        },
    ) {
        eprintln!("runtime diagnostic delivery failed: {error}");
    }
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

async fn load_cached_record(
    app: &AppHandle,
    context: &AuthContext,
) -> Result<Option<AuthRecord>, AuthError> {
    match context.storage.load().await {
        Ok(record) => Ok(record),
        Err(AuthError::CredentialStorage(message)) if is_credential_retrieval_corrupt(&message) => {
            emit_diagnostic(
                app,
                format!("credential cache is corrupt and will be cleared: {message}"),
            );
            if let Err(error) = context.storage.delete().await {
                emit_diagnostic(app, format!("could not clear corrupt credentials: {error}"));
            }
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn is_credential_retrieval_corrupt(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("could not decrypt credentials") || lower.contains("excessive work parameter")
}
