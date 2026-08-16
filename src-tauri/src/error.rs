use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("authentication failed: {0}")]
    Auth(String),
    #[error("provider request failed: {0}")]
    Provider(String),
    #[error("provider connection failed: {0}")]
    Transport(String),
    #[error("provider returned HTTP {status}: {message}")]
    ProviderHttp { status: u16, message: String },
    #[error("provider rate limit reached: {message}")]
    RateLimited {
        message: String,
        retry_after_seconds: Option<u64>,
    },
    #[error("model context window exceeded: {0}")]
    ContextWindowExceeded(String),
    #[error("{operation} exceeded its time limit")]
    Timeout { operation: &'static str },
    #[error("native storage failed: {0}")]
    Storage(String),
    #[error("invalid command contract: {0}")]
    Protocol(String),
    #[error("invalid attachment: {0}")]
    InvalidAttachment(String),
    #[error("filesystem operation failed: {0}")]
    FileSystem(String),
    #[error("tool execution failed: {0}")]
    Tool(String),
    #[error("operation is not permitted: {0}")]
    Permission(String),
    #[error("operation was canceled: {0}")]
    Cancelled(String),
    #[error("engine state is invalid: {0}")]
    State(String),
}

impl AppError {
    const fn code(&self) -> &'static str {
        match self {
            Self::Auth(_) => "authFailed",
            Self::Provider(_) => "providerFailed",
            Self::Transport(_) => "providerUnavailable",
            Self::ProviderHttp { .. } => "providerHttpError",
            Self::RateLimited { .. } => "rateLimited",
            Self::ContextWindowExceeded(_) => "contextWindowExceeded",
            Self::Timeout { .. } => "operationTimeout",
            Self::Storage(_) => "storageFailed",
            Self::Protocol(_) => "invalidContract",
            Self::InvalidAttachment(_) => "invalidAttachment",
            Self::FileSystem(_) => "fileSystemFailed",
            Self::Tool(_) => "toolFailed",
            Self::Permission(_) => "permissionDenied",
            Self::Cancelled(_) => "operationCanceled",
            Self::State(_) => "invalidEngineState",
        }
    }

    const fn retryable(&self) -> bool {
        matches!(
            self,
            Self::Provider(_)
                | Self::Transport(_)
                | Self::RateLimited { .. }
                | Self::ProviderHttp {
                    status: 500..=599,
                    ..
                }
                | Self::Timeout { .. }
        )
    }

    pub(crate) const fn public_code(&self) -> &'static str {
        self.code()
    }

    pub(crate) fn from_provider_rejection(
        status: Option<u16>,
        code: Option<&str>,
        message: String,
        retry_after_seconds: Option<u64>,
    ) -> Self {
        if code == Some("context_length_exceeded") {
            Self::ContextWindowExceeded(message)
        } else if status == Some(429)
            || matches!(
                code,
                Some(
                    "insufficient_quota"
                        | "rate_limit_exceeded"
                        | "rate_limit_reached"
                        | "usage_limit_reached"
                )
            )
        {
            Self::RateLimited {
                message,
                retry_after_seconds,
            }
        } else if let Some(status) = status {
            Self::ProviderHttp { status, message }
        } else {
            Self::Provider(message)
        }
    }

    pub(crate) const fn is_transient(&self) -> bool {
        matches!(
            self,
            Self::Transport(_)
                | Self::ProviderHttp {
                    status: 500..=599,
                    ..
                }
                | Self::Timeout { .. }
        )
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl From<AppError> for CommandError {
    fn from(error: AppError) -> Self {
        Self {
            code: error.code(),
            retryable: error.retryable(),
            message: error.to_string(),
        }
    }
}

pub type CommandResult<T> = Result<T, CommandError>;

#[cfg(test)]
mod tests {
    use super::{AppError, CommandError};

    #[test]
    fn context_window_exceeded_is_explicit_and_not_retryable() {
        let error = AppError::from_provider_rejection(
            None,
            Some("context_length_exceeded"),
            "request is too large".into(),
            None,
        );
        let public = CommandError::from(error);

        assert_eq!(public.code, "contextWindowExceeded");
        assert!(!public.retryable);
    }

    #[test]
    fn usage_limit_is_retryable_and_preserves_the_reset_delay() {
        let error = AppError::from_provider_rejection(
            Some(429),
            Some("usage_limit_reached"),
            "usage limit reached".into(),
            Some(3_600),
        );
        assert!(matches!(
            &error,
            AppError::RateLimited {
                retry_after_seconds: Some(3_600),
                ..
            }
        ));
        let public = CommandError::from(error);
        assert_eq!(public.code, "rateLimited");
        assert!(public.retryable);
    }

    #[test]
    fn only_recoverable_transport_failures_are_transient() {
        assert!(AppError::Transport("connection reset".into()).is_transient());
        assert!(
            AppError::ProviderHttp {
                status: 503,
                message: "unavailable".into(),
            }
            .is_transient()
        );
        assert!(!AppError::Provider("invalid SSE event".into()).is_transient());
        assert!(
            !AppError::ProviderHttp {
                status: 400,
                message: "bad request".into(),
            }
            .is_transient()
        );
    }
}
