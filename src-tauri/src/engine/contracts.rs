use serde::Serialize;
use serde_json::Value;
use serde_json::json;

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
    LoginChatGpt,
    CancelLogin {
        login_id: String,
    },
    Logout,
    StartThread {
        cwd: String,
    },
    StartTurn {
        thread_id: String,
        client_user_message_id: String,
        input: Vec<EngineTurnInput>,
    },
    InterruptTurn {
        thread_id: String,
        turn_id: String,
    },
    ReadConfig {
        include_layers: bool,
        cwd: Option<String>,
    },
    WriteConfig {
        edit: EngineConfigEdit,
    },
    BatchWriteConfig {
        edits: Vec<EngineConfigEdit>,
    },
    ListModels,
}

impl EngineOperation {
    pub fn audit_name(&self) -> &'static str {
        match self {
            Self::AccountRead => "account.read",
            Self::LoginChatGpt => "auth.login_chatgpt",
            Self::CancelLogin { .. } => "auth.cancel_login",
            Self::Logout => "auth.logout",
            Self::StartThread { .. } => "thread.start",
            Self::StartTurn { .. } => "turn.start",
            Self::InterruptTurn { .. } => "turn.interrupt",
            Self::ReadConfig { .. } => "config.read",
            Self::WriteConfig { .. } => "config.write",
            Self::BatchWriteConfig { .. } => "config.batch_write",
            Self::ListModels => "models.list",
        }
    }

    pub fn audit_thread_id(&self) -> Option<&str> {
        match self {
            Self::StartTurn { thread_id, .. } | Self::InterruptTurn { thread_id, .. } => {
                Some(thread_id)
            }
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
            Self::StartTurn {
                thread_id,
                client_user_message_id,
                input,
            } => (
                "turn/start",
                Some(json!({
                    "threadId": thread_id,
                    "clientUserMessageId": client_user_message_id,
                    "input": input
                        .into_iter()
                        .map(EngineTurnInput::into_json)
                        .collect::<Vec<_>>(),
                })),
            ),
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
            Self::WriteConfig { edit } => ("config/value/write", Some(edit.into_json())),
            Self::BatchWriteConfig { edits } => (
                "config/batchWrite",
                Some(json!({
                    "edits": edits
                        .into_iter()
                        .map(EngineConfigEdit::into_json)
                        .collect::<Vec<_>>(),
                    "reloadUserConfig": false,
                })),
            ),
            Self::ListModels => ("model/list", Some(json!({ "limit": 100 }))),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::EngineOperation;
    use super::EngineTurnInput;

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
            }))
        );
    }
}
