#![allow(
    linker_messages,
    reason = "MSVC emits localized informational output while creating import libraries"
)]

mod attachments;
mod commands;
mod engine;
mod error;
mod process;

use engine::EngineManager;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let novo_chat = MenuItem::with_id(app, "new-thread", "Novo chat", true, Some("Ctrl+N"))?;
    let sair = MenuItem::with_id(app, "quit", "Sair", true, Some("Alt+F4"))?;
    let separador = PredefinedMenuItem::separator(app)?;
    let arquivo = Submenu::with_items(app, "Arquivo", true, &[&novo_chat, &separador, &sair])?;

    let desfazer = PredefinedMenuItem::undo(app, None)?;
    let refazer = PredefinedMenuItem::redo(app, None)?;
    let recortar = PredefinedMenuItem::cut(app, None)?;
    let copiar = PredefinedMenuItem::copy(app, None)?;
    let colar = PredefinedMenuItem::paste(app, None)?;
    let selecionar_tudo = PredefinedMenuItem::select_all(app, None)?;
    let editar = Submenu::with_items(
        app,
        "Editar",
        true,
        &[
            &desfazer,
            &refazer,
            &separador,
            &recortar,
            &copiar,
            &colar,
            &selecionar_tudo,
        ],
    )?;

    let alternar_sidebar = MenuItem::with_id(
        app,
        "toggle-sidebar",
        "Alternar barra lateral",
        true,
        Some("Ctrl+B"),
    )?;
    let recarregar = MenuItem::with_id(app, "reload", "Recarregar", true, Some("Ctrl+R"))?;
    let tela_cheia = PredefinedMenuItem::fullscreen(app, None)?;
    let minimizar = PredefinedMenuItem::minimize(app, None)?;
    let maximizar = PredefinedMenuItem::maximize(app, None)?;
    let fechar_janela = PredefinedMenuItem::close_window(app, None)?;
    let exibir = Submenu::with_items(
        app,
        "Exibir",
        true,
        &[
            &alternar_sidebar,
            &recarregar,
            &separador,
            &tela_cheia,
            &minimizar,
            &maximizar,
            &fechar_janela,
        ],
    )?;

    let configuracoes = MenuItem::with_id(app, "settings", "Configurações", true, Some("Ctrl+,"))?;
    let sobre = MenuItem::with_id(app, "about", "Sobre o Codex App", true, None::<&str>)?;
    let ajuda = Submenu::with_items(app, "Ajuda", true, &[&configuracoes, &sobre])?;

    Menu::with_items(app, &[&arquivo, &editar, &exibir, &ajuda])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = match tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .menu(build_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "new-thread" => {
                let _ = app.emit("menu:new-thread", ());
            }
            "settings" => {
                let _ = app.emit("menu:settings", ());
            }
            "toggle-sidebar" => {
                let _ = app.emit("menu:toggle-sidebar", ());
            }
            "reload" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.location.reload()");
                }
            }
            "about" => {
                use tauri_plugin_dialog::DialogExt;
                app.dialog()
                    .message("Codex App 0.1.0 — cliente desktop nativo para o Codex.")
                    .title("Sobre o Codex App")
                    .show(|_| {});
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .manage(EngineManager::default())
        .invoke_handler(tauri::generate_handler![
            attachments::attachment_inspect,
            attachments::attachment_read_image,
            attachments::attachment_save_pasted_image,
            commands::engine_start,
            commands::engine_account_read,
            commands::engine_account_profile_read,
            commands::engine_account_rate_limits_read,
            commands::engine_login_chatgpt,
            commands::engine_login_cancel,
            commands::engine_logout,
            commands::engine_thread_start,
            commands::engine_thread_list,
            commands::engine_thread_resume,
            commands::engine_thread_read,
            commands::engine_thread_set_name,
            commands::engine_thread_archive,
            commands::engine_thread_unarchive,
            commands::engine_thread_delete,
            commands::engine_thread_fork,
            commands::engine_thread_compact_start,
            commands::engine_turn_start,
            commands::engine_turn_steer,
            commands::engine_turn_interrupt,
            commands::engine_config_read,
            commands::engine_config_update,
            commands::engine_model_list,
            commands::engine_chat_model_list,
            commands::engine_server_request_respond,
        ])
        .build(tauri::generate_context!())
    {
        Ok(app) => app,
        Err(error) => {
            eprintln!("failed to build Codex App: {error}");
            return;
        }
    };

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let engine = app_handle.state::<EngineManager>();
            tauri::async_runtime::block_on(engine.stop(app_handle));
        }
    });
}
