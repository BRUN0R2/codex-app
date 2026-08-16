pub(crate) mod preferences;
mod startup;
mod tray;
mod window_lifecycle;

pub use preferences::ApplicationPreferencesState;
pub use startup::MINIMIZED_STARTUP_ARGUMENT;
pub use tray::setup_tray_icon;
pub use window_lifecycle::{apply_initial_window_state, handle_main_window_event};
