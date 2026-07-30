use serde_json::Value;
use tauri::AppHandle;

use super::AgentEngine;
use super::EngineDescriptor;
use super::EngineKind;
use super::EngineOperation;
use super::EngineStartResponse;
use crate::codex::CodexRuntime;
use crate::error::AppError;

#[derive(Default)]
pub struct CodexCompatibilityEngine {
    runtime: CodexRuntime,
}

impl AgentEngine for CodexCompatibilityEngine {
    fn descriptor(&self) -> EngineDescriptor {
        EngineDescriptor {
            id: "codex-app-server".into(),
            name: "Codex App Server".into(),
            kind: EngineKind::Compatibility,
            provider: "Codex".into(),
            auth: "ChatGPT".into(),
            capabilities: compatibility_capabilities(),
            uses_compatibility_bridge: true,
        }
    }

    async fn start(&self, app: &AppHandle) -> Result<EngineStartResponse, AppError> {
        let started = self.runtime.start(app).await?;
        Ok(EngineStartResponse {
            engine: self.descriptor(),
            executable: Some(started.executable),
            transport: "jsonl-stdio".into(),
            initialize: started.initialize,
        })
    }

    async fn execute(
        &self,
        app: &AppHandle,
        operation: EngineOperation,
    ) -> Result<Value, AppError> {
        let (method, params) = operation.into_compatibility_rpc();
        self.runtime.request(app, method, params).await
    }

    async fn respond(
        &self,
        app: &AppHandle,
        request_id: Value,
        response: Value,
    ) -> Result<(), AppError> {
        self.runtime.respond(app, request_id, response).await
    }

    async fn stop(&self) {
        self.runtime.stop().await;
    }
}

fn compatibility_capabilities() -> Vec<String> {
    [
        "chatgpt-auth",
        "threads",
        "streaming",
        "attachments",
        "approvals",
        "configuration",
        "models",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}
