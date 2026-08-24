use tauri::{
    AppHandle, Manager,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use crate::engine::{EngineManager, RuntimeDiagnosticSubsystem};
use crate::error::AppError;

const MAIN_WINDOW_LABEL: &str = "main";
const SHOW_MENU_ITEM_ID: &str = "show-main-window";
const QUIT_MENU_ITEM_ID: &str = "quit-codex-app";

pub fn setup_tray_icon(app: &AppHandle) -> Result<(), AppError> {
    let show_item = MenuItem::with_id(
        app,
        SHOW_MENU_ITEM_ID,
        "Abrir Codex App",
        true,
        None::<&str>,
    )
    .map_err(runtime_error)?;
    let quit_item = MenuItem::with_id(app, QUIT_MENU_ITEM_ID, "Sair", true, None::<&str>)
        .map_err(runtime_error)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item]).map_err(runtime_error)?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| AppError::State("tray icon is unavailable".to_string()))?;

    TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .icon(icon)
        .tooltip("Codex App")
        .on_tray_icon_event(|tray, event| {
            if is_restore_click(&event) {
                restore_main_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW_MENU_ITEM_ID => restore_main_window(app),
            QUIT_MENU_ITEM_ID => app.exit(0),
            _ => {}
        })
        .build(app)
        .map_err(runtime_error)?;

    Ok(())
}

fn is_restore_click(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    )
}

fn restore_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        report_runtime_error(
            app,
            "Tray restore failed: main window is unavailable.".into(),
        );
        return;
    };

    if let Err(error) = super::restore_main_window(&window) {
        report_runtime_error(app, format!("Tray restore failed: {error}"));
    }
}

fn report_runtime_error(app: &AppHandle, message: String) {
    app.state::<EngineManager>().report_runtime_error(
        app,
        RuntimeDiagnosticSubsystem::Window,
        message,
    );
}

fn runtime_error(error: tauri::Error) -> AppError {
    AppError::State(error.to_string())
}
