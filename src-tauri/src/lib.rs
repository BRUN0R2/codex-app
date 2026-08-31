#![allow(
    linker_messages,
    reason = "MSVC emits localized informational output while creating import libraries"
)]

mod attachments;
mod browser;
mod command_validation;
mod commands;
mod desktop_integration;
mod engine;
mod error;
mod process;

use desktop_integration::{ApplicationMenuState, ApplicationPreferencesState, restore_main_window};
use engine::{EngineManager, RuntimeDiagnosticSubsystem};
use tauri::{Emitter as _, Manager as _};

fn focus_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    restore_main_window(&window)
        .map_err(|error| format!("could not restore the main window: {error}"))
}

fn handle_menu_event(app: &tauri::AppHandle, event_id: &str) -> Result<(), String> {
    match event_id {
        "new-thread" => app
            .emit("menu:new-thread", ())
            .map_err(|error| format!("could not deliver the new-thread menu event: {error}")),
        "settings" => app
            .emit("menu:settings", ())
            .map_err(|error| format!("could not deliver the settings menu event: {error}")),
        "toggle-sidebar" => app
            .emit("menu:toggle-sidebar", ())
            .map_err(|error| format!("could not deliver the sidebar menu event: {error}")),
        "reload" => {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "main window is unavailable for reload".to_string())?;
            window
                .eval("window.location.reload()")
                .map_err(|error| format!("could not reload the main window: {error}"))
        }
        "about" => desktop_integration::menu::show_about_dialog(app),
        "quit" => {
            app.exit(0);
            Ok(())
        }
        _ => Ok(()),
    }
}

fn report_runtime_error(
    app: &tauri::AppHandle,
    subsystem: RuntimeDiagnosticSubsystem,
    message: String,
) {
    app.state::<EngineManager>()
        .report_runtime_error(app, subsystem, message);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(debug_assertions)]
    let browser_smoke_requested = browser::runtime_smoke_requested();
    #[cfg(not(debug_assertions))]
    let browser_smoke_requested = false;
    let mut builder = tauri::Builder::default();
    if !browser_smoke_requested {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Err(error) = focus_main_window(app) {
                report_runtime_error(app, RuntimeDiagnosticSubsystem::Window, error);
            }
        }));
    }
    let app = match builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![desktop_integration::MINIMIZED_STARTUP_ARGUMENT]),
        ))
        .plugin(tauri_plugin_opener::init())
        .menu(desktop_integration::menu::build_default)
        .on_menu_event(|app, event| {
            if let Err(error) = handle_menu_event(app, event.id().as_ref()) {
                report_runtime_error(app, RuntimeDiagnosticSubsystem::Menu, error);
            }
        })
        .manage(EngineManager::default())
        .manage(browser::BrowserManager::default())
        .setup(|app| {
            app.state::<browser::BrowserManager>()
                .initialize(app.handle())?;
            if !app.manage(ApplicationMenuState::default()) {
                return Err(crate::error::AppError::State(
                    "application menu state is already managed".to_string(),
                )
                .into());
            }
            let preferences = ApplicationPreferencesState::load(app.handle())?;
            if !app.manage(preferences) {
                return Err(crate::error::AppError::State(
                    "application preferences state is already managed".to_string(),
                )
                .into());
            }

            desktop_integration::setup_tray_icon(app.handle())?;
            let main_window = app.get_webview_window("main").ok_or_else(|| {
                crate::error::AppError::State("main window is unavailable".to_string())
            })?;
            desktop_integration::apply_initial_window_state(&main_window)?;
            #[cfg(debug_assertions)]
            browser::start_runtime_smoke_if_requested(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            attachments::attachment_inspect,
            attachments::attachment_read_image,
            attachments::attachment_save_pasted_image,
            browser::browser_tab_create,
            browser::browser_tab_navigate,
            browser::browser_tab_back,
            browser::browser_tab_forward,
            browser::browser_tab_reload,
            browser::browser_tab_close,
            browser::browser_viewport_set,
            browser::browser_surface_sync,
            desktop_integration::preferences::application_preferences_read,
            desktop_integration::preferences::application_preferences_update,
            desktop_integration::menu::application_menu_update,
            commands::application_workspace_open,
            commands::engine_start,
            commands::engine_runtime_diagnostic_report,
            commands::engine_account_read,
            commands::engine_account_profile_read,
            commands::engine_account_rate_limits_read,
            commands::engine_account_usage_resets_read,
            commands::engine_account_usage_reset_redeem,
            commands::engine_account_auto_top_up_read,
            commands::engine_account_auto_top_up_enable,
            commands::engine_account_auto_top_up_update,
            commands::engine_account_auto_top_up_disable,
            commands::engine_login_chatgpt,
            commands::engine_login_cancel,
            commands::engine_logout,
            commands::engine_thread_start,
            commands::engine_thread_list,
            commands::engine_thread_resume,
            commands::engine_thread_read,
            commands::engine_output_read,
            commands::engine_thread_set_name,
            commands::engine_thread_archive,
            commands::engine_thread_unarchive,
            commands::engine_thread_delete,
            commands::engine_thread_fork,
            commands::engine_turn_start,
            commands::engine_turn_steer,
            commands::engine_turn_interrupt,
            commands::engine_automation_list,
            commands::engine_automation_create,
            commands::engine_automation_update,
            commands::engine_automation_delete,
            commands::engine_automation_run_now,
            commands::engine_automation_run_mark_reviewed,
            commands::engine_config_update,
            commands::engine_model_list,
            commands::engine_chat_model_list,
            commands::engine_server_request_respond,
        ])
        .on_window_event(|window, event| {
            desktop_integration::handle_main_window_event(window, event);
        })
        .build(tauri::generate_context!())
    {
        Ok(app) => app,
        Err(error) => {
            eprintln!("failed to build Codex App: {error}");
            std::process::exit(1);
        }
    };

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let engine = app_handle.state::<EngineManager>();
            tauri::async_runtime::block_on(engine.stop(app_handle));
        }
    });
}
