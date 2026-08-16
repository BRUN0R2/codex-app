use tauri::{Manager, WebviewWindow, Window, WindowEvent};

use crate::{
    desktop_integration::{ApplicationPreferencesState, startup},
    engine::EngineManager,
    error::AppError,
};

const MAIN_WINDOW_LABEL: &str = "main";

pub fn apply_initial_window_state(window: &WebviewWindow) -> Result<(), AppError> {
    let preferences = window
        .app_handle()
        .state::<ApplicationPreferencesState>()
        .current()?;
    let should_start_hidden = preferences.start_minimized && startup::is_minimized_launch();

    if should_start_hidden {
        window.hide().map_err(runtime_error)?;
        return Ok(());
    }

    window.show().map_err(runtime_error)?;
    window.unminimize().map_err(runtime_error)?;
    window.set_focus().map_err(runtime_error)?;
    Ok(())
}

pub fn handle_main_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }

    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };

    let preferences = window
        .app_handle()
        .state::<ApplicationPreferencesState>()
        .current();
    let has_active_turns = window
        .app_handle()
        .state::<EngineManager>()
        .has_active_turns();

    match preferences {
        Ok(preferences) if preferences.close_to_tray || has_active_turns => {
            api.prevent_close();
            if let Err(error) = window.hide() {
                eprintln!("Main window could not move to tray: {error}");
                window.app_handle().exit(1);
            }
        }
        Ok(_) => window.app_handle().exit(0),
        Err(error) => {
            eprintln!("Main window close policy is unavailable: {error}");
            window.app_handle().exit(1);
        }
    }
}

fn runtime_error(error: tauri::Error) -> AppError {
    AppError::State(error.to_string())
}
