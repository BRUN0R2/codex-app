use std::sync::mpsc as std_mpsc;
use std::thread;
use std::time::Duration;

use super::value::value_to_error_text;
use super::{RuntimeCommand, RuntimeState};

const MAX_TIMERS: usize = 64;
const MAX_TIMER_DELAY_MS: u64 = 5 * 60 * 1_000;

pub(super) struct ScheduledTimeout {
    callback: v8::Global<v8::Function>,
    cancellation: std_mpsc::SyncSender<()>,
}

impl Drop for ScheduledTimeout {
    fn drop(&mut self) {
        let _ = self.cancellation.try_send(());
    }
}

pub(super) fn schedule(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
) -> Result<u64, String> {
    let callback = args.get(0);
    if !callback.is_function() {
        return Err("setTimeout expects a function callback".into());
    }
    let callback = v8::Local::<v8::Function>::try_from(callback)
        .map_err(|_| "setTimeout expects a function callback".to_string())?;
    let delay_ms = args
        .get(1)
        .number_value(scope)
        .map(normalize_delay_ms)
        .unwrap_or(0);
    let callback = v8::Global::new(scope, callback);
    let (timeout_id, runtime_command_tx) = {
        let state = scope
            .get_slot_mut::<RuntimeState>()
            .ok_or_else(|| "runtime state unavailable".to_string())?;
        if state.pending_timeouts.len() >= MAX_TIMERS {
            return Err(format!(
                "setTimeout limit of {MAX_TIMERS} active timers exceeded"
            ));
        }
        let timeout_id = state.next_timeout_id;
        state.next_timeout_id = state
            .next_timeout_id
            .checked_add(1)
            .ok_or_else(|| "timer id space exhausted".to_string())?;
        (timeout_id, state.runtime_command_tx.clone())
    };
    let (cancellation, cancellation_rx) = std_mpsc::sync_channel(1);
    thread::Builder::new()
        .name("code-mode-timer".into())
        .spawn(move || {
            if matches!(
                cancellation_rx.recv_timeout(Duration::from_millis(delay_ms)),
                Err(std_mpsc::RecvTimeoutError::Timeout)
            ) {
                let _ = runtime_command_tx.send(RuntimeCommand::TimeoutFired { id: timeout_id });
            }
        })
        .map_err(|error| format!("failed to start Code Mode timer: {error}"))?;
    scope
        .get_slot_mut::<RuntimeState>()
        .ok_or_else(|| "runtime state unavailable".to_string())?
        .pending_timeouts
        .insert(
            timeout_id,
            ScheduledTimeout {
                callback,
                cancellation,
            },
        );
    Ok(timeout_id)
}

pub(super) fn clear(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
) -> Result<(), String> {
    let Some(timeout_id) = timeout_id_from_args(scope, args)? else {
        return Ok(());
    };
    let state = scope
        .get_slot_mut::<RuntimeState>()
        .ok_or_else(|| "runtime state unavailable".to_string())?;
    state.pending_timeouts.remove(&timeout_id);
    Ok(())
}

pub(super) fn invoke(scope: &mut v8::PinScope<'_, '_>, timeout_id: u64) -> Result<(), String> {
    let timeout = scope
        .get_slot_mut::<RuntimeState>()
        .ok_or_else(|| "runtime state unavailable".to_string())?
        .pending_timeouts
        .remove(&timeout_id);
    let Some(timeout) = timeout else {
        return Ok(());
    };
    let try_catch = std::pin::pin!(v8::TryCatch::new(scope));
    let mut try_catch = try_catch.init();
    let callback = v8::Local::new(&try_catch, &timeout.callback);
    let receiver = v8::undefined(&try_catch).into();
    let _ = callback.call(&try_catch, receiver, &[]);
    if try_catch.has_caught() {
        return Err(try_catch
            .exception()
            .map(|exception| value_to_error_text(&mut try_catch, exception))
            .unwrap_or_else(|| "unknown Code Mode timer error".to_string()));
    }
    Ok(())
}

fn timeout_id_from_args(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
) -> Result<Option<u64>, String> {
    if args.length() == 0 || args.get(0).is_null_or_undefined() {
        return Ok(None);
    }
    let Some(timeout_id) = args.get(0).number_value(scope) else {
        return Err("clearTimeout expects a numeric timeout id".into());
    };
    if !timeout_id.is_finite() || timeout_id <= 0.0 {
        return Ok(None);
    }
    Ok(Some(timeout_id.trunc().min(u64::MAX as f64) as u64))
}

fn normalize_delay_ms(delay_ms: f64) -> u64 {
    if !delay_ms.is_finite() || delay_ms <= 0.0 {
        0
    } else {
        (delay_ms.trunc().min(u64::MAX as f64) as u64).min(MAX_TIMER_DELAY_MS)
    }
}
