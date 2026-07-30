mod protocol;
mod runtime;

pub use protocol::CodexNotification;
pub use protocol::CodexServerRequest;
pub use protocol::RuntimeDiagnostic;
pub use protocol::RuntimeStartResponse;
pub use protocol::RuntimeState;
pub use protocol::RuntimeStatus;
pub use runtime::CodexRuntime;

pub const NOTIFICATION_EVENT: &str = "codex://notification";
pub const SERVER_REQUEST_EVENT: &str = "codex://server-request";
pub const RUNTIME_DIAGNOSTIC_EVENT: &str = "codex://runtime-diagnostic";
pub const RUNTIME_STATUS_EVENT: &str = "codex://runtime-status";
