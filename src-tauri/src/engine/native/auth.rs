use serde_json::Value;
use tauri::AppHandle;

use crate::engine::AgentEngine;
use crate::engine::EngineOperation;
use crate::engine::compatibility::CodexCompatibilityEngine;
use crate::error::AppError;

#[derive(Debug, Default)]
pub struct ChatGptAuth;

impl ChatGptAuth {
    pub async fn execute(
        &self,
        bridge: &CodexCompatibilityEngine,
        app: &AppHandle,
        operation: EngineOperation,
    ) -> Result<Value, AppError> {
        if !operation.is_auth() {
            return Err(AppError::Engine(
                "the ChatGPT auth module received a non-auth operation".into(),
            ));
        }
        bridge.execute(app, operation).await
    }
}
