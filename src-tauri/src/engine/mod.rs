mod contracts;
#[cfg(test)]
mod contracts_fixtures;
mod native;

use tauri::AppHandle;

use crate::error::AppError;

pub use contracts::*;
use native::NativeEngine;
pub use native::auth::{
    AccountProfileResponse, AccountReadResponse, CancelLoginResponse, LoginResponse, LogoutResponse,
};

pub const NOTIFICATION_EVENT: &str = "engine://notification";
pub const SERVER_REQUEST_EVENT: &str = "engine://server-request";
pub const RUNTIME_DIAGNOSTIC_EVENT: &str = "engine://runtime-diagnostic";
pub const RUNTIME_STATUS_EVENT: &str = "engine://runtime-status";

#[derive(Debug, Clone, Copy)]
pub(crate) enum RuntimeDiagnosticSubsystem {
    Authentication,
    Frontend,
    Menu,
    Provider,
    Runtime,
    Window,
}

impl RuntimeDiagnosticSubsystem {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Authentication => "authentication",
            Self::Frontend => "frontend",
            Self::Menu => "menu",
            Self::Provider => "provider",
            Self::Runtime => "runtime",
            Self::Window => "window",
        }
    }
}

#[derive(Default)]
pub struct EngineManager {
    engine: NativeEngine,
}

impl EngineManager {
    pub fn has_active_turns(&self) -> bool {
        self.engine.has_active_turns()
    }

    pub async fn start(&self, app: &AppHandle) -> Result<EngineStartResponse, AppError> {
        self.engine.start(app).await
    }

    pub async fn account_read(&self, app: &AppHandle) -> Result<AccountReadResponse, AppError> {
        self.engine.account_read(app).await
    }

    pub async fn account_profile_read(
        &self,
        app: &AppHandle,
    ) -> Result<AccountProfileResponse, AppError> {
        self.engine.account_profile_read(app).await
    }

    pub async fn account_rate_limits_read(
        &self,
        app: &AppHandle,
    ) -> Result<AccountRateLimitsResponse, AppError> {
        self.engine.account_rate_limits_read(app).await
    }

    pub async fn account_usage_resets_read(
        &self,
        app: &AppHandle,
    ) -> Result<UsageResetCreditsResponse, AppError> {
        self.engine.account_usage_resets_read(app).await
    }

    pub async fn account_usage_reset_redeem(
        &self,
        app: &AppHandle,
        credit_id: Option<&str>,
        redeem_request_id: &str,
    ) -> Result<UsageResetRedemptionResponse, AppError> {
        self.engine
            .account_usage_reset_redeem(app, credit_id, redeem_request_id)
            .await
    }

    pub async fn account_auto_top_up_read(
        &self,
        app: &AppHandle,
    ) -> Result<AutoTopUpSettingsSnapshot, AppError> {
        self.engine.account_auto_top_up_read(app).await
    }

    pub async fn account_auto_top_up_enable(
        &self,
        app: &AppHandle,
        recharge_threshold: &str,
        recharge_target: &str,
        recharge_monthly_limit: Option<&str>,
    ) -> Result<AutoTopUpSettingsSnapshot, AppError> {
        self.engine
            .account_auto_top_up_enable(
                app,
                recharge_threshold,
                recharge_target,
                recharge_monthly_limit,
            )
            .await
    }

    pub async fn account_auto_top_up_update(
        &self,
        app: &AppHandle,
        recharge_threshold: &str,
        recharge_target: &str,
        recharge_monthly_limit: Option<&str>,
    ) -> Result<AutoTopUpSettingsSnapshot, AppError> {
        self.engine
            .account_auto_top_up_update(
                app,
                recharge_threshold,
                recharge_target,
                recharge_monthly_limit,
            )
            .await
    }

    pub async fn account_auto_top_up_disable(
        &self,
        app: &AppHandle,
    ) -> Result<AutoTopUpSettingsSnapshot, AppError> {
        self.engine.account_auto_top_up_disable(app).await
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
        project_path: Option<String>,
        mode: ConversationMode,
    ) -> Result<ThreadStartResponse, AppError> {
        self.engine.thread_start(app, project_path, mode).await
    }

    pub async fn thread_list(
        &self,
        cursor: Option<String>,
        archived: bool,
    ) -> Result<ThreadListResponse, AppError> {
        self.engine.thread_list(cursor, archived).await
    }

    pub async fn thread_resume(&self, thread_id: String) -> Result<ThreadResumeResponse, AppError> {
        self.engine.thread_resume(thread_id).await
    }

    pub async fn thread_read(
        &self,
        thread_id: String,
        cursor: Option<String>,
    ) -> Result<ThreadReadResponse, AppError> {
        self.engine.thread_read(thread_id, cursor).await
    }

    pub async fn output_read(
        &self,
        output_id: String,
        cursor: Option<String>,
    ) -> Result<OutputReadResponse, AppError> {
        self.engine.output_read(output_id, cursor).await
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

    pub async fn thread_unarchive(
        &self,
        app: &AppHandle,
        thread_id: String,
    ) -> Result<ThreadUnarchiveResponse, AppError> {
        self.engine.thread_unarchive(app, thread_id).await
    }

    pub async fn thread_delete(
        &self,
        app: &AppHandle,
        thread_id: String,
    ) -> Result<OperationAck, AppError> {
        self.engine.thread_delete(app, thread_id).await
    }

    pub async fn thread_fork(
        &self,
        app: &AppHandle,
        thread_id: String,
    ) -> Result<ThreadForkResponse, AppError> {
        self.engine.thread_fork(app, thread_id).await
    }

    pub async fn turn_start(
        &self,
        app: &AppHandle,
        request: native::StartTurn,
    ) -> Result<TurnStartResponse, AppError> {
        self.engine.turn_start(app, request).await
    }

    pub async fn turn_steer(
        &self,
        app: &AppHandle,
        request: native::SteerTurn,
    ) -> Result<OperationAck, AppError> {
        self.engine.turn_steer(app, request).await
    }

    pub async fn turn_interrupt(
        &self,
        thread_id: String,
        turn_id: String,
    ) -> Result<OperationAck, AppError> {
        self.engine.turn_interrupt(thread_id, turn_id).await
    }

    pub async fn automation_list(&self) -> Result<AutomationListResponse, AppError> {
        self.engine.automation_list().await
    }

    pub async fn automation_create(
        &self,
        app: &AppHandle,
        request: native::CreateAutomation,
    ) -> Result<Automation, AppError> {
        self.engine.automation_create(app, request).await
    }

    pub async fn automation_update(
        &self,
        app: &AppHandle,
        request: native::UpdateAutomation,
    ) -> Result<Automation, AppError> {
        self.engine.automation_update(app, request).await
    }

    pub async fn automation_delete(
        &self,
        app: &AppHandle,
        automation_id: String,
    ) -> Result<OperationAck, AppError> {
        self.engine.automation_delete(app, automation_id).await
    }

    pub async fn automation_run_now(
        &self,
        app: &AppHandle,
        automation_id: String,
    ) -> Result<AutomationRun, AppError> {
        self.engine.automation_run_now(app, automation_id).await
    }

    pub async fn automation_run_mark_reviewed(
        &self,
        app: &AppHandle,
        run_id: String,
    ) -> Result<OperationAck, AppError> {
        self.engine.automation_run_mark_reviewed(app, run_id).await
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

    pub async fn chat_model_list(
        &self,
        app: &AppHandle,
    ) -> Result<ChatModelListResponse, AppError> {
        self.engine.chat_model_list(app).await
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

    pub(crate) fn report_runtime_error(
        &self,
        app: &AppHandle,
        subsystem: RuntimeDiagnosticSubsystem,
        message: String,
    ) {
        self.engine.report_runtime_error(app, subsystem, message);
    }

    pub(crate) fn persist_runtime_error(
        &self,
        subsystem: RuntimeDiagnosticSubsystem,
        message: &str,
    ) -> Result<(), AppError> {
        self.engine.persist_runtime_error(subsystem, message)
    }

    pub async fn stop(&self, app: &AppHandle) {
        self.engine.stop(app).await;
    }
}

pub use native::{CreateAutomation, StartTurn, SteerTurn, UpdateAutomation};
