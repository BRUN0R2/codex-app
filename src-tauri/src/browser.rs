use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent, Webview, WebviewBuilder};
use tauri::{
    AppHandle, Emitter as _, LogicalPosition, LogicalSize, Manager as _, Position, Rect, Size,
    State, WebviewUrl,
};
use url::Url;

use crate::command_validation::validate_protocol_id;
use crate::engine::{EngineManager, OperationAck, RuntimeDiagnosticSubsystem};
use crate::error::{AppError, CommandResult};

pub const BROWSER_STATE_EVENT: &str = "browser://state";
pub const BROWSER_NEW_WINDOW_EVENT: &str = "browser://new-window";

const MAIN_WINDOW_LABEL: &str = "main";
const MAX_BROWSER_TABS: usize = 16;
const MAX_BROWSER_URL_BYTES: usize = 16_384;
const MAX_BROWSER_TITLE_CHARS: usize = 512;
const MIN_BROWSER_WIDTH: f64 = 280.0;
const MIN_BROWSER_HEIGHT: f64 = 180.0;
const MAX_BROWSER_SURFACE_DIMENSION: f64 = 16_384.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabSnapshot {
    browser_tab_id: String,
    conversation_id: String,
    url: String,
    title: Option<String>,
    can_go_back: bool,
    can_go_forward: bool,
    is_loading: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserNewWindowNotification {
    browser_tab_id: String,
    conversation_id: String,
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserTabCreateRequest {
    browser_tab_id: String,
    conversation_id: String,
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserTabRequest {
    browser_tab_id: String,
    conversation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserTabNavigateRequest {
    browser_tab_id: String,
    conversation_id: String,
    url: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSurfaceBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSurfaceSyncRequest {
    conversation_id: Option<String>,
    active_browser_tab_id: Option<String>,
    bounds: Option<BrowserSurfaceBounds>,
    visible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingNavigation {
    History(usize),
    Push,
    Reload,
}

#[derive(Debug)]
struct BrowserHistory {
    entries: Vec<Url>,
    index: usize,
    pending: Option<PendingNavigation>,
}

impl BrowserHistory {
    fn new(url: Url) -> Self {
        Self {
            entries: vec![url],
            index: 0,
            pending: None,
        }
    }

    fn current(&self) -> &Url {
        &self.entries[self.index]
    }

    fn can_go_back(&self) -> bool {
        self.index > 0
    }

    fn can_go_forward(&self) -> bool {
        self.index + 1 < self.entries.len()
    }

    fn prepare_push(&mut self) {
        self.pending = Some(PendingNavigation::Push);
    }

    fn prepare_reload(&mut self) {
        self.pending = Some(PendingNavigation::Reload);
    }

    fn prepare_back(&mut self) -> Option<Url> {
        let target = self.index.checked_sub(1)?;
        self.pending = Some(PendingNavigation::History(target));
        self.entries.get(target).cloned()
    }

    fn prepare_forward(&mut self) -> Option<Url> {
        let target = self.index + 1;
        let url = self.entries.get(target)?.clone();
        self.pending = Some(PendingNavigation::History(target));
        Some(url)
    }

    fn cancel_pending(&mut self) {
        self.pending = None;
    }

    fn finish(&mut self, url: Url) {
        match self.pending.take() {
            Some(PendingNavigation::History(target)) => {
                if let Some(entry) = self.entries.get_mut(target) {
                    *entry = url;
                    self.index = target;
                }
            }
            Some(PendingNavigation::Reload) => {
                self.entries[self.index] = url;
            }
            Some(PendingNavigation::Push) | None => {
                if self.current() == &url {
                    return;
                }
                self.entries.truncate(self.index + 1);
                self.entries.push(url);
                self.index = self.entries.len() - 1;
            }
        }
    }
}

struct BrowserTabRecord {
    conversation_id: String,
    history: BrowserHistory,
    is_loading: bool,
    title: Option<String>,
    visible_url: Url,
    webview: Webview,
}

impl BrowserTabRecord {
    fn snapshot(&self, browser_tab_id: &str) -> BrowserTabSnapshot {
        BrowserTabSnapshot {
            browser_tab_id: browser_tab_id.to_string(),
            conversation_id: self.conversation_id.clone(),
            url: self.visible_url.as_str().to_string(),
            title: self.title.clone(),
            can_go_back: self.history.can_go_back(),
            can_go_forward: self.history.can_go_forward(),
            is_loading: self.is_loading,
        }
    }
}

#[derive(Default)]
struct BrowserRuntimeState {
    creating: HashSet<String>,
    tabs: HashMap<String, BrowserTabRecord>,
}

#[derive(Clone, Default)]
pub struct BrowserManager {
    runtime: Arc<Mutex<BrowserRuntimeState>>,
}

impl BrowserManager {
    fn create_tab(
        &self,
        app: &AppHandle,
        conversation_id: String,
        browser_tab_id: String,
        url: Url,
    ) -> Result<BrowserTabSnapshot, AppError> {
        {
            let mut runtime = self.runtime.lock();
            if let Some(tab) = runtime.tabs.get(&browser_tab_id) {
                if tab.conversation_id != conversation_id {
                    return Err(AppError::State(
                        "browser tab id belongs to another conversation".into(),
                    ));
                }
                return Ok(tab.snapshot(&browser_tab_id));
            }
            if !runtime.creating.insert(browser_tab_id.clone()) {
                return Err(AppError::State("browser tab id is already active".into()));
            }
            if runtime.tabs.len() + runtime.creating.len() > MAX_BROWSER_TABS {
                runtime.creating.remove(&browser_tab_id);
                return Err(AppError::State(format!(
                    "the in-app browser accepts at most {MAX_BROWSER_TABS} tabs"
                )));
            }
        }

        let creation = (|| {
            let window = app.get_window(MAIN_WINDOW_LABEL).ok_or_else(|| {
                AppError::State("main window is unavailable for the in-app browser".into())
            })?;
            let webview_label = browser_webview_label(&browser_tab_id);
            let navigation_runtime = Arc::clone(&self.runtime);
            let navigation_app = app.clone();
            let navigation_conversation_id = conversation_id.clone();
            let navigation_tab_id = browser_tab_id.clone();
            let new_window_app = app.clone();
            let new_window_conversation_id = conversation_id.clone();
            let new_window_tab_id = browser_tab_id.clone();
            let title_runtime = Arc::clone(&self.runtime);
            let title_app = app.clone();
            let title_tab_id = browser_tab_id.clone();
            let builder = WebviewBuilder::new(webview_label, WebviewUrl::External(url.clone()))
                .focused(false)
                .zoom_hotkeys_enabled(true)
                .enable_clipboard_access()
                .disable_drag_drop_handler()
                .on_navigation(|target| validate_browser_url(target).is_ok())
                .on_new_window(move |target, _features| {
                    if validate_browser_url(&target).is_ok() {
                        emit_or_report(
                            &new_window_app,
                            BROWSER_NEW_WINDOW_EVENT,
                            BrowserNewWindowNotification {
                                browser_tab_id: new_window_tab_id.clone(),
                                conversation_id: new_window_conversation_id.clone(),
                                url: target.as_str().to_string(),
                            },
                        );
                    }
                    NewWindowResponse::Deny
                })
                .on_page_load(move |_webview, payload| {
                    handle_page_load(
                        &navigation_runtime,
                        &navigation_app,
                        &navigation_conversation_id,
                        &navigation_tab_id,
                        payload.url().clone(),
                        payload.event(),
                    );
                })
                .on_document_title_changed(move |_webview, title| {
                    let title = normalize_browser_title(&title);
                    let snapshot = {
                        let mut runtime = title_runtime.lock();
                        let Some(tab) = runtime.tabs.get_mut(&title_tab_id) else {
                            return;
                        };
                        tab.title = title;
                        tab.snapshot(&title_tab_id)
                    };
                    emit_or_report(&title_app, BROWSER_STATE_EVENT, snapshot);
                });
            let webview = window
                .add_child(
                    builder,
                    LogicalPosition::new(-10_000.0, -10_000.0),
                    LogicalSize::new(1.0, 1.0),
                )
                .map_err(|error| {
                    AppError::State(format!("could not create in-app browser tab: {error}"))
                })?;
            webview.hide().map_err(|error| {
                AppError::State(format!("could not hide new in-app browser tab: {error}"))
            })?;
            Ok::<Webview, AppError>(webview)
        })();

        let webview = match creation {
            Ok(webview) => webview,
            Err(error) => {
                self.runtime.lock().creating.remove(&browser_tab_id);
                return Err(error);
            }
        };
        let snapshot = {
            let mut runtime = self.runtime.lock();
            runtime.creating.remove(&browser_tab_id);
            let record = BrowserTabRecord {
                conversation_id,
                history: BrowserHistory::new(url.clone()),
                is_loading: true,
                title: None,
                visible_url: url,
                webview,
            };
            let snapshot = record.snapshot(&browser_tab_id);
            runtime.tabs.insert(browser_tab_id, record);
            snapshot
        };
        Ok(snapshot)
    }

    fn navigate(
        &self,
        conversation_id: &str,
        browser_tab_id: &str,
        url: Url,
    ) -> Result<BrowserTabSnapshot, AppError> {
        let (webview, previous_url) = {
            let mut runtime = self.runtime.lock();
            let tab = owned_tab_mut(&mut runtime, conversation_id, browser_tab_id)?;
            let previous_url = tab.visible_url.clone();
            tab.history.prepare_push();
            tab.visible_url = url.clone();
            tab.is_loading = true;
            (tab.webview.clone(), previous_url)
        };
        if let Err(error) = webview.navigate(url) {
            let mut runtime = self.runtime.lock();
            let tab = owned_tab_mut(&mut runtime, conversation_id, browser_tab_id)?;
            tab.history.cancel_pending();
            tab.visible_url = previous_url;
            tab.is_loading = false;
            return Err(AppError::State(format!(
                "could not navigate in-app browser tab: {error}"
            )));
        }
        self.snapshot(conversation_id, browser_tab_id)
    }

    fn move_history(
        &self,
        conversation_id: &str,
        browser_tab_id: &str,
        forward: bool,
    ) -> Result<BrowserTabSnapshot, AppError> {
        let target = {
            let mut runtime = self.runtime.lock();
            let tab = owned_tab_mut(&mut runtime, conversation_id, browser_tab_id)?;
            let target = if forward {
                tab.history.prepare_forward()
            } else {
                tab.history.prepare_back()
            };
            let Some(target) = target else {
                return Ok(tab.snapshot(browser_tab_id));
            };
            tab.visible_url = target.clone();
            tab.is_loading = true;
            (tab.webview.clone(), target)
        };
        if let Err(error) = target.0.navigate(target.1) {
            let mut runtime = self.runtime.lock();
            let tab = owned_tab_mut(&mut runtime, conversation_id, browser_tab_id)?;
            tab.history.cancel_pending();
            tab.visible_url = tab.history.current().clone();
            tab.is_loading = false;
            return Err(AppError::State(format!(
                "could not traverse in-app browser history: {error}"
            )));
        }
        self.snapshot(conversation_id, browser_tab_id)
    }

    fn reload(
        &self,
        conversation_id: &str,
        browser_tab_id: &str,
    ) -> Result<BrowserTabSnapshot, AppError> {
        let webview = {
            let mut runtime = self.runtime.lock();
            let tab = owned_tab_mut(&mut runtime, conversation_id, browser_tab_id)?;
            tab.history.prepare_reload();
            tab.is_loading = true;
            tab.webview.clone()
        };
        if let Err(error) = webview.reload() {
            let mut runtime = self.runtime.lock();
            let tab = owned_tab_mut(&mut runtime, conversation_id, browser_tab_id)?;
            tab.history.cancel_pending();
            tab.is_loading = false;
            return Err(AppError::State(format!(
                "could not reload in-app browser tab: {error}"
            )));
        }
        self.snapshot(conversation_id, browser_tab_id)
    }

    fn close(&self, conversation_id: &str, browser_tab_id: &str) -> Result<OperationAck, AppError> {
        let webview = {
            let runtime = self.runtime.lock();
            let Some(tab) = runtime.tabs.get(browser_tab_id) else {
                return Ok(OperationAck { applied: true });
            };
            if tab.conversation_id != conversation_id {
                return Err(AppError::State(
                    "browser tab does not belong to the requested conversation".into(),
                ));
            }
            tab.webview.clone()
        };
        webview.close().map_err(|error| {
            AppError::State(format!("could not close in-app browser tab: {error}"))
        })?;
        self.runtime.lock().tabs.remove(browser_tab_id);
        Ok(OperationAck { applied: true })
    }

    fn synchronize_surface(
        &self,
        conversation_id: Option<&str>,
        active_browser_tab_id: Option<&str>,
        bounds: Option<BrowserSurfaceBounds>,
        visible: bool,
    ) -> Result<OperationAck, AppError> {
        let active = if visible {
            Some((
                conversation_id.ok_or_else(|| {
                    AppError::Protocol("visible browser surface requires a conversation id".into())
                })?,
                active_browser_tab_id.ok_or_else(|| {
                    AppError::Protocol("visible browser surface requires an active tab id".into())
                })?,
                bounds.ok_or_else(|| {
                    AppError::Protocol("visible browser surface requires bounds".into())
                })?,
            ))
        } else {
            None
        };
        if let Some((conversation_id, browser_tab_id, bounds)) = active {
            validate_browser_bounds(bounds)?;
            let runtime = self.runtime.lock();
            owned_tab(&runtime, conversation_id, browser_tab_id)?;
        }
        let webviews = {
            let runtime = self.runtime.lock();
            runtime
                .tabs
                .iter()
                .map(|(tab_id, tab)| (tab_id.clone(), tab.webview.clone()))
                .collect::<Vec<_>>()
        };
        for (tab_id, webview) in webviews {
            let Some((_conversation_id, active_tab_id, bounds)) = active else {
                webview.hide().map_err(browser_surface_error)?;
                continue;
            };
            if tab_id != active_tab_id {
                webview.hide().map_err(browser_surface_error)?;
                continue;
            }
            webview
                .set_bounds(Rect {
                    position: Position::Logical(LogicalPosition::new(bounds.x, bounds.y)),
                    size: Size::Logical(LogicalSize::new(bounds.width, bounds.height)),
                })
                .map_err(browser_surface_error)?;
            webview.show().map_err(browser_surface_error)?;
        }
        Ok(OperationAck { applied: true })
    }

    fn snapshot(
        &self,
        conversation_id: &str,
        browser_tab_id: &str,
    ) -> Result<BrowserTabSnapshot, AppError> {
        let runtime = self.runtime.lock();
        Ok(owned_tab(&runtime, conversation_id, browser_tab_id)?.snapshot(browser_tab_id))
    }
}

fn owned_tab<'a>(
    runtime: &'a BrowserRuntimeState,
    conversation_id: &str,
    browser_tab_id: &str,
) -> Result<&'a BrowserTabRecord, AppError> {
    let tab = runtime
        .tabs
        .get(browser_tab_id)
        .ok_or_else(|| AppError::State("browser tab does not exist".into()))?;
    if tab.conversation_id != conversation_id {
        return Err(AppError::State(
            "browser tab does not belong to the requested conversation".into(),
        ));
    }
    Ok(tab)
}

fn owned_tab_mut<'a>(
    runtime: &'a mut BrowserRuntimeState,
    conversation_id: &str,
    browser_tab_id: &str,
) -> Result<&'a mut BrowserTabRecord, AppError> {
    let tab = runtime
        .tabs
        .get_mut(browser_tab_id)
        .ok_or_else(|| AppError::State("browser tab does not exist".into()))?;
    if tab.conversation_id != conversation_id {
        return Err(AppError::State(
            "browser tab does not belong to the requested conversation".into(),
        ));
    }
    Ok(tab)
}

fn handle_page_load(
    runtime: &Arc<Mutex<BrowserRuntimeState>>,
    app: &AppHandle,
    conversation_id: &str,
    browser_tab_id: &str,
    url: Url,
    event: PageLoadEvent,
) {
    let snapshot = {
        let mut runtime = runtime.lock();
        let Some(tab) = runtime.tabs.get_mut(browser_tab_id) else {
            return;
        };
        if tab.conversation_id != conversation_id {
            return;
        }
        tab.visible_url = url.clone();
        match event {
            PageLoadEvent::Started => tab.is_loading = true,
            PageLoadEvent::Finished => {
                tab.history.finish(url);
                tab.is_loading = false;
            }
        }
        tab.snapshot(browser_tab_id)
    };
    emit_or_report(app, BROWSER_STATE_EVENT, snapshot);
}

fn emit_or_report<T>(app: &AppHandle, event: &'static str, payload: T)
where
    T: Clone + Send + Serialize + 'static,
{
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = app.emit_to(MAIN_WINDOW_LABEL, event, payload) {
            app.state::<EngineManager>().report_runtime_error(
                &app,
                RuntimeDiagnosticSubsystem::Window,
                format!("in-app browser event delivery failed: {error}"),
            );
        }
    });
}

fn browser_webview_label(browser_tab_id: &str) -> String {
    format!("browser-{browser_tab_id}")
}

fn normalize_browser_title(title: &str) -> Option<String> {
    let title = title
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_BROWSER_TITLE_CHARS)
        .collect::<String>();
    let title = title.trim();
    (!title.is_empty()).then(|| title.to_string())
}

fn parse_browser_url(value: &str) -> Result<Url, AppError> {
    if value.is_empty()
        || value.len() > MAX_BROWSER_URL_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(AppError::Protocol(format!(
            "browser URL must contain between 1 and {MAX_BROWSER_URL_BYTES} bytes without control characters"
        )));
    }
    let url = Url::parse(value)
        .map_err(|error| AppError::Protocol(format!("browser URL is invalid: {error}")))?;
    validate_browser_url(&url)?;
    Ok(url)
}

fn validate_browser_url(url: &Url) -> Result<(), AppError> {
    let supported = matches!(url.scheme(), "http" | "https")
        || (url.scheme() == "about" && url.path() == "blank");
    if !supported || (!url.username().is_empty() || url.password().is_some()) {
        return Err(AppError::Protocol(
            "in-app browser navigation accepts only HTTP(S) URLs or about:blank without embedded credentials"
                .into(),
        ));
    }
    Ok(())
}

fn validate_browser_bounds(bounds: BrowserSurfaceBounds) -> Result<(), AppError> {
    if ![bounds.x, bounds.y, bounds.width, bounds.height]
        .into_iter()
        .all(f64::is_finite)
        || bounds.x < 0.0
        || bounds.y < 0.0
        || !(MIN_BROWSER_WIDTH..=MAX_BROWSER_SURFACE_DIMENSION).contains(&bounds.width)
        || !(MIN_BROWSER_HEIGHT..=MAX_BROWSER_SURFACE_DIMENSION).contains(&bounds.height)
    {
        return Err(AppError::Protocol(
            "in-app browser bounds are outside the supported surface".into(),
        ));
    }
    Ok(())
}

fn browser_surface_error(error: tauri::Error) -> AppError {
    AppError::State(format!(
        "could not synchronize in-app browser surface: {error}"
    ))
}

fn validate_browser_request_ids(conversation_id: &str, browser_tab_id: &str) -> CommandResult<()> {
    validate_protocol_id("browser conversation id", conversation_id)?;
    validate_protocol_id("browser tab id", browser_tab_id)
}

#[tauri::command]
pub async fn browser_tab_create(
    app: AppHandle,
    browser: State<'_, BrowserManager>,
    request: BrowserTabCreateRequest,
) -> CommandResult<BrowserTabSnapshot> {
    validate_browser_request_ids(&request.conversation_id, &request.browser_tab_id)?;
    let url = parse_browser_url(&request.url)?;
    browser
        .create_tab(&app, request.conversation_id, request.browser_tab_id, url)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn browser_tab_navigate(
    browser: State<'_, BrowserManager>,
    request: BrowserTabNavigateRequest,
) -> CommandResult<BrowserTabSnapshot> {
    validate_browser_request_ids(&request.conversation_id, &request.browser_tab_id)?;
    let url = parse_browser_url(&request.url)?;
    browser
        .navigate(&request.conversation_id, &request.browser_tab_id, url)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn browser_tab_back(
    browser: State<'_, BrowserManager>,
    request: BrowserTabRequest,
) -> CommandResult<BrowserTabSnapshot> {
    validate_browser_request_ids(&request.conversation_id, &request.browser_tab_id)?;
    browser
        .move_history(&request.conversation_id, &request.browser_tab_id, false)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn browser_tab_forward(
    browser: State<'_, BrowserManager>,
    request: BrowserTabRequest,
) -> CommandResult<BrowserTabSnapshot> {
    validate_browser_request_ids(&request.conversation_id, &request.browser_tab_id)?;
    browser
        .move_history(&request.conversation_id, &request.browser_tab_id, true)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn browser_tab_reload(
    browser: State<'_, BrowserManager>,
    request: BrowserTabRequest,
) -> CommandResult<BrowserTabSnapshot> {
    validate_browser_request_ids(&request.conversation_id, &request.browser_tab_id)?;
    browser
        .reload(&request.conversation_id, &request.browser_tab_id)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn browser_tab_close(
    browser: State<'_, BrowserManager>,
    request: BrowserTabRequest,
) -> CommandResult<OperationAck> {
    validate_browser_request_ids(&request.conversation_id, &request.browser_tab_id)?;
    browser
        .close(&request.conversation_id, &request.browser_tab_id)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn browser_surface_sync(
    browser: State<'_, BrowserManager>,
    request: BrowserSurfaceSyncRequest,
) -> CommandResult<OperationAck> {
    if let Some(conversation_id) = request.conversation_id.as_deref() {
        validate_protocol_id("browser conversation id", conversation_id)?;
    }
    if let Some(browser_tab_id) = request.active_browser_tab_id.as_deref() {
        validate_protocol_id("browser tab id", browser_tab_id)?;
    }
    browser
        .synchronize_surface(
            request.conversation_id.as_deref(),
            request.active_browser_tab_id.as_deref(),
            request.bounds,
            request.visible,
        )
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::{
        BrowserHistory, BrowserSurfaceBounds, normalize_browser_title, parse_browser_url,
        validate_browser_bounds,
    };

    #[test]
    fn browser_history_discards_forward_entries_after_new_navigation() {
        let mut history =
            BrowserHistory::new("https://example.com/one".parse().expect("valid URL"));
        history.prepare_push();
        history.finish("https://example.com/two".parse().expect("valid URL"));
        history.prepare_push();
        history.finish("https://example.com/three".parse().expect("valid URL"));
        assert_eq!(
            history.prepare_back().expect("back target").as_str(),
            "https://example.com/two"
        );
        history.finish("https://example.com/two".parse().expect("valid URL"));
        history.prepare_push();
        history.finish("https://example.com/four".parse().expect("valid URL"));

        assert!(!history.can_go_forward());
        assert_eq!(history.current().as_str(), "https://example.com/four");
    }

    #[test]
    fn browser_urls_reject_privileged_schemes_and_embedded_credentials() {
        assert!(parse_browser_url("https://example.com/path").is_ok());
        assert!(parse_browser_url("about:blank").is_ok());
        assert!(parse_browser_url("file:///C:/secret.txt").is_err());
        assert!(parse_browser_url("javascript:alert(1)").is_err());
        assert!(parse_browser_url("https://user:secret@example.com").is_err());
    }

    #[test]
    fn browser_bounds_are_finite_and_bounded() {
        assert!(
            validate_browser_bounds(BrowserSurfaceBounds {
                x: 640.0,
                y: 80.0,
                width: 620.0,
                height: 700.0,
            })
            .is_ok()
        );
        assert!(
            validate_browser_bounds(BrowserSurfaceBounds {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            })
            .is_err()
        );
    }

    #[test]
    fn remote_titles_are_sanitized_and_bounded() {
        let title = format!("Title\0{}", "x".repeat(600));
        let normalized = normalize_browser_title(&title).expect("title should remain visible");
        assert!(!normalized.contains('\0'));
        assert_eq!(normalized.chars().count(), 512);
    }
}
