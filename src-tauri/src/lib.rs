mod attachments;
mod codex;
mod commands;
mod engine;
mod error;

use engine::EngineManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(EngineManager::default())
        .invoke_handler(tauri::generate_handler![
            attachments::attachment_inspect,
            attachments::attachment_read_image,
            attachments::attachment_save_pasted_image,
            commands::engine_start,
            commands::engine_account_read,
            commands::engine_login_chatgpt,
            commands::engine_login_cancel,
            commands::engine_logout,
            commands::engine_thread_start,
            commands::engine_thread_list,
            commands::engine_thread_resume,
            commands::engine_thread_set_name,
            commands::engine_thread_archive,
            commands::engine_turn_start,
            commands::engine_turn_interrupt,
            commands::engine_config_read,
            commands::engine_config_write,
            commands::engine_config_batch_write,
            commands::engine_model_list,
            commands::engine_server_request_respond,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Codex App");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let engine = app_handle.state::<EngineManager>();
            tauri::async_runtime::block_on(engine.stop());
        }
    });
}
