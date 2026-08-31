pub(crate) mod menu;
pub(crate) mod preferences;
mod startup;
mod tray;
mod window_lifecycle;

use tauri::WebviewWindow;

use crate::error::AppError;

pub use menu::ApplicationMenuState;
pub use preferences::ApplicationPreferencesState;
pub use startup::MINIMIZED_STARTUP_ARGUMENT;
pub use tray::setup_tray_icon;
pub use window_lifecycle::{apply_initial_window_state, handle_main_window_event};

pub(crate) fn restore_main_window(window: &WebviewWindow) -> Result<(), AppError> {
    window
        .show()
        .and_then(|()| window.unminimize())
        .and_then(|()| window.set_focus())
        .map_err(|error| AppError::State(error.to_string()))
}
