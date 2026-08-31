use std::sync::{Mutex, MutexGuard};

use serde::Deserialize;
use tauri::{
    AppHandle, Manager, State, Wry,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
};
use tauri_plugin_dialog::DialogExt as _;

use crate::error::{AppError, CommandResult};

const MAX_MENU_LABEL_CHARACTERS: usize = 128;
const MAX_ABOUT_BODY_CHARACTERS: usize = 512;
const VERSION_PLACEHOLDER: &str = "{version}";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationMenuTranslation {
    file: String,
    new_chat: String,
    open_app: String,
    quit: String,
    edit: String,
    undo: String,
    redo: String,
    cut: String,
    copy: String,
    paste: String,
    select_all: String,
    view: String,
    toggle_sidebar: String,
    reload: String,
    full_screen: String,
    minimize: String,
    maximize: String,
    close_window: String,
    help: String,
    settings: String,
    about: String,
    about_title: String,
    about_body: String,
}

impl ApplicationMenuTranslation {
    fn english() -> Self {
        Self {
            file: "File".into(),
            new_chat: "New chat".into(),
            open_app: "Open Codex App".into(),
            quit: "Quit".into(),
            edit: "Edit".into(),
            undo: "Undo".into(),
            redo: "Redo".into(),
            cut: "Cut".into(),
            copy: "Copy".into(),
            paste: "Paste".into(),
            select_all: "Select all".into(),
            view: "View".into(),
            toggle_sidebar: "Toggle sidebar".into(),
            reload: "Reload".into(),
            full_screen: "Full screen".into(),
            minimize: "Minimize".into(),
            maximize: "Maximize".into(),
            close_window: "Close window".into(),
            help: "Help".into(),
            settings: "Settings".into(),
            about: "About Codex App".into(),
            about_title: "About Codex App".into(),
            about_body: "Codex App {version} — native desktop client for Codex.".into(),
        }
    }

    fn validate(self) -> Result<Self, AppError> {
        for (field, value) in [
            ("file", self.file.as_str()),
            ("newChat", self.new_chat.as_str()),
            ("openApp", self.open_app.as_str()),
            ("quit", self.quit.as_str()),
            ("edit", self.edit.as_str()),
            ("undo", self.undo.as_str()),
            ("redo", self.redo.as_str()),
            ("cut", self.cut.as_str()),
            ("copy", self.copy.as_str()),
            ("paste", self.paste.as_str()),
            ("selectAll", self.select_all.as_str()),
            ("view", self.view.as_str()),
            ("toggleSidebar", self.toggle_sidebar.as_str()),
            ("reload", self.reload.as_str()),
            ("fullScreen", self.full_screen.as_str()),
            ("minimize", self.minimize.as_str()),
            ("maximize", self.maximize.as_str()),
            ("closeWindow", self.close_window.as_str()),
            ("help", self.help.as_str()),
            ("settings", self.settings.as_str()),
            ("about", self.about.as_str()),
            ("aboutTitle", self.about_title.as_str()),
        ] {
            validate_text(field, value, MAX_MENU_LABEL_CHARACTERS)?;
        }
        validate_text("aboutBody", &self.about_body, MAX_ABOUT_BODY_CHARACTERS)?;
        let placeholder_count = self.about_body.matches(VERSION_PLACEHOLDER).count();
        let remaining = self.about_body.replace(VERSION_PLACEHOLDER, "");
        if placeholder_count != 1 || remaining.contains(['{', '}']) {
            return Err(AppError::Protocol(
                "application menu aboutBody must contain exactly the {version} placeholder"
                    .to_string(),
            ));
        }
        Ok(self)
    }
}

#[derive(Debug)]
pub struct ApplicationMenuState {
    translation: Mutex<ApplicationMenuTranslation>,
}

impl Default for ApplicationMenuState {
    fn default() -> Self {
        Self {
            translation: Mutex::new(ApplicationMenuTranslation::english()),
        }
    }
}

impl ApplicationMenuState {
    fn lock(&self) -> Result<MutexGuard<'_, ApplicationMenuTranslation>, AppError> {
        self.translation
            .lock()
            .map_err(|_| AppError::State("application menu translation is unavailable".into()))
    }
}

pub fn build_default(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    build(app, &ApplicationMenuTranslation::english())
}

fn build(app: &AppHandle, translation: &ApplicationMenuTranslation) -> tauri::Result<Menu<Wry>> {
    let new_chat = MenuItem::with_id(
        app,
        "new-thread",
        &translation.new_chat,
        true,
        Some("Ctrl+N"),
    )?;
    let quit = MenuItem::with_id(app, "quit", &translation.quit, true, None::<&str>)?;
    let file_separator = PredefinedMenuItem::separator(app)?;
    let file = Submenu::with_id_and_items(
        app,
        "file",
        &translation.file,
        true,
        &[&new_chat, &file_separator, &quit],
    )?;

    let undo = PredefinedMenuItem::undo(app, Some(translation.undo.as_str()))?;
    let redo = PredefinedMenuItem::redo(app, Some(translation.redo.as_str()))?;
    let cut = PredefinedMenuItem::cut(app, Some(translation.cut.as_str()))?;
    let copy = PredefinedMenuItem::copy(app, Some(translation.copy.as_str()))?;
    let paste = PredefinedMenuItem::paste(app, Some(translation.paste.as_str()))?;
    let select_all = PredefinedMenuItem::select_all(app, Some(translation.select_all.as_str()))?;
    let edit_separator = PredefinedMenuItem::separator(app)?;
    let edit = Submenu::with_id_and_items(
        app,
        "edit",
        &translation.edit,
        true,
        &[
            &undo,
            &redo,
            &edit_separator,
            &cut,
            &copy,
            &paste,
            &select_all,
        ],
    )?;

    let toggle_sidebar = MenuItem::with_id(
        app,
        "toggle-sidebar",
        &translation.toggle_sidebar,
        true,
        Some("Ctrl+B"),
    )?;
    let reload = MenuItem::with_id(app, "reload", &translation.reload, true, Some("Ctrl+R"))?;
    let full_screen = PredefinedMenuItem::fullscreen(app, Some(translation.full_screen.as_str()))?;
    let minimize = PredefinedMenuItem::minimize(app, Some(translation.minimize.as_str()))?;
    let maximize = PredefinedMenuItem::maximize(app, Some(translation.maximize.as_str()))?;
    let close_window =
        PredefinedMenuItem::close_window(app, Some(translation.close_window.as_str()))?;
    let view_separator = PredefinedMenuItem::separator(app)?;
    let view = Submenu::with_id_and_items(
        app,
        "view",
        &translation.view,
        true,
        &[
            &toggle_sidebar,
            &reload,
            &view_separator,
            &full_screen,
            &minimize,
            &maximize,
            &close_window,
        ],
    )?;

    let settings = MenuItem::with_id(app, "settings", &translation.settings, true, Some("Ctrl+,"))?;
    let about = MenuItem::with_id(app, "about", &translation.about, true, None::<&str>)?;
    let help =
        Submenu::with_id_and_items(app, "help", &translation.help, true, &[&settings, &about])?;

    Menu::with_items(app, &[&file, &edit, &view, &help])
}

#[tauri::command(rename_all = "camelCase")]
pub fn application_menu_update(
    app: AppHandle,
    state: State<'_, ApplicationMenuState>,
    translation: ApplicationMenuTranslation,
) -> CommandResult<()> {
    let translation = translation.validate()?;
    let menu = build(&app, &translation).map_err(|error| {
        AppError::State(format!("could not build the application menu: {error}"))
    })?;
    let mut current = state.lock()?;
    let previous_menu = app.set_menu(menu).map_err(|error| {
        AppError::State(format!("could not replace the application menu: {error}"))
    })?;
    if let Err(tray_error) = super::tray::replace_menu(
        &app,
        translation.open_app.as_str(),
        translation.quit.as_str(),
    ) {
        if let Some(previous_menu) = previous_menu
            && let Err(rollback_error) = app.set_menu(previous_menu)
        {
            return Err(AppError::State(format!(
                "could not replace the tray menu ({tray_error}); application menu rollback also failed ({rollback_error})"
            ))
            .into());
        }
        return Err(tray_error.into());
    }
    *current = translation;
    Ok(())
}

pub fn show_about_dialog(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ApplicationMenuState>();
    let translation = state.lock().map_err(|error| error.to_string())?.clone();
    let body = translation
        .about_body
        .replace(VERSION_PLACEHOLDER, env!("CARGO_PKG_VERSION"));
    app.dialog()
        .message(body)
        .title(translation.about_title)
        .show(|_| {});
    Ok(())
}

fn validate_text(field: &str, value: &str, maximum_characters: usize) -> Result<(), AppError> {
    let character_count = value.chars().count();
    if character_count == 0
        || character_count > maximum_characters
        || value.chars().any(char::is_control)
    {
        return Err(AppError::Protocol(format!(
            "application menu {field} must contain between 1 and {maximum_characters} non-control characters"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::ApplicationMenuTranslation;

    #[test]
    fn accepts_the_complete_english_translation() {
        assert!(ApplicationMenuTranslation::english().validate().is_ok());
    }

    #[test]
    fn rejects_missing_or_ambiguous_version_placeholders() {
        let mut missing = ApplicationMenuTranslation::english();
        missing.about_body = "Codex App".into();
        assert!(missing.validate().is_err());

        let mut duplicated = ApplicationMenuTranslation::english();
        duplicated.about_body = "Codex App {version} ({version})".into();
        assert!(duplicated.validate().is_err());
    }

    #[test]
    fn rejects_control_characters_and_oversized_labels() {
        let mut control = ApplicationMenuTranslation::english();
        control.file = "File\nMenu".into();
        assert!(control.validate().is_err());

        let mut oversized = ApplicationMenuTranslation::english();
        oversized.help = "x".repeat(129);
        assert!(oversized.validate().is_err());
    }
}
