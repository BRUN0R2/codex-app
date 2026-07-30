mod compatibility;
mod contracts;
mod native;

use serde_json::Value;
use tauri::AppHandle;

use crate::error::AppError;

pub use contracts::CompatibilityStatus;
pub use contracts::EngineConfigEdit;
pub use contracts::EngineDescriptor;
pub use contracts::EngineKind;
pub use contracts::EngineNotification;
pub use contracts::EngineOperation;
pub use contracts::EngineServerRequest;
pub use contracts::EngineStartResponse;
pub use contracts::EngineTurnInput;
pub use contracts::EngineWindowsSandboxSetupMode;
pub use contracts::RuntimeDiagnostic;
pub use contracts::RuntimeState;
pub use contracts::RuntimeStatus;

use compatibility::CodexCompatibilityEngine;
use native::NativeEngine;

pub const NOTIFICATION_EVENT: &str = "engine://notification";
pub const SERVER_REQUEST_EVENT: &str = "engine://server-request";
pub const RUNTIME_DIAGNOSTIC_EVENT: &str = "engine://runtime-diagnostic";
pub const RUNTIME_STATUS_EVENT: &str = "engine://runtime-status";

pub(crate) trait AgentEngine: Send + Sync {
    fn descriptor(&self) -> EngineDescriptor;

    async fn start(&self, app: &AppHandle) -> Result<EngineStartResponse, AppError>;

    async fn execute(&self, app: &AppHandle, operation: EngineOperation)
    -> Result<Value, AppError>;

    async fn respond(
        &self,
        app: &AppHandle,
        request_id: Value,
        response: Value,
    ) -> Result<(), AppError>;

    async fn stop(&self);
}

enum EngineBackend {
    Native(NativeEngine),
    Compatibility(CodexCompatibilityEngine),
}

pub struct EngineManager {
    backend: EngineBackend,
}

impl Default for EngineManager {
    fn default() -> Self {
        let backend = match std::env::var("CODEX_APP_ENGINE") {
            Ok(value) if value.eq_ignore_ascii_case("compatibility") => {
                EngineBackend::Compatibility(CodexCompatibilityEngine::default())
            }
            _ => EngineBackend::Native(NativeEngine::default()),
        };
        Self { backend }
    }
}

impl EngineManager {
    pub async fn start(&self, app: &AppHandle) -> Result<EngineStartResponse, AppError> {
        match &self.backend {
            EngineBackend::Native(engine) => engine.start(app).await,
            EngineBackend::Compatibility(engine) => engine.start(app).await,
        }
    }

    pub async fn execute(
        &self,
        app: &AppHandle,
        operation: EngineOperation,
    ) -> Result<Value, AppError> {
        match &self.backend {
            EngineBackend::Native(engine) => engine.execute(app, operation).await,
            EngineBackend::Compatibility(engine) => engine.execute(app, operation).await,
        }
    }

    pub async fn respond(
        &self,
        app: &AppHandle,
        request_id: Value,
        response: Value,
    ) -> Result<(), AppError> {
        match &self.backend {
            EngineBackend::Native(engine) => engine.respond(app, request_id, response).await,
            EngineBackend::Compatibility(engine) => engine.respond(app, request_id, response).await,
        }
    }

    pub async fn stop(&self) {
        match &self.backend {
            EngineBackend::Native(engine) => engine.stop().await,
            EngineBackend::Compatibility(engine) => engine.stop().await,
        }
    }
}
