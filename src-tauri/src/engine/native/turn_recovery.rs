use std::time::Duration;

use tauri::AppHandle;

use super::NativeEngineInner;
use super::agent::TurnRun;
use super::text::format_duration;
use crate::engine::DiagnosticStream;
use crate::error::AppError;

pub(super) const DEFAULT_RETRY_AFTER_SECONDS: u64 = 60;
pub(super) const MAX_AUTOMATIC_RATE_LIMIT_WAIT_SECONDS: u64 = 7 * 24 * 60 * 60;
pub(super) const MAX_AUTOMATIC_PROVIDER_RETRY_DELAY_SECONDS: u64 = 60;
const MAX_BACKOFF_EXPONENT: u32 = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TurnRecoveryDecision {
    RateLimit(Duration),
    Transient(Duration),
}

pub(super) fn classify(
    error: &AppError,
    transient_failure_count: &mut u32,
) -> Option<TurnRecoveryDecision> {
    if let AppError::RateLimited {
        retry_after_seconds,
        ..
    } = error
    {
        return Some(TurnRecoveryDecision::RateLimit(automatic_rate_limit_wait(
            retry_after_seconds.unwrap_or(DEFAULT_RETRY_AFTER_SECONDS),
        )));
    }
    if error.is_transient() {
        *transient_failure_count = transient_failure_count.saturating_add(1);
        let wait = error
            .retry_after_seconds()
            .map(|seconds| {
                Duration::from_secs(seconds.clamp(1, MAX_AUTOMATIC_PROVIDER_RETRY_DELAY_SECONDS))
            })
            .unwrap_or_else(|| automatic_provider_retry_wait(*transient_failure_count));
        return Some(TurnRecoveryDecision::Transient(wait));
    }
    None
}

pub(super) async fn wait_for_retry(
    inner: &NativeEngineInner,
    app: &AppHandle,
    run: &mut TurnRun,
    error: &AppError,
    decision: TurnRecoveryDecision,
) -> bool {
    let (message, wait, finished_message) = match decision {
        TurnRecoveryDecision::RateLimit(wait) => (
            format!(
                "Provider usage limit reached; keeping the turn active and retrying in {}.",
                format_duration(wait.as_secs())
            ),
            wait,
            Some("Provider usage limit wait finished; retrying the active turn."),
        ),
        TurnRecoveryDecision::Transient(wait) => (
            format!(
                "Transient provider failure; keeping the turn active and retrying in {}: {error}",
                format_duration(wait.as_secs())
            ),
            wait,
            None,
        ),
    };
    inner.emit_diagnostic(app, DiagnosticStream::Runtime, message);
    if *run.cancellation.borrow() {
        return false;
    }

    let sleep = tokio::time::sleep(wait);
    tokio::pin!(sleep);
    loop {
        tokio::select! {
            _ = &mut sleep => {
                if let Some(finished) = finished_message {
                    inner.emit_diagnostic(app, DiagnosticStream::Runtime, finished.into());
                }
                return true;
            }
            changed = run.cancellation.changed() => {
                if changed.is_err() || *run.cancellation.borrow() {
                    return false;
                }
            }
        }
    }
}

pub(super) fn automatic_rate_limit_wait(retry_after_seconds: u64) -> Duration {
    Duration::from_secs(retry_after_seconds.clamp(1, MAX_AUTOMATIC_RATE_LIMIT_WAIT_SECONDS))
}

pub(super) fn automatic_provider_retry_wait(failure_count: u32) -> Duration {
    let exponent = failure_count.saturating_sub(1).min(MAX_BACKOFF_EXPONENT);
    Duration::from_secs(
        1u64.checked_shl(exponent)
            .unwrap_or(u64::MAX)
            .min(MAX_AUTOMATIC_PROVIDER_RETRY_DELAY_SECONDS),
    )
}
