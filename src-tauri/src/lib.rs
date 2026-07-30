mod attachments;
mod codex;
mod commands;
mod error;

use codex::CodexRuntime;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(CodexRuntime::default())
        .invoke_handler(tauri::generate_handler![
            attachments::attachment_inspect,
            attachments::attachment_save_pasted_image,
            commands::codex_runtime_start,
            commands::codex_account_read,
            commands::codex_login_chatgpt,
            commands::codex_logout,
            commands::codex_thread_start,
            commands::codex_turn_start,
            commands::codex_turn_interrupt,
            commands::codex_config_read,
            commands::codex_config_write,
            commands::codex_config_batch_write,
            commands::codex_model_list,
            commands::codex_server_request_respond,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Codex App");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let runtime = app_handle.state::<CodexRuntime>();
            tauri::async_runtime::block_on(runtime.stop());
        }
    });
}
