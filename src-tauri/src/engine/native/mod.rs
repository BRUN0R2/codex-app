mod auth;
mod provider;
mod sandbox;
mod storage;
mod tools;

use serde_json::Value;
use serde_json::json;
use tauri::AppHandle;

use self::auth::ChatGptAuth;
use self::provider::ChatGptCodexProvider;
use self::sandbox::PermissionProfile;
use self::storage::NativeStorage;
use self::tools::ToolRegistry;
use super::AgentEngine;
use super::EngineDescriptor;
use super::EngineKind;
use super::EngineOperation;
use super::EngineStartResponse;
use super::compatibility::CodexCompatibilityEngine;
use crate::error::AppError;

#[derive(Default)]
pub struct NativeEngine {
    auth: ChatGptAuth,
    bridge: CodexCompatibilityEngine,
    permissions: PermissionProfile,
    provider: ChatGptCodexProvider,
    storage: NativeStorage,
    tools: ToolRegistry,
}

impl AgentEngine for NativeEngine {
    fn descriptor(&self) -> EngineDescriptor {
        EngineDescriptor {
            id: "native-engine".into(),
            name: "Native Engine".into(),
            kind: EngineKind::Native,
            provider: self.provider.descriptor().name.into(),
            auth: "ChatGPT".into(),
            capabilities: [
                "native-storage",
                "tool-registry",
                "sandbox-policy",
                "chatgpt-auth",
                "codex-compatibility",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
            uses_compatibility_bridge: true,
        }
    }

    async fn start(&self, app: &AppHandle) -> Result<EngineStartResponse, AppError> {
        if !self.tools.contains("workspace.read_file")
            || !self.tools.contains("workspace.apply_patch")
        {
            return Err(AppError::Engine(
                "the native tool registry is missing required workspace tools".into(),
            ));
        }
        self.storage.initialize(app).await?;
        self.auth.initialize(app).await?;
        self.storage.record_operation("engine.start", None).await?;

        let compatibility = self.bridge.availability();
        let initialize = json!({
            "nativeEngine": {
                "provider": self.provider.descriptor(),
                "permissionPreset": self.permissions.preset_name(),
                "availablePermissionPresets": PermissionProfile::supported_presets()
                    .map(PermissionProfile::preset_name),
                "registeredTools": self.tools.descriptors().len(),
                "compatibilityBridge": compatibility,
            },
        });

        Ok(EngineStartResponse {
            engine: self.descriptor(),
            executable: compatibility.executable.clone(),
            transport: "native".into(),
            initialize,
            compatibility,
        })
    }

    async fn execute(
        &self,
        app: &AppHandle,
        operation: EngineOperation,
    ) -> Result<Value, AppError> {
        let audit_name = operation.audit_name();
        let audit_thread_id = operation.audit_thread_id().map(str::to_string);
        let thread_workspace = match &operation {
            EngineOperation::StartThread { cwd } => Some(cwd.clone()),
            _ => None,
        };
        self.storage
            .record_operation(audit_name, audit_thread_id.as_deref())
            .await?;

        if matches!(&operation, EngineOperation::Logout) {
            self.bridge.stop().await;
        }

        let result = if operation.is_auth() {
            self.auth.execute(app, operation).await?
        } else {
            self.provider.execute(&self.bridge, app, operation).await?
        };

        if let Some(workspace) = thread_workspace
            && let Some(thread_id) = result
                .get("thread")
                .and_then(Value::as_object)
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
        {
            self.storage.upsert_thread(thread_id, &workspace).await?;
        }
        Ok(result)
    }

    async fn respond(
        &self,
        app: &AppHandle,
        request_id: Value,
        response: Value,
    ) -> Result<(), AppError> {
        self.storage
            .record_operation("server_request.respond", None)
            .await?;
        self.bridge.respond(app, request_id, response).await
    }

    async fn stop(&self) {
        self.auth.stop().await;
        self.bridge.stop().await;
    }
}
