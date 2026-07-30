use serde::Serialize;
use serde_json::Value;
use serde_json::json;

const THREAD_PAGE_LIMIT: u32 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineKind {
    Native,
    Compatibility,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineDescriptor {
    pub id: String,
    pub name: String,
    pub kind: EngineKind,
    pub provider: String,
    pub auth: String,
    pub capabilities: Vec<String>,
    pub uses_compatibility_bridge: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStartResponse {
    pub engine: EngineDescriptor,
    pub executable: Option<String>,
    pub transport: String,
    pub initialize: Value,
    pub compatibility: CompatibilityStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityStatus {
    pub available: bool,
    pub executable: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineNotification {
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineServerRequest {
    pub id: Value,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiagnostic {
    pub stream: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeState {
    Starting,
    Ready,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub state: RuntimeState,
    pub message: Option<String>,
}

#[derive(Debug)]
pub enum EngineTurnInput {
    Text(String),
    LocalImage { path: String },
    Mention { name: String, path: String },
}

impl EngineTurnInput {
    fn into_json(self) -> Value {
        match self {
            Self::Text(text) => json!({ "type": "text", "text": text }),
            Self::LocalImage { path } => json!({ "type": "localImage", "path": path }),
            Self::Mention { name, path } => {
                json!({ "type": "mention", "name": name, "path": path })
            }
        }
    }
}

#[derive(Debug)]
pub struct EngineConfigEdit {
    pub key_path: String,
    pub value: Value,
    pub merge_strategy: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineWindowsSandboxSetupMode {
    Elevated,
    Unelevated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
}

impl EngineReasoningEffort {
    fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::XHigh => "xhigh",
        }
    }
}

impl EngineWindowsSandboxSetupMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Elevated => "elevated",
            Self::Unelevated => "unelevated",
        }
    }
}

impl EngineConfigEdit {
    fn into_json(self) -> Value {
        json!({
            "keyPath": self.key_path,
            "value": self.value,
            "mergeStrategy": self.merge_strategy,
        })
    }
}

#[derive(Debug)]
pub enum EngineOperation {
    AccountRead,
    ReadAccountRateLimits,
    LoginChatGpt,
    CancelLogin {
        login_id: String,
    },
    Logout,
    StartThread {
        cwd: String,
    },
    ListThreads {
        cursor: Option<String>,
    },
    ResumeThread {
        thread_id: String,
    },
    ReadThread {
        thread_id: String,
    },
    ForkThread {
        thread_id: String,
        last_turn_id: Option<String>,
        model: String,
    },
    SetThreadName {
        thread_id: String,
        name: String,
    },
    ArchiveThread {
        thread_id: String,
    },
    StartTurn {
        thread_id: String,
        client_user_message_id: String,
        input: Vec<EngineTurnInput>,
        model: Option<String>,
        effort: Option<EngineReasoningEffort>,
    },
    InterruptTurn {
        thread_id: String,
        turn_id: String,
    },
    ReadConfig {
        include_layers: bool,
        cwd: Option<String>,
    },
    ReadConfigRequirements,
    ReadWindowsSandboxReadiness,
    StartWindowsSandboxSetup {
        mode: EngineWindowsSandboxSetupMode,
        cwd: Option<String>,
    },
    WriteConfig {
        edit: EngineConfigEdit,
        expected_version: Option<String>,
    },
    BatchWriteConfig {
        edits: Vec<EngineConfigEdit>,
        expected_version: Option<String>,
    },
    ListModels,
}

impl EngineOperation {
    pub fn audit_name(&self) -> &'static str {
        match self {
            Self::AccountRead => "account.read",
            Self::ReadAccountRateLimits => "account.rate_limits.read",
            Self::LoginChatGpt => "auth.login_chatgpt",
            Self::CancelLogin { .. } => "auth.cancel_login",
            Self::Logout => "auth.logout",
            Self::StartThread { .. } => "thread.start",
            Self::ListThreads { .. } => "thread.list",
            Self::ResumeThread { .. } => "thread.resume",
            Self::ReadThread { .. } => "thread.read",
            Self::ForkThread { .. } => "thread.fork",
            Self::SetThreadName { .. } => "thread.name.set",
            Self::ArchiveThread { .. } => "thread.archive",
            Self::StartTurn { .. } => "turn.start",
            Self::InterruptTurn { .. } => "turn.interrupt",
            Self::ReadConfig { .. } => "config.read",
            Self::ReadConfigRequirements => "config.requirements.read",
            Self::ReadWindowsSandboxReadiness => "sandbox.windows.readiness",
            Self::StartWindowsSandboxSetup { .. } => "sandbox.windows.setup.start",
            Self::WriteConfig { .. } => "config.write",
            Self::BatchWriteConfig { .. } => "config.batch_write",
            Self::ListModels => "models.list",
        }
    }

    pub fn audit_thread_id(&self) -> Option<&str> {
        match self {
            Self::ResumeThread { thread_id }
            | Self::ReadThread { thread_id }
            | Self::ForkThread { thread_id, .. }
            | Self::SetThreadName { thread_id, .. }
            | Self::ArchiveThread { thread_id }
            | Self::StartTurn { thread_id, .. }
            | Self::InterruptTurn { thread_id, .. } => Some(thread_id),
            _ => None,
        }
    }

    pub fn is_auth(&self) -> bool {
        matches!(
            self,
            Self::AccountRead | Self::LoginChatGpt | Self::CancelLogin { .. } | Self::Logout
        )
    }

    pub fn into_compatibility_rpc(self) -> (&'static str, Option<Value>) {
        match self {
            Self::AccountRead => ("account/read", Some(json!({ "refreshToken": false }))),
            Self::ReadAccountRateLimits => ("account/rateLimits/read", None),
            Self::LoginChatGpt => (
                "account/login/start",
                Some(json!({
                    "type": "chatgpt",
                    "useHostedLoginSuccessPage": true,
                    "appBrand": "codex",
                })),
            ),
            Self::CancelLogin { login_id } => {
                ("account/login/cancel", Some(json!({ "loginId": login_id })))
            }
            Self::Logout => ("account/logout", None),
            Self::StartThread { cwd } => (
                "thread/start",
                Some(json!({
                    "cwd": cwd,
                    "serviceName": "codex_desktop_next",
                })),
            ),
            Self::ListThreads { cursor } => (
                "thread/list",
                Some(json!({
                    "cursor": cursor,
                    "limit": THREAD_PAGE_LIMIT,
                    "sortKey": "recency_at",
                    "sortDirection": "desc",
                    "archived": false,
                })),
            ),
            Self::ResumeThread { thread_id } => {
                ("thread/resume", Some(json!({ "threadId": thread_id })))
            }
            Self::ReadThread { thread_id } => (
                "thread/read",
                Some(json!({ "threadId": thread_id, "includeTurns": true })),
            ),
            Self::ForkThread {
                thread_id,
                last_turn_id,
                model,
            } => (
                "thread/fork",
                Some(json!({
                    "threadId": thread_id,
                    "lastTurnId": last_turn_id,
                    "model": model,
                })),
            ),
            Self::SetThreadName { thread_id, name } => (
                "thread/name/set",
                Some(json!({ "threadId": thread_id, "name": name })),
            ),
            Self::ArchiveThread { thread_id } => {
                ("thread/archive", Some(json!({ "threadId": thread_id })))
            }
            Self::StartTurn {
                thread_id,
                client_user_message_id,
                input,
                model,
                effort,
            } => {
                let mut params = json!({
                    "threadId": thread_id,
                    "clientUserMessageId": client_user_message_id,
                    "input": input
                        .into_iter()
                        .map(EngineTurnInput::into_json)
                        .collect::<Vec<_>>(),
                });
                if let Some(model) = model {
                    params["model"] = Value::String(model);
                }
                if let Some(effort) = effort {
                    params["effort"] = Value::String(effort.as_str().to_string());
                }
                ("turn/start", Some(params))
            }
            Self::InterruptTurn { thread_id, turn_id } => (
                "turn/interrupt",
                Some(json!({ "threadId": thread_id, "turnId": turn_id })),
            ),
            Self::ReadConfig {
                include_layers,
                cwd,
            } => {
                let mut params = json!({ "includeLayers": include_layers });
                if let Some(cwd) = cwd {
                    params["cwd"] = Value::String(cwd);
                }
                ("config/read", Some(params))
            }
            Self::ReadConfigRequirements => ("configRequirements/read", None),
            Self::ReadWindowsSandboxReadiness => ("windowsSandbox/readiness", None),
            Self::StartWindowsSandboxSetup { mode, cwd } => {
                let mut params = json!({ "mode": mode.as_str() });
                if let Some(cwd) = cwd {
                    params["cwd"] = Value::String(cwd);
                }
                ("windowsSandbox/setupStart", Some(params))
            }
            Self::WriteConfig {
                edit,
                expected_version,
            } => {
                let mut params = edit.into_json();
                if let Some(expected_version) = expected_version {
                    params["expectedVersion"] = Value::String(expected_version);
                }
                ("config/value/write", Some(params))
            }
            Self::BatchWriteConfig {
                edits,
                expected_version,
            } => {
                let mut params = json!({
                    "edits": edits
                        .into_iter()
                        .map(EngineConfigEdit::into_json)
                        .collect::<Vec<_>>(),
                    "reloadUserConfig": false,
                });
                if let Some(expected_version) = expected_version {
                    params["expectedVersion"] = Value::String(expected_version);
                }
                ("config/batchWrite", Some(params))
            }
            Self::ListModels => ("model/list", Some(json!({ "limit": 100 }))),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::EngineConfigEdit;
    use super::EngineOperation;
    use super::EngineReasoningEffort;
    use super::EngineTurnInput;
    use super::EngineWindowsSandboxSetupMode;

    #[test]
    fn chatgpt_login_maps_to_the_official_compatibility_contract() {
        let (method, params) = EngineOperation::LoginChatGpt.into_compatibility_rpc();

        assert_eq!(method, "account/login/start");
        assert_eq!(
            params,
            Some(json!({
                "type": "chatgpt",
                "useHostedLoginSuccessPage": true,
                "appBrand": "codex",
            }))
        );
    }

    #[test]
    fn account_rate_limits_use_the_official_parameterless_contract() {
        let (method, params) = EngineOperation::ReadAccountRateLimits.into_compatibility_rpc();

        assert_eq!(method, "account/rateLimits/read");
        assert_eq!(params, None);
    }

    #[test]
    fn turn_input_mapping_preserves_typed_attachment_semantics() {
        let operation = EngineOperation::StartTurn {
            thread_id: "thread-1".into(),
            client_user_message_id: "message-1".into(),
            input: vec![
                EngineTurnInput::Text("Revise este arquivo".into()),
                EngineTurnInput::LocalImage {
                    path: "C:\\workspace\\preview.png".into(),
                },
                EngineTurnInput::Mention {
                    name: "main.rs".into(),
                    path: "C:\\workspace\\src\\main.rs".into(),
                },
            ],
            model: Some("gpt-5.6-codex".into()),
            effort: Some(EngineReasoningEffort::Low),
        };

        let (method, params) = operation.into_compatibility_rpc();

        assert_eq!(method, "turn/start");
        assert_eq!(
            params,
            Some(json!({
                "threadId": "thread-1",
                "clientUserMessageId": "message-1",
                "input": [
                    { "type": "text", "text": "Revise este arquivo" },
                    { "type": "localImage", "path": "C:\\workspace\\preview.png" },
                    {
                        "type": "mention",
                        "name": "main.rs",
                        "path": "C:\\workspace\\src\\main.rs",
                    },
                ],
                "model": "gpt-5.6-codex",
                "effort": "low",
            }))
        );
    }

    #[test]
    fn thread_read_always_requests_complete_turns() {
        let (method, params) = EngineOperation::ReadThread {
            thread_id: "thread-1".into(),
        }
        .into_compatibility_rpc();

        assert_eq!(method, "thread/read");
        assert_eq!(
            params,
            Some(json!({
                "threadId": "thread-1",
                "includeTurns": true,
            }))
        );
    }

    #[test]
    fn thread_fork_can_branch_before_the_first_turn() {
        let (method, params) = EngineOperation::ForkThread {
            thread_id: "thread-1".into(),
            last_turn_id: None,
            model: "gpt-5.6-mini".into(),
        }
        .into_compatibility_rpc();

        assert_eq!(method, "thread/fork");
        assert_eq!(
            params,
            Some(json!({
                "threadId": "thread-1",
                "lastTurnId": null,
                "model": "gpt-5.6-mini",
            }))
        );
    }

    #[test]
    fn thread_library_uses_the_official_paginated_contract() {
        let (method, params) = EngineOperation::ListThreads {
            cursor: Some("next-page".into()),
        }
        .into_compatibility_rpc();

        assert_eq!(method, "thread/list");
        assert_eq!(
            params,
            Some(json!({
                "cursor": "next-page",
                "limit": 100,
                "sortKey": "recency_at",
                "sortDirection": "desc",
                "archived": false,
            }))
        );
    }

    #[test]
    fn config_requirements_use_the_official_parameterless_contract() {
        let (method, params) = EngineOperation::ReadConfigRequirements.into_compatibility_rpc();

        assert_eq!(method, "configRequirements/read");
        assert_eq!(params, None);
    }

    #[test]
    fn windows_sandbox_readiness_uses_the_official_parameterless_contract() {
        let (method, params) =
            EngineOperation::ReadWindowsSandboxReadiness.into_compatibility_rpc();

        assert_eq!(method, "windowsSandbox/readiness");
        assert_eq!(params, None);
    }

    #[test]
    fn windows_sandbox_setup_preserves_mode_and_absolute_workspace() {
        let (method, params) = EngineOperation::StartWindowsSandboxSetup {
            mode: EngineWindowsSandboxSetupMode::Elevated,
            cwd: Some("C:\\workspace".to_string()),
        }
        .into_compatibility_rpc();

        assert_eq!(method, "windowsSandbox/setupStart");
        assert_eq!(
            params,
            Some(json!({
                "mode": "elevated",
                "cwd": "C:\\workspace",
            }))
        );
    }

    #[test]
    fn config_write_preserves_the_expected_user_layer_version() {
        let (method, params) = EngineOperation::WriteConfig {
            edit: EngineConfigEdit {
                key_path: "model".to_string(),
                value: json!("gpt-5.6-codex"),
                merge_strategy: "replace",
            },
            expected_version: Some("version-1".to_string()),
        }
        .into_compatibility_rpc();

        assert_eq!(method, "config/value/write");
        assert_eq!(
            params,
            Some(json!({
                "keyPath": "model",
                "value": "gpt-5.6-codex",
                "mergeStrategy": "replace",
                "expectedVersion": "version-1",
            }))
        );
    }
}
