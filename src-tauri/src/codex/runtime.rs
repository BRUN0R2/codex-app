use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tauri::AppHandle;
use tauri::Emitter;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::process::Child;
use tokio::process::ChildStdin;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::sync::RwLock;
use tokio::sync::oneshot;
use tokio::time::timeout;

use super::CompatibilityStartResponse;
use crate::engine::CompatibilityStatus;
use crate::engine::EngineNotification;
use crate::engine::EngineServerRequest;
use crate::engine::NOTIFICATION_EVENT;
use crate::engine::RUNTIME_DIAGNOSTIC_EVENT;
use crate::engine::RUNTIME_STATUS_EVENT;
use crate::engine::RuntimeDiagnostic;
use crate::engine::RuntimeState;
use crate::engine::RuntimeStatus;
use crate::engine::SERVER_REQUEST_EVENT;
use crate::error::AppError;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const FIRST_REQUEST_ID: u64 = 1;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

type PendingResponse = oneshot::Sender<Result<Value, AppError>>;

struct Session {
    executable: PathBuf,
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, PendingResponse>>,
    initialize: RwLock<Option<Value>>,
    alive: AtomicBool,
}

pub struct CodexRuntime {
    session: RwLock<Option<Arc<Session>>>,
    start_lock: Mutex<()>,
    next_request_id: AtomicU64,
}

impl Default for CodexRuntime {
    fn default() -> Self {
        Self {
            session: RwLock::new(None),
            start_lock: Mutex::new(()),
            next_request_id: AtomicU64::new(FIRST_REQUEST_ID),
        }
    }
}

impl CodexRuntime {
    pub fn availability(&self) -> CompatibilityStatus {
        match resolve_codex_binary() {
            Ok(executable) => CompatibilityStatus {
                available: true,
                executable: Some(executable.to_string_lossy().into_owned()),
                reason: None,
            },
            Err(error) => CompatibilityStatus {
                available: false,
                executable: None,
                reason: Some(error.to_string()),
            },
        }
    }

    pub async fn start(&self, app: &AppHandle) -> Result<CompatibilityStartResponse, AppError> {
        let _start_guard = self.start_lock.lock().await;

        if let Some(session) = self.active_session().await
            && let Some(initialize) = session.initialize.read().await.clone()
        {
            return Ok(CompatibilityStartResponse {
                executable: session.executable.to_string_lossy().into_owned(),
                initialize,
            });
        }

        emit_status(app, RuntimeState::Starting, None);
        let session = match self.spawn_session(app).await {
            Ok(session) => session,
            Err(error) => {
                emit_status(app, RuntimeState::Failed, Some(error.to_string()));
                return Err(error);
            }
        };
        *self.session.write().await = Some(Arc::clone(&session));

        let initialize_params = initialize_params();
        let initialize = match self
            .send_request_to(&session, "initialize", Some(initialize_params))
            .await
        {
            Ok(result) => result,
            Err(error) => {
                self.stop_session(&session).await;
                emit_status(app, RuntimeState::Failed, Some(error.to_string()));
                return Err(error);
            }
        };
        if let Err(error) = self
            .send_notification_to(&session, "initialized", None)
            .await
        {
            self.stop_session(&session).await;
            emit_status(app, RuntimeState::Failed, Some(error.to_string()));
            return Err(error);
        }
        *session.initialize.write().await = Some(initialize.clone());
        emit_status(app, RuntimeState::Ready, None);

        Ok(CompatibilityStartResponse {
            executable: session.executable.to_string_lossy().into_owned(),
            initialize,
        })
    }

    pub async fn request(
        &self,
        app: &AppHandle,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, AppError> {
        self.start(app).await?;
        let session = self
            .active_session()
            .await
            .ok_or(AppError::RuntimeUnavailable)?;
        self.send_request_to(&session, method, params).await
    }

    pub async fn respond(
        &self,
        app: &AppHandle,
        request_id: Value,
        response: Value,
    ) -> Result<(), AppError> {
        self.start(app).await?;
        let session = self
            .active_session()
            .await
            .ok_or(AppError::RuntimeUnavailable)?;
        self.write_value(&session, &json!({ "id": request_id, "response": response }))
            .await
    }

    pub async fn stop(&self) {
        let session = self.session.write().await.take();
        if let Some(session) = session {
            self.stop_session(&session).await;
        }
    }

    async fn active_session(&self) -> Option<Arc<Session>> {
        self.session
            .read()
            .await
            .as_ref()
            .filter(|session| session.alive.load(Ordering::Acquire))
            .cloned()
    }

    async fn spawn_session(&self, app: &AppHandle) -> Result<Arc<Session>, AppError> {
        let executable = resolve_codex_binary()?;
        let mut command = Command::new(&executable);
        command
            .args([
                "-c",
                "cli_auth_credentials_store=\"keyring\"",
                "-c",
                "features.secret_auth_storage=true",
                "app-server",
                "--listen",
                "stdio://",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt as _;
            command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|error| AppError::CodexStart(error.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::CodexStart("app-server stdin was not created".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::CodexStart("app-server stdout was not created".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AppError::CodexStart("app-server stderr was not created".into()))?;

        let session = Arc::new(Session {
            executable,
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            initialize: RwLock::new(None),
            alive: AtomicBool::new(true),
        });

        tokio::spawn(read_stdout(
            BufReader::new(stdout),
            Arc::clone(&session),
            app.clone(),
        ));
        tokio::spawn(read_stderr(BufReader::new(stderr), app.clone()));

        Ok(session)
    }

    async fn send_request_to(
        &self,
        session: &Arc<Session>,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, AppError> {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        session.pending.lock().await.insert(request_id, sender);

        let mut request = Map::new();
        request.insert("method".into(), Value::String(method.into()));
        request.insert("id".into(), Value::Number(request_id.into()));
        if let Some(params) = params {
            request.insert("params".into(), params);
        }

        if let Err(error) = self.write_value(session, &Value::Object(request)).await {
            session.pending.lock().await.remove(&request_id);
            return Err(error);
        }

        match timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(AppError::RuntimeUnavailable),
            Err(_) => {
                session.pending.lock().await.remove(&request_id);
                Err(AppError::Timeout {
                    method: method.into(),
                })
            }
        }
    }

    async fn send_notification_to(
        &self,
        session: &Arc<Session>,
        method: &str,
        params: Option<Value>,
    ) -> Result<(), AppError> {
        let mut notification = Map::new();
        notification.insert("method".into(), Value::String(method.into()));
        if let Some(params) = params {
            notification.insert("params".into(), params);
        }
        self.write_value(session, &Value::Object(notification))
            .await
    }

    async fn write_value(&self, session: &Session, value: &Value) -> Result<(), AppError> {
        if !session.alive.load(Ordering::Acquire) {
            return Err(AppError::RuntimeUnavailable);
        }

        let mut bytes =
            serde_json::to_vec(value).map_err(|error| AppError::Protocol(error.to_string()))?;
        bytes.push(b'\n');
        let mut stdin = session.stdin.lock().await;
        stdin
            .write_all(&bytes)
            .await
            .map_err(|error| AppError::Protocol(error.to_string()))?;
        stdin
            .flush()
            .await
            .map_err(|error| AppError::Protocol(error.to_string()))
    }

    async fn stop_session(&self, session: &Session) {
        session.alive.store(false, Ordering::Release);
        let _ = session.child.lock().await.kill().await;
        fail_pending(session, "Codex app-server stopped").await;
    }
}

async fn read_stdout<R>(mut reader: BufReader<R>, session: Arc<Session>, app: AppHandle)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(trimmed) {
                    Ok(message) => route_message(&session, &app, message).await,
                    Err(error) => {
                        let _ = app.emit(
                            RUNTIME_DIAGNOSTIC_EVENT,
                            RuntimeDiagnostic {
                                stream: "stdout",
                                message: format!("invalid app-server message: {error}"),
                            },
                        );
                    }
                }
            }
            Err(error) => {
                let _ = app.emit(
                    RUNTIME_DIAGNOSTIC_EVENT,
                    RuntimeDiagnostic {
                        stream: "stdout",
                        message: error.to_string(),
                    },
                );
                break;
            }
        }
    }

    session.alive.store(false, Ordering::Release);
    fail_pending(&session, "Codex app-server closed its output").await;
    emit_status(
        &app,
        RuntimeState::Stopped,
        Some("Codex app-server stopped".into()),
    );
}

async fn read_stderr<R>(mut reader: BufReader<R>, app: AppHandle)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let message = line.trim();
                if !message.is_empty() {
                    let _ = app.emit(
                        RUNTIME_DIAGNOSTIC_EVENT,
                        RuntimeDiagnostic {
                            stream: "stderr",
                            message: message.into(),
                        },
                    );
                }
            }
        }
    }
}

async fn route_message(session: &Session, app: &AppHandle, message: Value) {
    let Some(object) = message.as_object() else {
        return;
    };

    if let Some(method) = object.get("method").and_then(Value::as_str) {
        let params = object.get("params").cloned().unwrap_or(Value::Null);
        if let Some(id) = object.get("id") {
            let _ = app.emit(
                SERVER_REQUEST_EVENT,
                EngineServerRequest {
                    id: id.clone(),
                    method: method.into(),
                    params,
                },
            );
        } else {
            let _ = app.emit(
                NOTIFICATION_EVENT,
                EngineNotification {
                    method: method.into(),
                    params,
                },
            );
        }
        return;
    }

    let Some(request_id) = object.get("id").and_then(Value::as_u64) else {
        return;
    };
    let Some(sender) = session.pending.lock().await.remove(&request_id) else {
        return;
    };

    if let Some(error) = object.get("error") {
        let code = error.get("code").and_then(Value::as_i64);
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown app-server error")
            .to_owned();
        let _ = sender.send(Err(AppError::Rpc { code, message }));
    } else if let Some(result) = object.get("result") {
        let _ = sender.send(Ok(result.clone()));
    } else {
        let _ = sender.send(Err(AppError::Protocol(
            "response contained neither result nor error".into(),
        )));
    }
}

async fn fail_pending(session: &Session, message: &str) {
    let pending = std::mem::take(&mut *session.pending.lock().await);
    for sender in pending.into_values() {
        let _ = sender.send(Err(AppError::Protocol(message.into())));
    }
}

fn emit_status(app: &AppHandle, state: RuntimeState, message: Option<String>) {
    let _ = app.emit(RUNTIME_STATUS_EVENT, RuntimeStatus { state, message });
}

fn initialize_params() -> Value {
    json!({
        "clientInfo": {
            "name": "codex_desktop_next",
            "title": "Codex App",
            "version": env!("CARGO_PKG_VERSION")
        },
        "capabilities": {
            "experimentalApi": true,
            "requestAttestation": false,
            "mcpServerOpenaiFormElicitation": false
        }
    })
}

fn resolve_codex_binary() -> Result<PathBuf, AppError> {
    if let Some(configured) = std::env::var_os("CODEX_APP_BINARY") {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Ok(path);
        }
        return Err(AppError::InvalidCodexBinary(
            path.to_string_lossy().into_owned(),
        ));
    }

    which::which("codex").map_err(|_| AppError::CodexBinaryNotFound)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::initialize_params;

    #[test]
    fn initialize_declares_only_supported_server_capabilities() {
        let params = initialize_params();

        assert_eq!(
            params["capabilities"],
            json!({
                "experimentalApi": true,
                "requestAttestation": false,
                "mcpServerOpenaiFormElicitation": false,
            })
        );
    }
}
