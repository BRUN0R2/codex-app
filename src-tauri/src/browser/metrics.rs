use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager as _};
use uuid::Uuid;

use crate::error::AppError;

const LOG_DIRECTORY: &str = "logs";
const CURRENT_METRICS_FILE: &str = "browser-actions.jsonl";
const PREVIOUS_METRICS_FILE: &str = "browser-actions.previous.jsonl";
const MAX_METRICS_LOG_BYTES: u64 = 4 * 1_048_576;
const MAX_RECENT_METRICS: usize = 240;
const MAX_METRIC_ERROR_BYTES: usize = 2_048;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BrowserActionStatus {
    Completed,
    Declined,
    Failed,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPageMetricSummary {
    pub ready_state: String,
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub interactive_elements: u32,
    pub console_errors: u32,
    pub page_errors: u32,
    pub resource_failures: u32,
    pub resource_count: u32,
    pub transfer_bytes: u64,
    pub navigation_duration_ms: Option<f64>,
    pub largest_contentful_paint_ms: Option<f64>,
    pub cumulative_layout_shift: f64,
    pub long_task_count: u32,
    pub long_task_duration_ms: f64,
    pub horizontal_overflow_px: f64,
    pub unlabeled_controls: u32,
    pub missing_alt_images: u32,
    pub duplicate_ids: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserActionMetric {
    pub id: String,
    pub session_id: String,
    pub timestamp_ms: i64,
    pub conversation_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub browser_tab_id: Option<String>,
    pub action: String,
    pub status: BrowserActionStatus,
    pub origin: Option<String>,
    pub url: Option<String>,
    pub queue_ms: u64,
    pub action_ms: u64,
    pub load_ms: u64,
    pub snapshot_ms: u64,
    pub screenshot_ms: u64,
    pub total_ms: u64,
    pub screenshot_bytes: Option<u64>,
    pub page: Option<BrowserPageMetricSummary>,
    pub error: Option<String>,
}

impl BrowserActionMetric {
    pub(crate) fn failed(
        conversation_id: &str,
        turn_id: &str,
        item_id: &str,
        action: &str,
        queue_ms: u64,
        total_ms: u64,
        error: &AppError,
    ) -> Self {
        Self {
            id: Uuid::now_v7().to_string(),
            session_id: String::new(),
            timestamp_ms: Utc::now().timestamp_millis(),
            conversation_id: conversation_id.into(),
            turn_id: turn_id.into(),
            item_id: item_id.into(),
            browser_tab_id: None,
            action: action.into(),
            status: BrowserActionStatus::Failed,
            origin: None,
            url: None,
            queue_ms,
            action_ms: total_ms.saturating_sub(queue_ms),
            load_ms: 0,
            snapshot_ms: 0,
            screenshot_ms: 0,
            total_ms,
            screenshot_bytes: None,
            page: None,
            error: Some(truncate_utf8(&error.to_string(), MAX_METRIC_ERROR_BYTES)),
        }
    }
}

struct BrowserMetricsState {
    path: Option<PathBuf>,
    session_id: String,
    recent: VecDeque<BrowserActionMetric>,
}

impl Default for BrowserMetricsState {
    fn default() -> Self {
        Self {
            path: None,
            session_id: Uuid::now_v7().to_string(),
            recent: VecDeque::new(),
        }
    }
}

#[derive(Default)]
pub(crate) struct BrowserMetrics {
    state: Mutex<BrowserMetricsState>,
}

impl BrowserMetrics {
    pub(crate) fn initialize(&self, app: &AppHandle) -> Result<String, AppError> {
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|error| AppError::FileSystem(error.to_string()))?
            .join(LOG_DIRECTORY);
        fs::create_dir_all(&directory).map_err(|error| {
            AppError::FileSystem(format!(
                "could not create browser metrics directory `{}`: {error}",
                directory.display()
            ))
        })?;
        let path = directory.join(CURRENT_METRICS_FILE);
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| {
                AppError::FileSystem(format!(
                    "could not open browser metrics log `{}`: {error}",
                    path.display()
                ))
            })?;
        self.state
            .lock()
            .map_err(|_| AppError::State("browser metrics ownership was poisoned".into()))?
            .path = Some(path.clone());
        Ok(path.to_string_lossy().into_owned())
    }

    pub(crate) fn record(
        &self,
        mut metric: BrowserActionMetric,
    ) -> Result<BrowserActionMetric, AppError> {
        let (path, encoded) =
            {
                let mut state = self.state.lock().map_err(|_| {
                    AppError::State("browser metrics ownership was poisoned".into())
                })?;
                metric.session_id.clone_from(&state.session_id);
                if state.recent.len() == MAX_RECENT_METRICS {
                    state.recent.pop_front();
                }
                state.recent.push_back(metric.clone());
                let path = state.path.clone().ok_or_else(|| {
                    AppError::State("browser metrics log is not initialized".into())
                })?;
                let mut encoded = serde_json::to_vec(&metric).map_err(|error| {
                    AppError::State(format!("browser metric could not be encoded: {error}"))
                })?;
                encoded.push(b'\n');
                (path, encoded)
            };
        append_rotating(&path, &encoded)?;
        Ok(metric)
    }

    pub(crate) fn recent(&self, conversation_id: &str) -> Vec<BrowserActionMetric> {
        self.state
            .lock()
            .map(|state| {
                state
                    .recent
                    .iter()
                    .filter(|metric| metric.conversation_id == conversation_id)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn append_rotating(path: &Path, encoded: &[u8]) -> Result<(), AppError> {
    let current_bytes = match fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => {
            return Err(AppError::FileSystem(format!(
                "could not inspect browser metrics log `{}`: {error}",
                path.display()
            )));
        }
    };
    if current_bytes.saturating_add(encoded.len() as u64) > MAX_METRICS_LOG_BYTES
        && current_bytes > 0
    {
        let previous = path.with_file_name(PREVIOUS_METRICS_FILE);
        match fs::remove_file(&previous) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(AppError::FileSystem(format!(
                    "could not replace previous browser metrics log `{}`: {error}",
                    previous.display()
                )));
            }
        }
        fs::rename(path, &previous).map_err(|error| {
            AppError::FileSystem(format!(
                "could not rotate browser metrics log `{}`: {error}",
                path.display()
            ))
        })?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| {
            AppError::FileSystem(format!(
                "could not append browser metrics log `{}`: {error}",
                path.display()
            ))
        })?;
    file.write_all(encoded).map_err(|error| {
        AppError::FileSystem(format!(
            "could not write browser metrics log `{}`: {error}",
            path.display()
        ))
    })?;
    file.flush().map_err(|error| {
        AppError::FileSystem(format!(
            "could not flush browser metrics log `{}`: {error}",
            path.display()
        ))
    })
}

fn truncate_utf8(value: &str, maximum_bytes: usize) -> String {
    if value.len() <= maximum_bytes {
        return value.to_string();
    }
    let mut boundary = maximum_bytes;
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value[..boundary].to_string()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use uuid::Uuid;

    use super::{BrowserActionMetric, BrowserActionStatus, BrowserMetrics, append_rotating};

    #[test]
    fn browser_metrics_are_bounded_and_rotated() {
        let directory =
            std::env::temp_dir().join(format!("codex-browser-metrics-{}", Uuid::now_v7()));
        fs::create_dir_all(&directory).expect("temporary metrics directory");
        let path = directory.join(super::CURRENT_METRICS_FILE);
        append_rotating(&path, b"first\n").expect("first metric");
        let oversized = vec![b'x'; super::MAX_METRICS_LOG_BYTES as usize];
        append_rotating(&path, &oversized).expect("rotation");
        assert!(directory.join(super::PREVIOUS_METRICS_FILE).is_file());
        fs::remove_dir_all(directory).expect("temporary metrics directory removed");
    }

    #[test]
    fn browser_metrics_keep_only_the_recent_window() {
        let metrics = BrowserMetrics::default();
        {
            let mut state = metrics.state.lock().expect("metrics state");
            state.path = Some(
                std::env::temp_dir()
                    .join(format!("codex-browser-metrics-{}.jsonl", Uuid::now_v7())),
            );
        }
        for index in 0..=super::MAX_RECENT_METRICS {
            metrics
                .record(BrowserActionMetric {
                    id: Uuid::now_v7().to_string(),
                    session_id: String::new(),
                    timestamp_ms: index as i64,
                    conversation_id: "thread".into(),
                    turn_id: "turn".into(),
                    item_id: format!("item-{index}"),
                    browser_tab_id: None,
                    action: "snapshot".into(),
                    status: BrowserActionStatus::Completed,
                    origin: None,
                    url: None,
                    queue_ms: 0,
                    action_ms: 1,
                    load_ms: 0,
                    snapshot_ms: 1,
                    screenshot_ms: 0,
                    total_ms: 1,
                    screenshot_bytes: None,
                    page: None,
                    error: None,
                })
                .expect("metric should persist");
        }
        assert_eq!(metrics.recent("thread").len(), super::MAX_RECENT_METRICS);
        if let Some(path) = metrics.state.lock().expect("metrics state").path.clone() {
            let _ = fs::remove_file(path);
        }
    }
}
