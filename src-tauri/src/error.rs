use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Codex CLI was not found. Install Codex or set CODEX_APP_BINARY to its executable.")]
    CodexBinaryNotFound,
    #[error("configured Codex executable does not exist: {0}")]
    InvalidCodexBinary(String),
    #[error("failed to start Codex app-server: {0}")]
    CodexStart(String),
    #[error("Codex app-server is not available")]
    RuntimeUnavailable,
    #[error("Codex app-server protocol error: {0}")]
    Protocol(String),
    #[error("Codex request `{method}` timed out")]
    Timeout { method: String },
    #[error("Codex request failed: {message}")]
    Rpc { code: Option<i64>, message: String },
    #[error("invalid attachment: {0}")]
    InvalidAttachment(String),
    #[error("filesystem operation failed: {0}")]
    FileSystem(String),
}

impl AppError {
    fn code(&self) -> &'static str {
        match self {
            Self::CodexBinaryNotFound => "codexBinaryNotFound",
            Self::InvalidCodexBinary(_) => "invalidCodexBinary",
            Self::CodexStart(_) => "codexStartFailed",
            Self::RuntimeUnavailable => "codexRuntimeUnavailable",
            Self::Protocol(_) => "codexProtocolError",
            Self::Timeout { .. } => "codexRequestTimeout",
            Self::Rpc { .. } => "codexRpcError",
            Self::InvalidAttachment(_) => "invalidAttachment",
            Self::FileSystem(_) => "fileSystemError",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}

impl From<AppError> for CommandError {
    fn from(error: AppError) -> Self {
        Self {
            code: error.code(),
            message: error.to_string(),
        }
    }
}

pub type CommandResult<T> = Result<T, CommandError>;
