use thiserror::Error;

use crate::error::AppError;

#[derive(Debug, Error)]
pub(super) enum AuthError {
    #[error("a ChatGPT login is already in progress")]
    LoginInProgress,
    #[error("a ChatGPT account is already connected; sign out before connecting another account")]
    AlreadyAuthenticated,
    #[error("the ChatGPT login was cancelled")]
    LoginCancelled,
    #[error("the ChatGPT login did not finish within ten minutes")]
    LoginTimedOut,
    #[error("the local OAuth callback is unavailable on ports 1455 and 1457")]
    CallbackUnavailable,
    #[error("invalid OAuth callback: {0}")]
    InvalidCallback(String),
    #[error("ChatGPT OAuth request failed: {0}")]
    OAuth(String),
    #[error("invalid ChatGPT token data: {0}")]
    InvalidToken(String),
    #[error("secure credential storage failed: {0}")]
    CredentialStorage(String),
    #[cfg(not(windows))]
    #[error("native ChatGPT authentication requires Windows Credential Manager")]
    UnsupportedPlatform,
    #[error("native authentication task failed: {0}")]
    Task(String),
}

impl From<AuthError> for AppError {
    fn from(error: AuthError) -> Self {
        Self::Auth(error.to_string())
    }
}
