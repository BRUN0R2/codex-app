use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::engine::AgentEngine;
use crate::engine::EngineOperation;
use crate::engine::compatibility::CodexCompatibilityEngine;
use crate::error::AppError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDescriptor {
    pub id: &'static str,
    pub name: &'static str,
    pub auth: &'static str,
    pub transport: &'static str,
}

#[derive(Debug, Default)]
pub struct ChatGptCodexProvider;

impl ChatGptCodexProvider {
    pub fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            id: "chatgpt-codex",
            name: "ChatGPT via Codex",
            auth: "chatgpt",
            transport: "compatibility-bridge",
        }
    }

    pub async fn execute(
        &self,
        bridge: &CodexCompatibilityEngine,
        app: &AppHandle,
        operation: EngineOperation,
    ) -> Result<Value, AppError> {
        if operation.is_auth() {
            return Err(AppError::Engine(
                "the model provider received an authentication operation".into(),
            ));
        }
        bridge.execute(app, operation).await
    }
}
