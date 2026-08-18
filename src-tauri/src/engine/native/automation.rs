use crate::engine::{Automation, AutomationRun};
use crate::error::AppError;

pub(super) const MIN_AUTOMATION_INTERVAL_MINUTES: u32 = 5;
pub(super) const MAX_AUTOMATION_INTERVAL_MINUTES: u32 = 10_080;
pub(super) const MAX_CONCURRENT_AUTOMATION_RUNS: i64 = 2;
pub(super) const MAX_AUTOMATION_RUN_HISTORY: i64 = 500;

#[derive(Debug, Clone)]
pub(super) struct AutomationDraft {
    pub name: String,
    pub prompt: String,
    pub project_path: Option<String>,
    pub enabled: bool,
    pub interval_minutes: u32,
    pub timezone: String,
    pub timezone_offset_min: i32,
}

#[derive(Debug, Clone)]
pub(super) struct AutomationUpdate {
    pub id: String,
    pub expected_version: u64,
    pub name: String,
    pub prompt: String,
    pub project_path: Option<String>,
    pub enabled: bool,
    pub interval_minutes: u32,
    pub timezone: String,
    pub timezone_offset_min: i32,
}

#[derive(Debug, Clone)]
pub(super) struct ClaimedAutomationRun {
    pub automation: Automation,
    pub run: AutomationRun,
}

pub(super) fn next_run_from_now(now: i64, interval_minutes: u32) -> Result<i64, AppError> {
    validate_interval(interval_minutes)?;
    add_interval(now, interval_minutes)
}

pub(super) fn advance_due_run(
    previous_next_run: i64,
    now: i64,
    interval_minutes: u32,
) -> Result<i64, AppError> {
    validate_interval(interval_minutes)?;
    let interval_seconds = i64::from(interval_minutes)
        .checked_mul(60)
        .ok_or_else(|| AppError::Storage("automation interval overflow".into()))?;
    let elapsed = now.saturating_sub(previous_next_run);
    let skipped_intervals = elapsed.div_euclid(interval_seconds);
    previous_next_run
        .checked_add(
            skipped_intervals
                .checked_add(1)
                .and_then(|count| count.checked_mul(interval_seconds))
                .ok_or_else(|| AppError::Storage("automation schedule overflow".into()))?,
        )
        .ok_or_else(|| AppError::Storage("automation schedule overflow".into()))
}

pub(super) fn validate_interval(interval_minutes: u32) -> Result<(), AppError> {
    if (MIN_AUTOMATION_INTERVAL_MINUTES..=MAX_AUTOMATION_INTERVAL_MINUTES)
        .contains(&interval_minutes)
    {
        Ok(())
    } else {
        Err(AppError::Protocol(format!(
            "automation interval must be between {MIN_AUTOMATION_INTERVAL_MINUTES} and {MAX_AUTOMATION_INTERVAL_MINUTES} minutes"
        )))
    }
}

fn add_interval(now: i64, interval_minutes: u32) -> Result<i64, AppError> {
    now.checked_add(
        i64::from(interval_minutes)
            .checked_mul(60)
            .ok_or_else(|| AppError::Storage("automation interval overflow".into()))?,
    )
    .ok_or_else(|| AppError::Storage("automation schedule overflow".into()))
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_AUTOMATION_INTERVAL_MINUTES, MIN_AUTOMATION_INTERVAL_MINUTES, advance_due_run,
        next_run_from_now, validate_interval,
    };

    #[test]
    fn schedule_advances_once_without_backfilling_missed_intervals() {
        assert_eq!(
            advance_due_run(1_000, 2_001, 5).expect("schedule should advance"),
            2_200
        );
    }

    #[test]
    fn schedule_keeps_its_original_cadence_when_claimed_on_time() {
        assert_eq!(
            advance_due_run(1_000, 1_000, 15).expect("schedule should advance"),
            1_900
        );
        assert_eq!(
            next_run_from_now(1_000, 15).expect("schedule should initialize"),
            1_900
        );
    }

    #[test]
    fn interval_bounds_are_enforced() {
        assert!(validate_interval(MIN_AUTOMATION_INTERVAL_MINUTES).is_ok());
        assert!(validate_interval(MAX_AUTOMATION_INTERVAL_MINUTES).is_ok());
        assert!(validate_interval(MIN_AUTOMATION_INTERVAL_MINUTES - 1).is_err());
        assert!(validate_interval(MAX_AUTOMATION_INTERVAL_MINUTES + 1).is_err());
    }
}
