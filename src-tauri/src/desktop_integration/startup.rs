use std::ffi::OsStr;

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

use crate::error::AppError;

pub const MINIMIZED_STARTUP_ARGUMENT: &str = "--windows-startup-minimized";

pub fn is_minimized_launch() -> bool {
    std::env::args_os()
        .skip(1)
        .any(|argument| argument == OsStr::new(MINIMIZED_STARTUP_ARGUMENT))
}

pub fn synchronize(app: &AppHandle, enabled: bool) -> Result<(), AppError> {
    let manager = app.autolaunch();
    let is_enabled = registration_enabled(app)?;

    if enabled == is_enabled {
        return Ok(());
    }

    if enabled {
        manager
            .enable()
            .map_err(|error| AppError::State(format!("could not enable Windows startup: {error}")))
    } else {
        manager
            .disable()
            .map_err(|error| AppError::State(format!("could not disable Windows startup: {error}")))
    }
}

pub fn registration_enabled(app: &AppHandle) -> Result<bool, AppError> {
    app.autolaunch().is_enabled().map_err(|error| {
        AppError::State(format!(
            "could not inspect Windows startup registration: {error}"
        ))
    })
}
