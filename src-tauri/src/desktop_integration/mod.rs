mod lifecycle;
pub(crate) mod menu;
pub(crate) mod preferences;
mod startup;
mod tray;
mod window_lifecycle;

use std::{sync::mpsc::sync_channel, thread};

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use crate::{
    engine::{EngineManager, RuntimeDiagnosticSubsystem},
    error::AppError,
};

const MAIN_WINDOW_LABEL: &str = "main";

pub use lifecycle::DesktopIntegrationLifecycle;
pub use menu::ApplicationMenuState;
pub use preferences::ApplicationPreferencesState;
pub use startup::MINIMIZED_STARTUP_ARGUMENT;
pub use tray::setup_tray_icon;
pub use window_lifecycle::{apply_initial_window_state, handle_main_window_event};

pub(crate) fn restore_main_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), AppError> {
    let (result_sender, result_receiver) = sync_channel(1);
    let target = window.clone();

    window
        .run_on_main_thread(move || {
            let result = restore_main_window_on_event_loop(&target);
            if result_sender.send(result).is_err() {
                eprintln!("main window restore result could not be delivered");
            }
        })
        .map_err(|error| {
            AppError::State(format!("could not schedule main window restore: {error}"))
        })?;

    result_receiver.recv().map_err(|error| {
        AppError::State(format!("main window restore did not complete: {error}"))
    })?
}

pub(crate) fn schedule_main_window_restore(app: &AppHandle) -> Result<(), AppError> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| AppError::State("main window is unavailable".to_string()))?;
    let diagnostic_app = app.clone();

    thread::Builder::new()
        .name("codex-window-restore".to_string())
        .spawn(move || {
            if let Err(error) = restore_main_window(&window) {
                report_window_restore_error(&diagnostic_app, error);
            }
        })
        .map(|_| ())
        .map_err(|error| {
            AppError::State(format!("could not schedule main window restore: {error}"))
        })
}

fn restore_main_window_on_event_loop<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), AppError> {
    window
        .unminimize()
        .and_then(|()| window.show())
        .and_then(|()| window.set_focus())
        .map_err(|error| AppError::State(error.to_string()))
}

fn report_window_restore_error(app: &AppHandle, error: AppError) {
    app.state::<EngineManager>().report_runtime_error(
        app,
        RuntimeDiagnosticSubsystem::Window,
        format!("Main window restore failed: {error}"),
    );
}

#[cfg(test)]
mod tests {
    use std::thread;

    use tauri::{WebviewUrl, WebviewWindowBuilder};

    use super::restore_main_window;

    #[test]
    fn restores_window_through_the_runtime_main_thread() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock application should build");
        let window = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .expect("mock main window should build");

        let restore = thread::spawn(move || {
            let result = restore_main_window(&window);
            window.close().expect("mock main window should close");
            result
        });

        app.run(|_, _| {});

        restore
            .join()
            .expect("window restore worker should finish")
            .expect("window restore should complete on the runtime main thread");
    }
}
