use std::future::Future;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tauri::webview::Webview;
use tokio::time::{sleep, timeout};
use url::Url;
use uuid::Uuid;

use super::automation;
use super::{
    BROWSER_AGENT_ACTIVITY_EVENT, BrowserAgentActivityNotification, BrowserAutomationCapture,
    BrowserCaptureMode, BrowserManager, BrowserMouseButton, BrowserPanelDirective,
    BrowserPendingTransition, BrowserResolvedTarget, BrowserTabSnapshot, BrowserTargetSelector,
    approve_origin, emit_or_report, origin_is_approved, parse_browser_url,
};
use crate::engine::OperationAck;
use crate::error::AppError;

const DEFAULT_AGENT_URL: &str = "about:blank";
const PAGE_LOAD_TIMEOUT: Duration = Duration::from_secs(20);
const PAGE_STABILITY_DELAY: Duration = Duration::from_millis(160);
const TRANSITION_OBSERVATION_DELAY: Duration = Duration::from_millis(220);

#[derive(Debug, Clone)]
pub(crate) struct BrowserAgentCapture {
    pub tab: BrowserTabSnapshot,
    pub automation: BrowserAutomationCapture,
    pub load_ms: u64,
    pub load_timed_out: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct BrowserConversationTopology {
    pub active_browser_tab_id: Option<String>,
    pub tabs: Vec<BrowserTabSnapshot>,
}

impl BrowserManager {
    pub(crate) fn origin_is_approved(&self, conversation_id: &str, url: &Url) -> bool {
        origin_is_approved(&self.runtime.lock(), conversation_id, url)
    }

    pub(crate) fn approve_agent_origin(&self, conversation_id: &str, url: &Url) {
        approve_origin(&mut self.runtime.lock(), conversation_id, url);
    }

    pub(crate) fn topology(&self, conversation_id: &str) -> BrowserConversationTopology {
        let runtime = self.runtime.lock();
        let tabs = runtime
            .tab_order
            .get(conversation_id)
            .into_iter()
            .flatten()
            .filter_map(|browser_tab_id| {
                runtime
                    .tabs
                    .get(browser_tab_id)
                    .map(|tab| tab.snapshot(browser_tab_id))
            })
            .collect();
        BrowserConversationTopology {
            active_browser_tab_id: runtime.active_tabs.get(conversation_id).cloned(),
            tabs,
        }
    }

    pub(crate) fn announce_agent_activity(
        &self,
        app: &AppHandle,
        conversation_id: &str,
        action: &str,
        panel: BrowserPanelDirective,
    ) {
        let topology = self.topology(conversation_id);
        emit_or_report(
            app,
            BROWSER_AGENT_ACTIVITY_EVENT,
            BrowserAgentActivityNotification {
                conversation_id: conversation_id.to_string(),
                active_browser_tab_id: topology.active_browser_tab_id,
                tabs: topology.tabs,
                panel,
                action: action.to_string(),
            },
        );
    }

    pub(crate) fn ensure_active_tab(
        &self,
        app: &AppHandle,
        conversation_id: &str,
    ) -> Result<BrowserTabSnapshot, AppError> {
        if let Some(browser_tab_id) = self.active_tab_id(conversation_id) {
            return self.snapshot(conversation_id, &browser_tab_id);
        }
        let url = parse_browser_url(DEFAULT_AGENT_URL)?;
        let browser_tab_id = Uuid::now_v7().to_string();
        let snapshot = self.create_tab(
            app,
            conversation_id.to_string(),
            browser_tab_id.clone(),
            url,
        )?;
        self.set_active_tab(conversation_id, &browser_tab_id)?;
        Ok(snapshot)
    }

    pub(crate) async fn new_agent_tab(
        &self,
        app: &AppHandle,
        conversation_id: &str,
        url: Url,
    ) -> Result<(BrowserTabSnapshot, Option<BrowserPendingTransition>), AppError> {
        let browser_tab_id = Uuid::now_v7().to_string();
        {
            let mut runtime = self.runtime.lock();
            runtime.agent_interactions.insert(browser_tab_id.clone());
            runtime.pending_transitions.remove(&browser_tab_id);
        }
        let snapshot = match self.create_tab(
            app,
            conversation_id.to_string(),
            browser_tab_id.clone(),
            url,
        ) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                self.runtime
                    .lock()
                    .agent_interactions
                    .remove(&browser_tab_id);
                return Err(error);
            }
        };
        if let Err(error) = self
            .set_active_tab(conversation_id, &browser_tab_id)
            .and_then(|()| self.apply_active_surface(conversation_id))
        {
            self.finish_agent_interaction(&browser_tab_id);
            return Err(error);
        }
        let wait_result = self.wait_for_agent_interaction(&browser_tab_id).await;
        let transition = self.finish_agent_interaction(&browser_tab_id);
        wait_result?;
        Ok((snapshot, transition))
    }

    pub(crate) fn select_agent_tab(
        &self,
        conversation_id: &str,
        browser_tab_id: &str,
    ) -> Result<BrowserTabSnapshot, AppError> {
        self.set_active_tab(conversation_id, browser_tab_id)?;
        self.apply_active_surface(conversation_id)?;
        self.snapshot(conversation_id, browser_tab_id)
    }

    pub(crate) fn close_agent_tab(
        &self,
        conversation_id: &str,
        browser_tab_id: Option<&str>,
    ) -> Result<BrowserConversationTopology, AppError> {
        let browser_tab_id = match browser_tab_id {
            Some(browser_tab_id) => browser_tab_id.to_string(),
            None => self
                .active_tab_id(conversation_id)
                .ok_or_else(|| AppError::State("browser conversation has no active tab".into()))?,
        };
        self.close(conversation_id, &browser_tab_id)?;
        self.apply_active_surface(conversation_id)?;
        Ok(self.topology(conversation_id))
    }

    pub(crate) fn close_agent_browser(
        &self,
        conversation_id: &str,
        close_tabs: bool,
    ) -> Result<OperationAck, AppError> {
        if close_tabs {
            let browser_tab_ids = self
                .topology(conversation_id)
                .tabs
                .into_iter()
                .map(|tab| tab.browser_tab_id)
                .collect::<Vec<_>>();
            for browser_tab_id in browser_tab_ids {
                self.close(conversation_id, &browser_tab_id)?;
            }
        }
        self.synchronize_surface(Some(conversation_id), None, None, false)
    }

    pub(crate) async fn navigate_active(
        &self,
        app: &AppHandle,
        conversation_id: &str,
        url: Url,
    ) -> Result<Option<BrowserPendingTransition>, AppError> {
        let tab = self.ensure_active_tab(app, conversation_id)?;
        self.run_interaction(&tab, async {
            self.navigate(conversation_id, &tab.browser_tab_id, url)
                .map(|_| ())
        })
        .await
    }

    pub(crate) async fn history_active(
        &self,
        app: &AppHandle,
        conversation_id: &str,
        forward: bool,
    ) -> Result<Option<BrowserPendingTransition>, AppError> {
        let tab = self.ensure_active_tab(app, conversation_id)?;
        self.run_interaction(&tab, async {
            self.move_history(conversation_id, &tab.browser_tab_id, forward)
                .map(|_| ())
        })
        .await
    }

    pub(crate) async fn reload_active(
        &self,
        app: &AppHandle,
        conversation_id: &str,
    ) -> Result<Option<BrowserPendingTransition>, AppError> {
        let tab = self.ensure_active_tab(app, conversation_id)?;
        self.run_interaction(&tab, async {
            self.reload(conversation_id, &tab.browser_tab_id)
                .map(|_| ())
        })
        .await
    }

    pub(crate) async fn inspect_active(
        &self,
        app: &AppHandle,
        conversation_id: &str,
    ) -> Result<BrowserAgentCapture, AppError> {
        self.capture_active(app, conversation_id, BrowserCaptureMode::Snapshot)
            .await
    }

    pub(crate) async fn screenshot_active(
        &self,
        app: &AppHandle,
        conversation_id: &str,
    ) -> Result<BrowserAgentCapture, AppError> {
        self.capture_active(
            app,
            conversation_id,
            BrowserCaptureMode::SnapshotAndScreenshot,
        )
        .await
    }

    async fn capture_active(
        &self,
        app: &AppHandle,
        conversation_id: &str,
        mode: BrowserCaptureMode,
    ) -> Result<BrowserAgentCapture, AppError> {
        let tab = self.ensure_active_tab(app, conversation_id)?;
        let load_started = Instant::now();
        let load_timed_out = self
            .wait_for_page_load(conversation_id, &tab.browser_tab_id)
            .await?;
        let load_ms = elapsed_millis(load_started)?;
        sleep(PAGE_STABILITY_DELAY).await;
        let webview = self.webview(conversation_id, &tab.browser_tab_id)?;
        let automation = automation::capture(&webview, mode).await?;
        let tab = self.snapshot(conversation_id, &tab.browser_tab_id)?;
        Ok(BrowserAgentCapture {
            tab,
            automation,
            load_ms,
            load_timed_out,
        })
    }

    pub(crate) async fn resolve_active_target(
        &self,
        app: &AppHandle,
        conversation_id: &str,
        selector: &BrowserTargetSelector,
    ) -> Result<(BrowserTabSnapshot, BrowserResolvedTarget), AppError> {
        let tab = self.ensure_active_tab(app, conversation_id)?;
        let webview = self.webview(conversation_id, &tab.browser_tab_id)?;
        let target = automation::resolve_target(&webview, selector).await?;
        Ok((tab, target))
    }

    pub(crate) async fn hover_active(
        &self,
        app: &AppHandle,
        conversation_id: &str,
        selector: &BrowserTargetSelector,
    ) -> Result<Option<BrowserPendingTransition>, AppError> {
        let (tab, target) = self
            .resolve_active_target(app, conversation_id, selector)
            .await?;
        self.run_interaction(&tab, async {
            let webview = self.webview(conversation_id, &tab.browser_tab_id)?;
            automation::hover(&webview, &target).await
        })
        .await
    }

    pub(crate) async fn click_active(
        &self,
        app: &AppHandle,
        conversation_id: &str,
        selector: &BrowserTargetSelector,
        button: BrowserMouseButton,
        click_count: u8,
    ) -> Result<(BrowserResolvedTarget, Option<BrowserPendingTransition>), AppError> {
        let (tab, target) = self
            .resolve_active_target(app, conversation_id, selector)
            .await?;
        let transition = self
            .run_interaction(&tab, async {
                let webview = self.webview(conversation_id, &tab.browser_tab_id)?;
                automation::click(&webview, &target, button, click_count).await
            })
            .await?;
        Ok((target, transition))
    }

    pub(crate) async fn type_active(
        &self,
        app: &AppHandle,
        conversation_id: &str,
        selector: &BrowserTargetSelector,
        text: &str,
        replace: bool,
        submit: bool,
    ) -> Result<(BrowserResolvedTarget, Option<BrowserPendingTransition>), AppError> {
        let (tab, target) = self
            .resolve_active_target(app, conversation_id, selector)
            .await?;
        let transition = self
            .run_interaction(&tab, async {
                let webview = self.webview(conversation_id, &tab.browser_tab_id)?;
                automation::type_text(&webview, &target, text, replace, submit).await
            })
            .await?;
        Ok((target, transition))
    }

    pub(crate) async fn press_key_active(
        &self,
        app: &AppHandle,
        conversation_id: &str,
        key: &str,
        modifiers: &[String],
    ) -> Result<Option<BrowserPendingTransition>, AppError> {
        let tab = self.ensure_active_tab(app, conversation_id)?;
        self.run_interaction(&tab, async {
            let webview = self.webview(conversation_id, &tab.browser_tab_id)?;
            automation::press_key(&webview, key, modifiers).await
        })
        .await
    }

    pub(crate) async fn scroll_active(
        &self,
        app: &AppHandle,
        conversation_id: &str,
        x: Option<f64>,
        y: Option<f64>,
        delta_x: f64,
        delta_y: f64,
    ) -> Result<Option<BrowserPendingTransition>, AppError> {
        let tab = self.ensure_active_tab(app, conversation_id)?;
        let webview = self.webview(conversation_id, &tab.browser_tab_id)?;
        let (default_x, default_y) = automation::viewport_center(&webview).await?;
        let x = x.unwrap_or(default_x);
        let y = y.unwrap_or(default_y);
        self.run_interaction(&tab, async {
            automation::scroll(&webview, x, y, delta_x, delta_y).await
        })
        .await
    }

    pub(crate) async fn drag_active(
        &self,
        app: &AppHandle,
        conversation_id: &str,
        start: &BrowserTargetSelector,
        end: &BrowserTargetSelector,
    ) -> Result<Option<BrowserPendingTransition>, AppError> {
        let tab = self.ensure_active_tab(app, conversation_id)?;
        let webview = self.webview(conversation_id, &tab.browser_tab_id)?;
        let start = automation::resolve_target(&webview, start).await?;
        let end = automation::resolve_target(&webview, end).await?;
        self.run_interaction(&tab, async {
            automation::drag(&webview, &start, &end).await
        })
        .await
    }

    pub(crate) async fn apply_agent_transition(
        &self,
        app: &AppHandle,
        conversation_id: &str,
        transition: BrowserPendingTransition,
    ) -> Result<Option<BrowserPendingTransition>, AppError> {
        match transition {
            BrowserPendingTransition::Navigate(url) => {
                self.navigate_active(app, conversation_id, url).await
            }
            BrowserPendingTransition::NewTab(url) => self
                .new_agent_tab(app, conversation_id, url)
                .await
                .map(|(_tab, transition)| transition),
        }
    }

    fn active_tab_id(&self, conversation_id: &str) -> Option<String> {
        let runtime = self.runtime.lock();
        runtime
            .active_tabs
            .get(conversation_id)
            .filter(|browser_tab_id| runtime.tabs.contains_key(*browser_tab_id))
            .cloned()
            .or_else(|| {
                runtime
                    .tab_order
                    .get(conversation_id)
                    .and_then(|order| order.first())
                    .cloned()
            })
    }

    fn set_active_tab(&self, conversation_id: &str, browser_tab_id: &str) -> Result<(), AppError> {
        let mut runtime = self.runtime.lock();
        let tab = runtime
            .tabs
            .get(browser_tab_id)
            .ok_or_else(|| AppError::State("browser tab does not exist".into()))?;
        if tab.conversation_id != conversation_id {
            return Err(AppError::State(
                "browser tab does not belong to the requested conversation".into(),
            ));
        }
        runtime
            .active_tabs
            .insert(conversation_id.to_string(), browser_tab_id.to_string());
        self.state_notify.notify_waiters();
        Ok(())
    }

    fn apply_active_surface(&self, conversation_id: &str) -> Result<(), AppError> {
        let (visible, bounds, active_browser_tab_id) = {
            let runtime = self.runtime.lock();
            (
                runtime.surface.visible
                    && runtime.surface.conversation_id.as_deref() == Some(conversation_id),
                runtime.surface.bounds,
                runtime.active_tabs.get(conversation_id).cloned(),
            )
        };
        if visible {
            let active_browser_tab_id = active_browser_tab_id.ok_or_else(|| {
                AppError::State("visible browser conversation lost its active tab".into())
            })?;
            self.synchronize_surface(
                Some(conversation_id),
                Some(&active_browser_tab_id),
                bounds,
                true,
            )?;
        }
        Ok(())
    }

    fn webview(&self, conversation_id: &str, browser_tab_id: &str) -> Result<Webview, AppError> {
        let runtime = self.runtime.lock();
        let tab = runtime
            .tabs
            .get(browser_tab_id)
            .ok_or_else(|| AppError::State("browser tab does not exist".into()))?;
        if tab.conversation_id != conversation_id {
            return Err(AppError::State(
                "browser tab does not belong to the requested conversation".into(),
            ));
        }
        Ok(tab.webview.clone())
    }

    async fn wait_for_page_load(
        &self,
        conversation_id: &str,
        browser_tab_id: &str,
    ) -> Result<bool, AppError> {
        let wait = async {
            loop {
                let notified = self.state_notify.notified();
                let loading = {
                    let runtime = self.runtime.lock();
                    let tab = runtime
                        .tabs
                        .get(browser_tab_id)
                        .ok_or_else(|| AppError::State("browser tab does not exist".into()))?;
                    if tab.conversation_id != conversation_id {
                        return Err(AppError::State(
                            "browser tab does not belong to the requested conversation".into(),
                        ));
                    }
                    tab.is_loading
                };
                if !loading {
                    return Ok(());
                }
                notified.await;
            }
        };
        match timeout(PAGE_LOAD_TIMEOUT, wait).await {
            Ok(result) => result.map(|()| false),
            Err(_) => Ok(true),
        }
    }

    async fn run_interaction<F>(
        &self,
        tab: &BrowserTabSnapshot,
        operation: F,
    ) -> Result<Option<BrowserPendingTransition>, AppError>
    where
        F: Future<Output = Result<(), AppError>>,
    {
        {
            let mut runtime = self.runtime.lock();
            runtime
                .agent_interactions
                .insert(tab.browser_tab_id.clone());
            runtime.pending_transitions.remove(&tab.browser_tab_id);
        }
        let result = operation.await;
        let wait_result = if result.is_ok() {
            self.wait_for_agent_interaction(&tab.browser_tab_id).await
        } else {
            Ok(())
        };
        let transition = self.finish_agent_interaction(&tab.browser_tab_id);
        result?;
        wait_result?;
        Ok(transition)
    }

    async fn wait_for_agent_interaction(&self, browser_tab_id: &str) -> Result<(), AppError> {
        let wait = async {
            loop {
                let notified = self.state_notify.notified();
                let (pending, loading) = {
                    let runtime = self.runtime.lock();
                    let tab = runtime
                        .tabs
                        .get(browser_tab_id)
                        .ok_or_else(|| AppError::State("browser tab does not exist".into()))?;
                    (
                        runtime.pending_transitions.contains_key(browser_tab_id),
                        tab.is_loading,
                    )
                };
                if pending {
                    return Ok(());
                }
                if !loading {
                    sleep(TRANSITION_OBSERVATION_DELAY).await;
                    let runtime = self.runtime.lock();
                    let tab = runtime
                        .tabs
                        .get(browser_tab_id)
                        .ok_or_else(|| AppError::State("browser tab does not exist".into()))?;
                    if runtime.pending_transitions.contains_key(browser_tab_id) || !tab.is_loading {
                        return Ok(());
                    }
                    continue;
                }
                notified.await;
            }
        };
        if let Ok(result) = timeout(PAGE_LOAD_TIMEOUT, wait).await {
            return result;
        }
        let webview = {
            let runtime = self.runtime.lock();
            runtime
                .tabs
                .get(browser_tab_id)
                .map(|tab| tab.webview.clone())
        };
        if let Some(webview) = webview {
            automation::stop_loading(&webview).await?;
        }
        Err(AppError::Timeout {
            operation: "browser agent navigation",
        })
    }

    fn finish_agent_interaction(&self, browser_tab_id: &str) -> Option<BrowserPendingTransition> {
        let transition = {
            let mut runtime = self.runtime.lock();
            runtime.agent_interactions.remove(browser_tab_id);
            runtime.pending_transitions.remove(browser_tab_id)
        };
        self.state_notify.notify_waiters();
        transition
    }
}

fn elapsed_millis(started_at: Instant) -> Result<u64, AppError> {
    u64::try_from(started_at.elapsed().as_millis())
        .map_err(|_| AppError::State("browser action duration exceeded u64".into()))
}
