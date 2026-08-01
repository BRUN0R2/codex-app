mod contracts;
mod native;

use tauri::AppHandle;

use crate::error::AppError;

pub use contracts::*;
use native::NativeEngine;
pub use native::auth::{AccountReadResponse, CancelLoginResponse, LoginResponse, LogoutResponse};

pub const NOTIFICATION_EVENT: &str = "engine://notification";
pub const SERVER_REQUEST_EVENT: &str = "engine://server-request";
pub const RUNTIME_DIAGNOSTIC_EVENT: &str = "engine://runtime-diagnostic";
pub const RUNTIME_STATUS_EVENT: &str = "engine://runtime-status";

#[derive(Default)]
pub struct EngineManager {
    engine: NativeEngine,
}

impl EngineManager {
    pub async fn start(&self, app: &AppHandle) -> Result<EngineStartResponse, AppError> {
        self.engine.start(app).await
    }

    pub async fn account_read(&self, app: &AppHandle) -> Result<AccountReadResponse, AppError> {
        self.engine.account_read(app).await
    }

    pub async fn account_rate_limits_read(
        &self,
        app: &AppHandle,
    ) -> Result<AccountRateLimitsResponse, AppError> {
        self.engine.account_rate_limits_read(app).await
    }

    pub async fn login_chatgpt(&self, app: &AppHandle) -> Result<LoginResponse, AppError> {
        self.engine.login_chatgpt(app).await
    }

    pub async fn login_cancel(&self, login_id: &str) -> CancelLoginResponse {
        self.engine.login_cancel(login_id).await
    }

    pub async fn logout(&self, app: &AppHandle) -> Result<LogoutResponse, AppError> {
        self.engine.logout(app).await
    }

    pub async fn thread_start(
        &self,
        app: &AppHandle,
        cwd: String,
    ) -> Result<ThreadStartResponse, AppError> {
        self.engine.thread_start(app, cwd).await
    }

    pub async fn thread_list(
        &self,
        cursor: Option<String>,
    ) -> Result<ThreadListResponse, AppError> {
        self.engine.thread_list(cursor).await
    }

    pub async fn thread_resume(&self, thread_id: String) -> Result<ThreadResumeResponse, AppError> {
        self.engine.thread_resume(thread_id).await
    }

    pub async fn thread_read(&self, thread_id: String) -> Result<ThreadReadResponse, AppError> {
        self.engine.thread_read(thread_id).await
    }

    pub async fn thread_set_name(
        &self,
        app: &AppHandle,
        thread_id: String,
        name: String,
    ) -> Result<OperationAck, AppError> {
        self.engine.thread_set_name(app, thread_id, name).await
    }

    pub async fn thread_archive(
        &self,
        app: &AppHandle,
        thread_id: String,
    ) -> Result<OperationAck, AppError> {
        self.engine.thread_archive(app, thread_id).await
    }

    pub async fn turn_start(
        &self,
        app: &AppHandle,
        request: native::StartTurn,
    ) -> Result<TurnStartResponse, AppError> {
        self.engine.turn_start(app, request).await
    }

    pub async fn turn_interrupt(
        &self,
        thread_id: String,
        turn_id: String,
    ) -> Result<OperationAck, AppError> {
        self.engine.turn_interrupt(thread_id, turn_id).await
    }

    pub async fn config_read(&self) -> Result<ConfigReadResponse, AppError> {
        self.engine.config_read().await
    }

    pub async fn config_update(
        &self,
        expected_version: u64,
        update: ConfigUpdate,
    ) -> Result<ConfigUpdateResponse, AppError> {
        self.engine.config_update(expected_version, update).await
    }

    pub async fn model_list(&self, app: &AppHandle) -> Result<ModelListResponse, AppError> {
        self.engine.model_list(app).await
    }

    pub async fn server_request_respond(
        &self,
        request_id: String,
        response: ServerResponse,
    ) -> Result<OperationAck, AppError> {
        self.engine
            .server_request_respond(request_id, response)
            .await
    }

    pub async fn stop(&self, app: &AppHandle) {
        self.engine.stop(app).await;
    }
}

pub use native::StartTurn;
