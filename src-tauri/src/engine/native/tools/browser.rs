use std::collections::HashSet;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::Manager as _;
use tokio::sync::watch;
use tokio::time::sleep;
use url::Url;

use super::{ToolExecutionContext, decode_arguments, function_tool};
use crate::browser::{
    BrowserActionMetric, BrowserActionStatus, BrowserAgentCapture, BrowserManager,
    BrowserMouseButton, BrowserPageMetricSummary, BrowserPageSnapshot, BrowserPanelDirective,
    BrowserPendingTransition, BrowserTargetSelector, browser_origin,
};
use crate::engine::{
    ActivityStatus, ApprovalDecision, ApprovalPolicy, BrowserOriginApprovalRequest,
};
use crate::error::AppError;

const MAX_BROWSER_REFERENCE_BYTES: usize = 64;
const MAX_BROWSER_KEY_BYTES: usize = 64;
const MAX_BROWSER_TYPE_BYTES: usize = 65_536;
const MAX_BROWSER_WAIT_MILLISECONDS: u64 = 10_000;
const MAX_BROWSER_SCROLL_DELTA: f64 = 20_000.0;
const MAX_BROWSER_COORDINATE: f64 = 16_384.0;
const MAX_BROWSER_METRICS: u16 = 100;
const MAX_BROWSER_TRANSITIONS: usize = 8;

#[derive(Debug)]
pub(super) enum BrowserToolOperation {
    Manage(BrowserManageOperation),
    Snapshot,
    Pointer(BrowserPointerOperation),
    Type(BrowserTypeOperation),
    Key(BrowserKeyArgs),
    Wait(Duration),
    Metrics { limit: usize },
}

impl BrowserToolOperation {
    pub(super) fn presents_image(&self) -> bool {
        !matches!(
            self,
            Self::Manage(
                BrowserManageOperation::ListTabs | BrowserManageOperation::CloseBrowser { .. }
            ) | Self::Metrics { .. }
        )
    }

    pub(super) fn action_name(&self) -> &'static str {
        match self {
            Self::Manage(operation) => operation.action_name(),
            Self::Snapshot => "snapshot",
            Self::Pointer(operation) => operation.action_name(),
            Self::Type(_) => "type",
            Self::Key(_) => "key",
            Self::Wait(_) => "wait",
            Self::Metrics { .. } => "metrics",
        }
    }
}

#[derive(Debug)]
pub(super) struct BrowserToolExecution {
    pub provider_output: String,
    pub display_output: Option<String>,
    pub visual_image_url: Option<String>,
    pub visual_description: Option<String>,
    pub status: ActivityStatus,
}

#[derive(Debug)]
pub(super) enum BrowserManageOperation {
    Open { url: Option<Url> },
    Navigate { url: Url },
    NewTab { url: Url },
    SelectTab { browser_tab_id: String },
    CloseTab { browser_tab_id: Option<String> },
    CloseBrowser { close_tabs: bool },
    Back,
    Forward,
    Reload,
    ListTabs,
}

impl BrowserManageOperation {
    fn action_name(&self) -> &'static str {
        match self {
            Self::Open { .. } => "open",
            Self::Navigate { .. } => "navigate",
            Self::NewTab { .. } => "new_tab",
            Self::SelectTab { .. } => "select_tab",
            Self::CloseTab { .. } => "close_tab",
            Self::CloseBrowser { .. } => "close_browser",
            Self::Back => "back",
            Self::Forward => "forward",
            Self::Reload => "reload",
            Self::ListTabs => "list_tabs",
        }
    }
}

#[derive(Debug)]
pub(super) enum BrowserPointerOperation {
    Hover {
        target: BrowserTargetSelector,
    },
    Click {
        target: BrowserTargetSelector,
        button: BrowserMouseButton,
        click_count: u8,
    },
    Drag {
        start: BrowserTargetSelector,
        end: BrowserTargetSelector,
    },
    Scroll {
        target: Option<BrowserTargetSelector>,
        delta_x: f64,
        delta_y: f64,
    },
}

impl BrowserPointerOperation {
    fn action_name(&self) -> &'static str {
        match self {
            Self::Hover { .. } => "hover",
            Self::Click { .. } => "click",
            Self::Drag { .. } => "drag",
            Self::Scroll { .. } => "scroll",
        }
    }
}

#[derive(Debug)]
pub(super) struct BrowserTypeOperation {
    target: BrowserTargetSelector,
    text: String,
    replace: bool,
    submit: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserManageArgs {
    action: BrowserManageAction,
    url: Option<String>,
    browser_tab_id: Option<String>,
    close_tabs: Option<bool>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum BrowserManageAction {
    Open,
    Navigate,
    NewTab,
    SelectTab,
    CloseTab,
    CloseBrowser,
    Back,
    Forward,
    Reload,
    ListTabs,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserPointerArgs {
    action: BrowserPointerAction,
    r#ref: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    to_ref: Option<String>,
    to_x: Option<f64>,
    to_y: Option<f64>,
    button: Option<BrowserButtonArg>,
    click_count: Option<u8>,
    delta_x: Option<f64>,
    delta_y: Option<f64>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum BrowserPointerAction {
    Hover,
    Click,
    Drag,
    Scroll,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum BrowserButtonArg {
    Left,
    Middle,
    Right,
}

impl From<BrowserButtonArg> for BrowserMouseButton {
    fn from(value: BrowserButtonArg) -> Self {
        match value {
            BrowserButtonArg::Left => Self::Left,
            BrowserButtonArg::Middle => Self::Middle,
            BrowserButtonArg::Right => Self::Right,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserTypeArgs {
    r#ref: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    text: String,
    replace: bool,
    submit: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct BrowserKeyArgs {
    key: String,
    modifiers: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserWaitArgs {
    milliseconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserMetricsArgs {
    limit: u16,
}

pub(super) fn definitions() -> Vec<Value> {
    vec![
        function_tool(
            "browser_manage",
            "Manage the visible built-in browser for the current conversation: open it, navigate, create/select/close tabs, close the whole browser surface, traverse history, reload, or list tabs. URLs must be absolute HTTP(S) URLs or about:blank.",
            json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["open", "navigate", "new_tab", "select_tab", "close_tab", "close_browser", "back", "forward", "reload", "list_tabs"]
                    },
                    "url": {
                        "type": ["string", "null"],
                        "description": "Required for navigate, optional for open/new_tab, otherwise null."
                    },
                    "browser_tab_id": {
                        "type": ["string", "null"],
                        "description": "Required for select_tab, optional for close_tab, otherwise null."
                    },
                    "close_tabs": {
                        "type": ["boolean", "null"],
                        "description": "For close_browser, whether to destroy all tabs instead of only hiding the surface; otherwise null."
                    }
                },
                "required": ["action", "url", "browser_tab_id", "close_tabs"],
                "additionalProperties": false
            }),
        ),
        function_tool(
            "browser_snapshot",
            "Inspect the active built-in browser tab. Returns a compact rendered-page snapshot with stable element refs, accessibility information, visible text, console/page/resource errors, Web Vitals, and a viewport screenshot.",
            json!({
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": false
            }),
        ),
        function_tool(
            "browser_pointer",
            "Use the agent's visible cursor in the built-in browser. Hover or click a ref/coordinate, drag between two targets, or scroll at a target/viewport center. Capture a fresh browser_snapshot before using refs after the page changes.",
            json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["hover", "click", "drag", "scroll"] },
                    "ref": { "type": ["string", "null"] },
                    "x": { "type": ["number", "null"], "minimum": 0, "maximum": MAX_BROWSER_COORDINATE },
                    "y": { "type": ["number", "null"], "minimum": 0, "maximum": MAX_BROWSER_COORDINATE },
                    "to_ref": { "type": ["string", "null"] },
                    "to_x": { "type": ["number", "null"], "minimum": 0, "maximum": MAX_BROWSER_COORDINATE },
                    "to_y": { "type": ["number", "null"], "minimum": 0, "maximum": MAX_BROWSER_COORDINATE },
                    "button": { "type": ["string", "null"], "enum": ["left", "middle", "right", null] },
                    "click_count": { "type": ["integer", "null"], "minimum": 1, "maximum": 2 },
                    "delta_x": { "type": ["number", "null"], "minimum": -MAX_BROWSER_SCROLL_DELTA, "maximum": MAX_BROWSER_SCROLL_DELTA },
                    "delta_y": { "type": ["number", "null"], "minimum": -MAX_BROWSER_SCROLL_DELTA, "maximum": MAX_BROWSER_SCROLL_DELTA }
                },
                "required": ["action", "ref", "x", "y", "to_ref", "to_x", "to_y", "button", "click_count", "delta_x", "delta_y"],
                "additionalProperties": false
            }),
        ),
        function_tool(
            "browser_type",
            "Focus a browser element by ref or coordinates and enter text through trusted browser input. Text can replace the current value and optionally submit with Enter.",
            json!({
                "type": "object",
                "properties": {
                    "ref": { "type": ["string", "null"] },
                    "x": { "type": ["number", "null"], "minimum": 0, "maximum": MAX_BROWSER_COORDINATE },
                    "y": { "type": ["number", "null"], "minimum": 0, "maximum": MAX_BROWSER_COORDINATE },
                    "text": { "type": "string", "maxLength": MAX_BROWSER_TYPE_BYTES },
                    "replace": { "type": "boolean" },
                    "submit": { "type": "boolean" }
                },
                "required": ["ref", "x", "y", "text", "replace", "submit"],
                "additionalProperties": false
            }),
        ),
        function_tool(
            "browser_key",
            "Press a named key or one printable character in the active browser tab, with optional alt/control/meta/shift modifiers.",
            json!({
                "type": "object",
                "properties": {
                    "key": { "type": "string", "minLength": 1, "maxLength": MAX_BROWSER_KEY_BYTES },
                    "modifiers": {
                        "type": "array",
                        "maxItems": 4,
                        "items": { "type": "string", "enum": ["alt", "control", "meta", "shift"] }
                    }
                },
                "required": ["key", "modifiers"],
                "additionalProperties": false
            }),
        ),
        function_tool(
            "browser_wait",
            "Wait for a bounded interval in the active built-in browser, then return a fresh rendered snapshot and screenshot. The wait is cancelable with the turn.",
            json!({
                "type": "object",
                "properties": {
                    "milliseconds": { "type": "integer", "minimum": 0, "maximum": MAX_BROWSER_WAIT_MILLISECONDS }
                },
                "required": ["milliseconds"],
                "additionalProperties": false
            }),
        ),
        function_tool(
            "browser_metrics",
            "Read recent structured browser-action metrics for the current conversation, including queue/action/load/snapshot/screenshot latency, page errors, Web Vitals, overflow, accessibility findings, and screenshot size.",
            json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_BROWSER_METRICS }
                },
                "required": ["limit"],
                "additionalProperties": false
            }),
        ),
    ]
}

pub(super) fn prepare(
    name: &str,
    arguments: &str,
) -> Option<Result<(&'static str, String, BrowserToolOperation), AppError>> {
    let prepared = match name {
        "browser_manage" => {
            let args: BrowserManageArgs = match decode_arguments(name, arguments) {
                Ok(args) => args,
                Err(error) => return Some(Err(error)),
            };
            normalize_manage(args).map(|operation| {
                (
                    "browser_manage",
                    format!("Browser {}", operation.action_name().replace('_', " ")),
                    BrowserToolOperation::Manage(operation),
                )
            })
        }
        "browser_snapshot" => {
            let empty: serde_json::Map<String, Value> = match decode_arguments(name, arguments) {
                Ok(empty) => empty,
                Err(error) => return Some(Err(error)),
            };
            if !empty.is_empty() {
                Err(AppError::Tool(
                    "browser_snapshot does not accept arguments".into(),
                ))
            } else {
                Ok((
                    "browser_snapshot",
                    "Inspect browser".into(),
                    BrowserToolOperation::Snapshot,
                ))
            }
        }
        "browser_pointer" => {
            let args: BrowserPointerArgs = match decode_arguments(name, arguments) {
                Ok(args) => args,
                Err(error) => return Some(Err(error)),
            };
            normalize_pointer(args).map(|operation| {
                (
                    "browser_pointer",
                    format!("Browser {}", operation.action_name()),
                    BrowserToolOperation::Pointer(operation),
                )
            })
        }
        "browser_type" => {
            let args: BrowserTypeArgs = match decode_arguments(name, arguments) {
                Ok(args) => args,
                Err(error) => return Some(Err(error)),
            };
            normalize_type(args).map(|operation| {
                (
                    "browser_type",
                    "Type in browser".into(),
                    BrowserToolOperation::Type(operation),
                )
            })
        }
        "browser_key" => {
            let args: BrowserKeyArgs = match decode_arguments(name, arguments) {
                Ok(args) => args,
                Err(error) => return Some(Err(error)),
            };
            validate_key(&args).map(|()| {
                (
                    "browser_key",
                    format!("Press {} in browser", args.key),
                    BrowserToolOperation::Key(args),
                )
            })
        }
        "browser_wait" => {
            let args: BrowserWaitArgs = match decode_arguments(name, arguments) {
                Ok(args) => args,
                Err(error) => return Some(Err(error)),
            };
            if args.milliseconds > MAX_BROWSER_WAIT_MILLISECONDS {
                Err(AppError::Tool(format!(
                    "browser wait cannot exceed {MAX_BROWSER_WAIT_MILLISECONDS} milliseconds"
                )))
            } else {
                Ok((
                    "browser_wait",
                    format!("Wait {} ms in browser", args.milliseconds),
                    BrowserToolOperation::Wait(Duration::from_millis(args.milliseconds)),
                ))
            }
        }
        "browser_metrics" => {
            let args: BrowserMetricsArgs = match decode_arguments(name, arguments) {
                Ok(args) => args,
                Err(error) => return Some(Err(error)),
            };
            if args.limit == 0 || args.limit > MAX_BROWSER_METRICS {
                Err(AppError::Tool(format!(
                    "browser metrics limit must be between 1 and {MAX_BROWSER_METRICS}"
                )))
            } else {
                Ok((
                    "browser_metrics",
                    "Read browser metrics".into(),
                    BrowserToolOperation::Metrics {
                        limit: usize::from(args.limit),
                    },
                ))
            }
        }
        _ => return None,
    };
    Some(prepared)
}

pub(super) async fn execute(
    operation: &BrowserToolOperation,
    item_id: &str,
    context: &ToolExecutionContext<'_>,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<BrowserToolExecution, AppError> {
    let manager = context.app.state::<BrowserManager>();
    let started_at = Instant::now();
    let queue_started = Instant::now();
    let _conversation_guard = manager.lock_conversation(context.thread_id).await;
    let queue_ms = elapsed_millis(queue_started)?;
    if *cancellation.borrow() {
        return Err(AppError::Cancelled(
            "turn was interrupted before browser control started".into(),
        ));
    }

    let result = execute_locked(operation, item_id, context, cancellation, &manager).await;
    let total_ms = elapsed_millis(started_at)?;
    match result {
        Ok(outcome) => {
            let metric =
                metric_from_outcome(operation, item_id, context, queue_ms, total_ms, &outcome)?;
            manager.record_metric(context.app, metric);
            Ok(outcome.execution)
        }
        Err(error) => {
            manager.record_metric(
                context.app,
                BrowserActionMetric::failed(
                    context.thread_id,
                    context.turn_id,
                    item_id,
                    operation.action_name(),
                    queue_ms,
                    total_ms,
                    &error,
                ),
            );
            Err(error)
        }
    }
}

struct BrowserOutcome {
    execution: BrowserToolExecution,
    capture: Option<BrowserAgentCapture>,
}

async fn execute_locked(
    operation: &BrowserToolOperation,
    item_id: &str,
    context: &ToolExecutionContext<'_>,
    cancellation: &mut watch::Receiver<bool>,
    manager: &BrowserManager,
) -> Result<BrowserOutcome, AppError> {
    match operation {
        BrowserToolOperation::Manage(operation) => {
            execute_manage(operation, item_id, context, cancellation, manager).await
        }
        BrowserToolOperation::Snapshot => {
            manager.ensure_active_tab(context.app, context.thread_id)?;
            manager.announce_agent_activity(
                context.app,
                context.thread_id,
                "snapshot",
                BrowserPanelDirective::Open,
            );
            captured_outcome(
                manager
                    .capture_active(context.app, context.thread_id)
                    .await?,
            )
        }
        BrowserToolOperation::Pointer(operation) => {
            let transition = match operation {
                BrowserPointerOperation::Hover { target } => {
                    manager
                        .hover_active(context.app, context.thread_id, target)
                        .await?
                }
                BrowserPointerOperation::Click {
                    target,
                    button,
                    click_count,
                } => {
                    manager
                        .click_active(
                            context.app,
                            context.thread_id,
                            target,
                            *button,
                            *click_count,
                        )
                        .await?
                        .1
                }
                BrowserPointerOperation::Drag { start, end } => {
                    manager
                        .drag_active(context.app, context.thread_id, start, end)
                        .await?
                }
                BrowserPointerOperation::Scroll {
                    target,
                    delta_x,
                    delta_y,
                } => {
                    let coordinates = if let Some(target) = target {
                        let (_, target) = manager
                            .resolve_active_target(context.app, context.thread_id, target)
                            .await?;
                        (Some(target.x), Some(target.y))
                    } else {
                        (None, None)
                    };
                    manager
                        .scroll_active(
                            context.app,
                            context.thread_id,
                            coordinates.0,
                            coordinates.1,
                            *delta_x,
                            *delta_y,
                        )
                        .await?
                }
            };
            let transition_result =
                authorize_and_apply_transition(manager, transition, item_id, context, cancellation)
                    .await?;
            if matches!(transition_result, TransitionResult::Declined) {
                return declined_capture(manager, context, operation.action_name()).await;
            }
            manager.announce_agent_activity(
                context.app,
                context.thread_id,
                operation.action_name(),
                BrowserPanelDirective::Open,
            );
            captured_outcome(
                manager
                    .capture_active(context.app, context.thread_id)
                    .await?,
            )
        }
        BrowserToolOperation::Type(operation) => {
            let (_, transition) = manager
                .type_active(
                    context.app,
                    context.thread_id,
                    &operation.target,
                    &operation.text,
                    operation.replace,
                    operation.submit,
                )
                .await?;
            let transition_result =
                authorize_and_apply_transition(manager, transition, item_id, context, cancellation)
                    .await?;
            if matches!(transition_result, TransitionResult::Declined) {
                return declined_capture(manager, context, "type").await;
            }
            manager.announce_agent_activity(
                context.app,
                context.thread_id,
                "type",
                BrowserPanelDirective::Open,
            );
            captured_outcome(
                manager
                    .capture_active(context.app, context.thread_id)
                    .await?,
            )
        }
        BrowserToolOperation::Key(args) => {
            let transition = manager
                .press_key_active(context.app, context.thread_id, &args.key, &args.modifiers)
                .await?;
            let transition_result =
                authorize_and_apply_transition(manager, transition, item_id, context, cancellation)
                    .await?;
            if matches!(transition_result, TransitionResult::Declined) {
                return declined_capture(manager, context, "key").await;
            }
            manager.announce_agent_activity(
                context.app,
                context.thread_id,
                "key",
                BrowserPanelDirective::Open,
            );
            captured_outcome(
                manager
                    .capture_active(context.app, context.thread_id)
                    .await?,
            )
        }
        BrowserToolOperation::Wait(duration) => {
            let wait = sleep(*duration);
            tokio::pin!(wait);
            tokio::select! {
                changed = cancellation.changed() => {
                    match changed {
                        Ok(()) if *cancellation.borrow() => {
                            return Err(AppError::Cancelled(
                                "turn was interrupted while waiting in the browser".into(),
                            ));
                        }
                        Ok(()) => {
                            return Err(AppError::State(
                                "browser wait observed an invalid cancellation transition".into(),
                            ));
                        }
                        Err(_) => {
                            return Err(AppError::State(
                                "turn cancellation channel closed during browser wait".into(),
                            ));
                        }
                    }
                }
                () = &mut wait => {}
            }
            manager.announce_agent_activity(
                context.app,
                context.thread_id,
                "wait",
                BrowserPanelDirective::Open,
            );
            captured_outcome(
                manager
                    .capture_active(context.app, context.thread_id)
                    .await?,
            )
        }
        BrowserToolOperation::Metrics { limit } => {
            let metrics = manager.recent_metrics(context.thread_id);
            let output = render_metrics(metrics.into_iter().rev().take(*limit).collect());
            Ok(BrowserOutcome {
                execution: BrowserToolExecution {
                    provider_output: output,
                    display_output: None,
                    visual_image_url: None,
                    visual_description: None,
                    status: ActivityStatus::Completed,
                },
                capture: None,
            })
        }
    }
}

async fn execute_manage(
    operation: &BrowserManageOperation,
    item_id: &str,
    context: &ToolExecutionContext<'_>,
    cancellation: &mut watch::Receiver<bool>,
    manager: &BrowserManager,
) -> Result<BrowserOutcome, AppError> {
    match operation {
        BrowserManageOperation::Open { url } => {
            manager.ensure_active_tab(context.app, context.thread_id)?;
            if let Some(url) = url {
                if !authorize_origin(
                    manager,
                    url,
                    item_id,
                    context,
                    cancellation,
                    "open this URL",
                )
                .await?
                {
                    return declined_without_capture("The user declined browser origin access.");
                }
                let transition = manager
                    .navigate_active(context.app, context.thread_id, url.clone())
                    .await?;
                if transition_was_declined(manager, transition, item_id, context, cancellation)
                    .await?
                {
                    return declined_capture(manager, context, operation.action_name()).await;
                }
            }
        }
        BrowserManageOperation::Navigate { url } => {
            if !authorize_origin(
                manager,
                url,
                item_id,
                context,
                cancellation,
                "navigate to this URL",
            )
            .await?
            {
                return declined_without_capture("The user declined browser origin access.");
            }
            let transition = manager
                .navigate_active(context.app, context.thread_id, url.clone())
                .await?;
            if transition_was_declined(manager, transition, item_id, context, cancellation).await? {
                return declined_capture(manager, context, operation.action_name()).await;
            }
        }
        BrowserManageOperation::NewTab { url } => {
            if !authorize_origin(
                manager,
                url,
                item_id,
                context,
                cancellation,
                "open a new tab",
            )
            .await?
            {
                return declined_without_capture("The user declined browser origin access.");
            }
            let (_tab, transition) = manager
                .new_agent_tab(context.app, context.thread_id, url.clone())
                .await?;
            if transition_was_declined(manager, transition, item_id, context, cancellation).await? {
                return declined_capture(manager, context, operation.action_name()).await;
            }
        }
        BrowserManageOperation::SelectTab { browser_tab_id } => {
            manager.select_agent_tab(context.thread_id, browser_tab_id)?;
        }
        BrowserManageOperation::CloseTab { browser_tab_id } => {
            let topology = manager.close_agent_tab(context.thread_id, browser_tab_id.as_deref())?;
            let panel = if topology.tabs.is_empty() {
                BrowserPanelDirective::Close
            } else {
                BrowserPanelDirective::Open
            };
            manager.announce_agent_activity(context.app, context.thread_id, "close_tab", panel);
            if topology.tabs.is_empty() {
                return Ok(BrowserOutcome {
                    execution: BrowserToolExecution {
                        provider_output: "Closed the last browser tab and hid the browser.".into(),
                        display_output: None,
                        visual_image_url: None,
                        visual_description: None,
                        status: ActivityStatus::Completed,
                    },
                    capture: None,
                });
            }
        }
        BrowserManageOperation::CloseBrowser { close_tabs } => {
            manager.close_agent_browser(context.thread_id, *close_tabs)?;
            manager.announce_agent_activity(
                context.app,
                context.thread_id,
                "close_browser",
                BrowserPanelDirective::Close,
            );
            return Ok(BrowserOutcome {
                execution: BrowserToolExecution {
                    provider_output: if *close_tabs {
                        "Closed the built-in browser and destroyed its tabs."
                    } else {
                        "Hid the built-in browser while preserving its tabs."
                    }
                    .into(),
                    display_output: None,
                    visual_image_url: None,
                    visual_description: None,
                    status: ActivityStatus::Completed,
                },
                capture: None,
            });
        }
        BrowserManageOperation::Back => {
            let transition = manager
                .history_active(context.app, context.thread_id, false)
                .await?;
            if transition_was_declined(manager, transition, item_id, context, cancellation).await? {
                return declined_capture(manager, context, operation.action_name()).await;
            }
        }
        BrowserManageOperation::Forward => {
            let transition = manager
                .history_active(context.app, context.thread_id, true)
                .await?;
            if transition_was_declined(manager, transition, item_id, context, cancellation).await? {
                return declined_capture(manager, context, operation.action_name()).await;
            }
        }
        BrowserManageOperation::Reload => {
            let transition = manager
                .reload_active(context.app, context.thread_id)
                .await?;
            if transition_was_declined(manager, transition, item_id, context, cancellation).await? {
                return declined_capture(manager, context, operation.action_name()).await;
            }
        }
        BrowserManageOperation::ListTabs => {
            return Ok(BrowserOutcome {
                execution: BrowserToolExecution {
                    provider_output: render_tabs(manager, context.thread_id),
                    display_output: None,
                    visual_image_url: None,
                    visual_description: None,
                    status: ActivityStatus::Completed,
                },
                capture: None,
            });
        }
    }
    manager.announce_agent_activity(
        context.app,
        context.thread_id,
        operation.action_name(),
        BrowserPanelDirective::Open,
    );
    captured_outcome(
        manager
            .capture_active(context.app, context.thread_id)
            .await?,
    )
}

async fn transition_was_declined(
    manager: &BrowserManager,
    transition: Option<BrowserPendingTransition>,
    item_id: &str,
    context: &ToolExecutionContext<'_>,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<bool, AppError> {
    Ok(matches!(
        authorize_and_apply_transition(manager, transition, item_id, context, cancellation).await?,
        TransitionResult::Declined
    ))
}

enum TransitionResult {
    None,
    Applied,
    Declined,
}

async fn authorize_and_apply_transition(
    manager: &BrowserManager,
    transition: Option<BrowserPendingTransition>,
    item_id: &str,
    context: &ToolExecutionContext<'_>,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<TransitionResult, AppError> {
    let mut transition = transition;
    let mut applied = false;
    for _ in 0..MAX_BROWSER_TRANSITIONS {
        let Some(current) = transition else {
            return Ok(if applied {
                TransitionResult::Applied
            } else {
                TransitionResult::None
            });
        };
        let url = match &current {
            BrowserPendingTransition::Navigate(url) | BrowserPendingTransition::NewTab(url) => url,
        };
        if !authorize_origin(
            manager,
            url,
            item_id,
            context,
            cancellation,
            "follow the browser interaction to a new origin",
        )
        .await?
        {
            return Ok(TransitionResult::Declined);
        }
        transition = manager
            .apply_agent_transition(context.app, context.thread_id, current)
            .await?;
        applied = true;
    }
    Err(AppError::Tool(format!(
        "browser exceeded {MAX_BROWSER_TRANSITIONS} consecutive cross-origin transitions"
    )))
}

async fn authorize_origin(
    manager: &BrowserManager,
    url: &Url,
    item_id: &str,
    context: &ToolExecutionContext<'_>,
    cancellation: &mut watch::Receiver<bool>,
    reason: &str,
) -> Result<bool, AppError> {
    if browser_origin(url).is_none() || manager.origin_is_approved(context.thread_id, url) {
        return Ok(true);
    }
    if context.permissions.approvals == ApprovalPolicy::Never {
        manager.approve_agent_origin(context.thread_id, url);
        return Ok(true);
    }
    let origin = browser_origin(url)
        .ok_or_else(|| AppError::State("browser origin disappeared after URL validation".into()))?;
    let decision = context
        .approvals
        .request_browser_origin(
            context.app,
            BrowserOriginApprovalRequest {
                thread_id: context.thread_id.into(),
                turn_id: context.turn_id.into(),
                item_id: item_id.into(),
                origin: origin.clone(),
                reason: reason.into(),
            },
            cancellation,
        )
        .await?;
    match decision {
        ApprovalDecision::Accept => {
            manager.approve_agent_origin(context.thread_id, url);
            Ok(true)
        }
        ApprovalDecision::Decline => Ok(false),
        ApprovalDecision::Cancel => Err(AppError::Cancelled(
            "the user canceled the turn while reviewing browser origin access".into(),
        )),
    }
}

fn captured_outcome(capture: BrowserAgentCapture) -> Result<BrowserOutcome, AppError> {
    let provider_output = render_capture(&capture);
    let image_url = capture.automation.image_url.clone();
    let display_output = serde_json::to_string(&json!({ "image_url": image_url }))
        .map_err(|error| AppError::State(format!("browser image output is invalid: {error}")))?;
    Ok(BrowserOutcome {
        execution: BrowserToolExecution {
            provider_output,
            display_output: Some(display_output),
            visual_image_url: Some(capture.automation.image_url.clone()),
            visual_description: Some(format!(
                "Viewport screenshot for browser tab {} at {}.",
                capture.tab.browser_tab_id, capture.tab.url
            )),
            status: ActivityStatus::Completed,
        },
        capture: Some(capture),
    })
}

async fn declined_capture(
    manager: &BrowserManager,
    context: &ToolExecutionContext<'_>,
    action: &str,
) -> Result<BrowserOutcome, AppError> {
    manager.announce_agent_activity(
        context.app,
        context.thread_id,
        action,
        BrowserPanelDirective::Open,
    );
    let capture = manager
        .capture_active(context.app, context.thread_id)
        .await?;
    let mut outcome = captured_outcome(capture)?;
    outcome.execution.status = ActivityStatus::Declined;
    outcome.execution.provider_output = format!(
        "The user declined browser origin access.\n\n{}",
        outcome.execution.provider_output
    );
    Ok(outcome)
}

fn declined_without_capture(message: &str) -> Result<BrowserOutcome, AppError> {
    Ok(BrowserOutcome {
        execution: BrowserToolExecution {
            provider_output: message.into(),
            display_output: None,
            visual_image_url: None,
            visual_description: None,
            status: ActivityStatus::Declined,
        },
        capture: None,
    })
}

fn metric_from_outcome(
    operation: &BrowserToolOperation,
    item_id: &str,
    context: &ToolExecutionContext<'_>,
    queue_ms: u64,
    total_ms: u64,
    outcome: &BrowserOutcome,
) -> Result<BrowserActionMetric, AppError> {
    let capture = outcome.capture.as_ref();
    let snapshot_ms = capture.map_or(0, |capture| capture.automation.snapshot_ms);
    let screenshot_ms = capture.map_or(0, |capture| capture.automation.screenshot_ms);
    let load_ms = capture.map_or(0, |capture| capture.load_ms);
    let page = capture.map(|capture| page_metric_summary(&capture.automation.snapshot));
    let url = capture
        .map(|capture| sanitize_metric_url(&capture.tab.url))
        .transpose()?;
    let origin = capture
        .and_then(|capture| Url::parse(&capture.tab.url).ok())
        .and_then(|url| browser_origin(&url));
    Ok(BrowserActionMetric {
        id: uuid::Uuid::now_v7().to_string(),
        session_id: String::new(),
        timestamp_ms: chrono::Utc::now().timestamp_millis(),
        conversation_id: context.thread_id.into(),
        turn_id: context.turn_id.into(),
        item_id: item_id.into(),
        browser_tab_id: capture.map(|capture| capture.tab.browser_tab_id.clone()),
        action: operation.action_name().into(),
        status: match outcome.execution.status {
            ActivityStatus::Completed => BrowserActionStatus::Completed,
            ActivityStatus::Declined => BrowserActionStatus::Declined,
            ActivityStatus::Failed | ActivityStatus::InProgress => BrowserActionStatus::Failed,
        },
        origin,
        url,
        queue_ms,
        action_ms: total_ms
            .saturating_sub(queue_ms)
            .saturating_sub(load_ms)
            .saturating_sub(snapshot_ms)
            .saturating_sub(screenshot_ms),
        load_ms,
        snapshot_ms,
        screenshot_ms,
        total_ms,
        screenshot_bytes: capture
            .map(|capture| u64::try_from(capture.automation.screenshot_bytes))
            .transpose()
            .map_err(|_| AppError::State("browser screenshot size exceeded u64".into()))?,
        page,
        error: capture
            .filter(|capture| capture.load_timed_out)
            .map(|_| "page load exceeded the bounded wait; snapshot captured current state".into()),
    })
}

fn page_metric_summary(snapshot: &BrowserPageSnapshot) -> BrowserPageMetricSummary {
    let diagnostics = &snapshot.diagnostics;
    BrowserPageMetricSummary {
        ready_state: snapshot.ready_state.clone(),
        viewport_width: snapshot.viewport.width,
        viewport_height: snapshot.viewport.height,
        interactive_elements: snapshot
            .elements
            .iter()
            .filter(|element| element.interactive)
            .count()
            .try_into()
            .unwrap_or(u32::MAX),
        console_errors: diagnostics
            .console_errors
            .len()
            .try_into()
            .unwrap_or(u32::MAX),
        page_errors: diagnostics.page_errors.len().try_into().unwrap_or(u32::MAX),
        resource_failures: diagnostics
            .resource_failures
            .len()
            .try_into()
            .unwrap_or(u32::MAX),
        resource_count: diagnostics.resource_count,
        transfer_bytes: diagnostics.transfer_bytes,
        navigation_duration_ms: diagnostics.navigation.map(|timing| timing.duration_ms),
        largest_contentful_paint_ms: diagnostics.largest_contentful_paint_ms,
        cumulative_layout_shift: diagnostics.cumulative_layout_shift,
        long_task_count: diagnostics.long_task_count,
        long_task_duration_ms: diagnostics.long_task_duration_ms,
        horizontal_overflow_px: diagnostics.horizontal_overflow_px,
        unlabeled_controls: diagnostics.unlabeled_controls,
        missing_alt_images: diagnostics.missing_alt_images,
        duplicate_ids: diagnostics.duplicate_ids,
    }
}

fn render_capture(capture: &BrowserAgentCapture) -> String {
    let snapshot = &capture.automation.snapshot;
    let diagnostics = &snapshot.diagnostics;
    let mut output = format!(
        "browser_tab_id: {}\nurl: {}\ntitle: {}\nready_state: {}\nviewport: {}x{} @ {:.2}x\nscroll: ({:.1}, {:.1}) of ({:.1}, {:.1})\nload_wait_ms: {}\nload_timed_out: {}\nsnapshot_ms: {}\nscreenshot_ms: {}\nscreenshot_bytes: {}\n",
        capture.tab.browser_tab_id,
        snapshot.url,
        snapshot.title.as_deref().unwrap_or("null"),
        snapshot.ready_state,
        snapshot.viewport.width,
        snapshot.viewport.height,
        snapshot.viewport.device_scale_factor,
        snapshot.scroll.x,
        snapshot.scroll.y,
        snapshot.scroll.max_x,
        snapshot.scroll.max_y,
        capture.load_ms,
        capture.load_timed_out,
        capture.automation.snapshot_ms,
        capture.automation.screenshot_ms,
        capture.automation.screenshot_bytes,
    );
    output.push_str(&format!(
        "diagnostics: console_errors={} page_errors={} resource_failures={} resources={} transfer_bytes={} cls={:.4} lcp_ms={} long_tasks={} long_task_ms={:.1} horizontal_overflow_px={:.1} unlabeled_controls={} missing_alt_images={} duplicate_ids={}\n",
        diagnostics.console_errors.len(),
        diagnostics.page_errors.len(),
        diagnostics.resource_failures.len(),
        diagnostics.resource_count,
        diagnostics.transfer_bytes,
        diagnostics.cumulative_layout_shift,
        diagnostics
            .largest_contentful_paint_ms
            .map_or_else(|| "null".into(), |value| format!("{value:.1}")),
        diagnostics.long_task_count,
        diagnostics.long_task_duration_ms,
        diagnostics.horizontal_overflow_px,
        diagnostics.unlabeled_controls,
        diagnostics.missing_alt_images,
        diagnostics.duplicate_ids,
    ));
    if let Some(navigation) = diagnostics.navigation {
        output.push_str(&format!(
            "navigation: response_start_ms={:.1} dom_content_loaded_ms={:.1} load_event_ms={:.1} duration_ms={:.1}\n",
            navigation.response_start_ms,
            navigation.dom_content_loaded_ms,
            navigation.load_event_ms,
            navigation.duration_ms,
        ));
    }
    append_diagnostic_lines(&mut output, "console_error", &diagnostics.console_errors);
    append_diagnostic_lines(&mut output, "page_error", &diagnostics.page_errors);
    append_diagnostic_lines(
        &mut output,
        "resource_failure",
        &diagnostics.resource_failures,
    );
    output.push_str("\nelements:\n");
    for element in &snapshot.elements {
        output.push_str(&format!(
            "[{}] {}{} \"{}\" bounds=({:.1},{:.1},{:.1},{:.1})",
            element.reference,
            element.role,
            if element.interactive { "*" } else { "" },
            element.name,
            element.bounds.x,
            element.bounds.y,
            element.bounds.width,
            element.bounds.height,
        ));
        if let Some(kind) = element.kind.as_deref() {
            output.push_str(&format!(" type={kind}"));
        }
        if let Some(value) = element.value.as_deref() {
            output.push_str(&format!(" value={value:?}"));
        }
        if element.disabled {
            output.push_str(" disabled=true");
        }
        if let Some(checked) = element.checked {
            output.push_str(&format!(" checked={checked}"));
        }
        if let Some(href) = element.href.as_deref() {
            output.push_str(&format!(" href={href}"));
        }
        output.push('\n');
    }
    output.push_str("\nvisible_text:\n");
    output.push_str(&snapshot.text);
    output
}

fn append_diagnostic_lines(output: &mut String, label: &str, entries: &[String]) {
    for entry in entries {
        output.push_str(&format!("{label}: {entry}\n"));
    }
}

fn render_tabs(manager: &BrowserManager, conversation_id: &str) -> String {
    let topology = manager.topology(conversation_id);
    if topology.tabs.is_empty() {
        return "The built-in browser has no tabs for this conversation.".into();
    }
    let mut output = format!(
        "active_browser_tab_id: {}\ntabs:\n",
        topology.active_browser_tab_id.as_deref().unwrap_or("null")
    );
    for tab in topology.tabs {
        output.push_str(&format!(
            "- {}{} {} title={:?} loading={}\n",
            tab.browser_tab_id,
            if topology.active_browser_tab_id.as_deref() == Some(&tab.browser_tab_id) {
                " [active]"
            } else {
                ""
            },
            tab.url,
            tab.title,
            tab.is_loading,
        ));
    }
    output
}

fn render_metrics(mut metrics: Vec<BrowserActionMetric>) -> String {
    if metrics.is_empty() {
        return "No browser action metrics are available for this conversation yet.".into();
    }
    metrics.reverse();
    let total = metrics.len();
    let average = metrics.iter().map(|metric| metric.total_ms).sum::<u64>()
        / u64::try_from(total).unwrap_or(1);
    let failures = metrics
        .iter()
        .filter(|metric| matches!(metric.status, BrowserActionStatus::Failed))
        .count();
    let mut output = format!(
        "browser_metrics: samples={total} average_total_ms={average} failures={failures}\n"
    );
    for metric in metrics {
        output.push_str(&format!(
            "- {} status={:?} total_ms={} queue_ms={} action_ms={} load_ms={} snapshot_ms={} screenshot_ms={} url={} error={}\n",
            metric.action,
            metric.status,
            metric.total_ms,
            metric.queue_ms,
            metric.action_ms,
            metric.load_ms,
            metric.snapshot_ms,
            metric.screenshot_ms,
            metric.url.as_deref().unwrap_or("null"),
            metric.error.as_deref().unwrap_or("null"),
        ));
    }
    output
}

fn sanitize_metric_url(value: &str) -> Result<String, AppError> {
    let mut url = Url::parse(value)
        .map_err(|error| AppError::State(format!("browser metric URL is invalid: {error}")))?;
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

fn normalize_manage(args: BrowserManageArgs) -> Result<BrowserManageOperation, AppError> {
    let BrowserManageArgs {
        action,
        url,
        browser_tab_id,
        close_tabs,
    } = args;
    match action {
        BrowserManageAction::Open => {
            require_none("browser_tab_id", &browser_tab_id)?;
            require_none("close_tabs", &close_tabs)?;
            Ok(BrowserManageOperation::Open {
                url: url.map(|url| parse_url(&url)).transpose()?,
            })
        }
        BrowserManageAction::Navigate => {
            require_none("browser_tab_id", &browser_tab_id)?;
            require_none("close_tabs", &close_tabs)?;
            Ok(BrowserManageOperation::Navigate {
                url: parse_url(
                    url.as_deref()
                        .ok_or_else(|| AppError::Tool("navigate requires url".into()))?,
                )?,
            })
        }
        BrowserManageAction::NewTab => {
            require_none("browser_tab_id", &browser_tab_id)?;
            require_none("close_tabs", &close_tabs)?;
            Ok(BrowserManageOperation::NewTab {
                url: parse_url(url.as_deref().unwrap_or("about:blank"))?,
            })
        }
        BrowserManageAction::SelectTab => {
            require_none("url", &url)?;
            require_none("close_tabs", &close_tabs)?;
            Ok(BrowserManageOperation::SelectTab {
                browser_tab_id: validate_tab_id(
                    browser_tab_id.as_deref().ok_or_else(|| {
                        AppError::Tool("select_tab requires browser_tab_id".into())
                    })?,
                )?,
            })
        }
        BrowserManageAction::CloseTab => {
            require_none("url", &url)?;
            require_none("close_tabs", &close_tabs)?;
            Ok(BrowserManageOperation::CloseTab {
                browser_tab_id: browser_tab_id.as_deref().map(validate_tab_id).transpose()?,
            })
        }
        BrowserManageAction::CloseBrowser => {
            require_none("url", &url)?;
            require_none("browser_tab_id", &browser_tab_id)?;
            Ok(BrowserManageOperation::CloseBrowser {
                close_tabs: close_tabs.unwrap_or(false),
            })
        }
        BrowserManageAction::Back
        | BrowserManageAction::Forward
        | BrowserManageAction::Reload
        | BrowserManageAction::ListTabs => {
            require_none("url", &url)?;
            require_none("browser_tab_id", &browser_tab_id)?;
            require_none("close_tabs", &close_tabs)?;
            Ok(match action {
                BrowserManageAction::Back => BrowserManageOperation::Back,
                BrowserManageAction::Forward => BrowserManageOperation::Forward,
                BrowserManageAction::Reload => BrowserManageOperation::Reload,
                BrowserManageAction::ListTabs => BrowserManageOperation::ListTabs,
                _ => unreachable!("covered browser management action"),
            })
        }
    }
}

fn normalize_pointer(args: BrowserPointerArgs) -> Result<BrowserPointerOperation, AppError> {
    let BrowserPointerArgs {
        action,
        r#ref,
        x,
        y,
        to_ref,
        to_x,
        to_y,
        button,
        click_count,
        delta_x,
        delta_y,
    } = args;
    match action {
        BrowserPointerAction::Hover => {
            require_none("to_ref", &to_ref)?;
            require_none("to_x", &to_x)?;
            require_none("to_y", &to_y)?;
            require_none("button", &button)?;
            require_none("click_count", &click_count)?;
            require_none("delta_x", &delta_x)?;
            require_none("delta_y", &delta_y)?;
            Ok(BrowserPointerOperation::Hover {
                target: normalize_target(r#ref, x, y, true)?,
            })
        }
        BrowserPointerAction::Click => {
            require_none("to_ref", &to_ref)?;
            require_none("to_x", &to_x)?;
            require_none("to_y", &to_y)?;
            require_none("delta_x", &delta_x)?;
            require_none("delta_y", &delta_y)?;
            let click_count = click_count.unwrap_or(1);
            if !(1..=2).contains(&click_count) {
                return Err(AppError::Tool("browser click_count must be 1 or 2".into()));
            }
            Ok(BrowserPointerOperation::Click {
                target: normalize_target(r#ref, x, y, true)?,
                button: button.unwrap_or(BrowserButtonArg::Left).into(),
                click_count,
            })
        }
        BrowserPointerAction::Drag => {
            require_none("button", &button)?;
            require_none("click_count", &click_count)?;
            require_none("delta_x", &delta_x)?;
            require_none("delta_y", &delta_y)?;
            Ok(BrowserPointerOperation::Drag {
                start: normalize_target(r#ref, x, y, true)?,
                end: normalize_target(to_ref, to_x, to_y, true)?,
            })
        }
        BrowserPointerAction::Scroll => {
            require_none("to_ref", &to_ref)?;
            require_none("to_x", &to_x)?;
            require_none("to_y", &to_y)?;
            require_none("button", &button)?;
            require_none("click_count", &click_count)?;
            let delta_x = finite_bounded_delta(delta_x.unwrap_or(0.0), "delta_x")?;
            let delta_y = finite_bounded_delta(delta_y.unwrap_or(0.0), "delta_y")?;
            if delta_x == 0.0 && delta_y == 0.0 {
                return Err(AppError::Tool(
                    "browser scroll requires a non-zero delta".into(),
                ));
            }
            let target = if r#ref.is_none() && x.is_none() && y.is_none() {
                None
            } else {
                Some(normalize_target(r#ref, x, y, true)?)
            };
            Ok(BrowserPointerOperation::Scroll {
                target,
                delta_x,
                delta_y,
            })
        }
    }
}

fn normalize_type(args: BrowserTypeArgs) -> Result<BrowserTypeOperation, AppError> {
    if args.text.len() > MAX_BROWSER_TYPE_BYTES {
        return Err(AppError::Tool(format!(
            "browser text exceeds {MAX_BROWSER_TYPE_BYTES} bytes"
        )));
    }
    Ok(BrowserTypeOperation {
        target: normalize_target(args.r#ref, args.x, args.y, true)?,
        text: args.text,
        replace: args.replace,
        submit: args.submit,
    })
}

fn normalize_target(
    reference: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    required: bool,
) -> Result<BrowserTargetSelector, AppError> {
    match (reference, x, y) {
        (Some(reference), None, None) => {
            if reference.is_empty()
                || reference.len() > MAX_BROWSER_REFERENCE_BYTES
                || reference.chars().any(char::is_control)
            {
                return Err(AppError::Tool("browser element ref is invalid".into()));
            }
            Ok(BrowserTargetSelector::Reference(reference))
        }
        (None, Some(x), Some(y)) => Ok(BrowserTargetSelector::Coordinates {
            x: finite_coordinate(x, "x")?,
            y: finite_coordinate(y, "y")?,
        }),
        (None, None, None) if !required => Err(AppError::State(
            "optional browser target was normalized unexpectedly".into(),
        )),
        (None, None, None) => Err(AppError::Tool(
            "browser target requires ref or both x and y".into(),
        )),
        _ => Err(AppError::Tool(
            "browser target must use either ref or both coordinates, never both".into(),
        )),
    }
}

fn validate_key(args: &BrowserKeyArgs) -> Result<(), AppError> {
    if args.key.is_empty()
        || args.key.len() > MAX_BROWSER_KEY_BYTES
        || args.key.chars().any(char::is_control)
    {
        return Err(AppError::Tool("browser key is invalid".into()));
    }
    let mut unique = HashSet::new();
    for modifier in &args.modifiers {
        if !matches!(modifier.as_str(), "alt" | "control" | "meta" | "shift")
            || !unique.insert(modifier)
        {
            return Err(AppError::Tool(
                "browser modifiers must be unique supported values".into(),
            ));
        }
    }
    Ok(())
}

fn parse_url(value: &str) -> Result<Url, AppError> {
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(AppError::Tool("browser URL is invalid".into()));
    }
    let url = Url::parse(value)
        .map_err(|error| AppError::Tool(format!("browser URL is invalid: {error}")))?;
    let supported = matches!(url.scheme(), "http" | "https")
        || (url.scheme() == "about" && url.path() == "blank");
    if !supported || !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::Tool(
            "browser URLs must use HTTP(S) or about:blank without embedded credentials".into(),
        ));
    }
    Ok(url)
}

fn validate_tab_id(value: &str) -> Result<String, AppError> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(AppError::Tool("browser tab id is invalid".into()));
    }
    Ok(value.into())
}

fn finite_coordinate(value: f64, name: &str) -> Result<f64, AppError> {
    if !value.is_finite() || !(0.0..=MAX_BROWSER_COORDINATE).contains(&value) {
        return Err(AppError::Tool(format!(
            "browser {name} coordinate is outside the supported viewport"
        )));
    }
    Ok(value)
}

fn finite_bounded_delta(value: f64, name: &str) -> Result<f64, AppError> {
    if !value.is_finite() || value.abs() > MAX_BROWSER_SCROLL_DELTA {
        return Err(AppError::Tool(format!(
            "browser {name} is outside the supported scroll range"
        )));
    }
    Ok(value)
}

fn require_none<T>(name: &str, value: &Option<T>) -> Result<(), AppError> {
    if value.is_some() {
        Err(AppError::Tool(format!(
            "browser argument `{name}` must be null for this action"
        )))
    } else {
        Ok(())
    }
}

fn elapsed_millis(started_at: Instant) -> Result<u64, AppError> {
    u64::try_from(started_at.elapsed().as_millis())
        .map_err(|_| AppError::State("browser action duration exceeded u64".into()))
}

#[cfg(test)]
mod tests {
    use super::{
        BrowserManageArgs, BrowserManageOperation, BrowserPointerArgs, BrowserPointerOperation,
        normalize_manage, normalize_pointer,
    };

    #[test]
    fn browser_manage_contract_rejects_irrelevant_fields() {
        let operation = normalize_manage(BrowserManageArgs {
            action: super::BrowserManageAction::Navigate,
            url: Some("https://example.com".into()),
            browser_tab_id: None,
            close_tabs: None,
        })
        .expect("valid navigation");
        assert!(matches!(operation, BrowserManageOperation::Navigate { .. }));

        assert!(
            normalize_manage(BrowserManageArgs {
                action: super::BrowserManageAction::Back,
                url: Some("https://example.com".into()),
                browser_tab_id: None,
                close_tabs: None,
            })
            .is_err()
        );
    }

    #[test]
    fn browser_pointer_contract_requires_complete_targets() {
        let operation = normalize_pointer(BrowserPointerArgs {
            action: super::BrowserPointerAction::Click,
            r#ref: Some("e1".into()),
            x: None,
            y: None,
            to_ref: None,
            to_x: None,
            to_y: None,
            button: None,
            click_count: None,
            delta_x: None,
            delta_y: None,
        })
        .expect("valid click");
        assert!(matches!(operation, BrowserPointerOperation::Click { .. }));

        assert!(
            normalize_pointer(BrowserPointerArgs {
                action: super::BrowserPointerAction::Hover,
                r#ref: None,
                x: Some(10.0),
                y: None,
                to_ref: None,
                to_x: None,
                to_y: None,
                button: None,
                click_count: None,
                delta_x: None,
                delta_y: None,
            })
            .is_err()
        );
    }
}
