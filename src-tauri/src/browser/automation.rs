use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::webview::Webview;
use tokio::time::{sleep, timeout};

use super::BrowserViewport;
use crate::error::AppError;

const WEBVIEW_OPERATION_TIMEOUT: Duration = Duration::from_secs(15);
const CURSOR_MOVE_DURATION: Duration = Duration::from_millis(180);
const CURSOR_MOVE_STEPS: u32 = 10;
const POINTER_PRESS_DURATION: Duration = Duration::from_millis(45);
const POST_ACTION_SETTLE_DURATION: Duration = Duration::from_millis(180);
const DRAG_MOVE_DURATION: Duration = Duration::from_millis(260);
const DRAG_STEPS: u32 = 14;
const MAX_SCREENSHOT_BASE64_BYTES: usize = 1_300_000;
const SCREENSHOT_QUALITIES: [u8; 3] = [72, 52, 36];

pub(crate) const BROWSER_AGENT_INITIALIZATION_SCRIPT: &str = r##"
(() => {
  const stateKey = Symbol.for("codex.desktop.browser-agent.v1");
  if (globalThis[stateKey]) {
    return;
  }

  const boundedText = (value, maximum = 1200) => {
    let text;
    try {
      if (value instanceof Error) {
        text = value.stack || value.message || String(value);
      } else if (typeof value === "string") {
        text = value;
      } else {
        text = JSON.stringify(value);
      }
    } catch {
      text = String(value);
    }
    return String(text ?? "").replace(/\s+/gu, " ").trim().slice(0, maximum);
  };

  const pushBounded = (collection, value, maximum = 40) => {
    const text = boundedText(value);
    if (!text) {
      return;
    }
    collection.push(text);
    if (collection.length > maximum) {
      collection.splice(0, collection.length - maximum);
    }
  };

  const state = {
    refs: new Map(),
    reverseRefs: new WeakMap(),
    nextRef: 1,
    consoleErrors: [],
    pageErrors: [],
    resourceFailures: [],
    cumulativeLayoutShift: 0,
    largestContentfulPaintMs: null,
    longTaskCount: 0,
    longTaskDurationMs: 0,
    cursorHost: null,
    cursorNode: null,
    cursorLabel: null,
    cursorAnimation: null,
    cursorX: -80,
    cursorY: -80,
    cursorVisible: false,
  };

  Object.defineProperty(globalThis, stateKey, {
    configurable: false,
    enumerable: false,
    value: state,
    writable: false,
  });

  const originalConsoleError = console.error.bind(console);
  console.error = (...args) => {
    pushBounded(state.consoleErrors, args.map((entry) => boundedText(entry, 500)).join(" "));
    return originalConsoleError(...args);
  };

  addEventListener("error", (event) => {
    if (event.target && event.target !== globalThis) {
      const target = event.target;
      const source = target.currentSrc || target.src || target.href || target.tagName;
      pushBounded(state.resourceFailures, source);
      return;
    }
    pushBounded(
      state.pageErrors,
      event.error?.stack || `${event.message || "Script error"} at ${event.filename || "unknown"}:${event.lineno || 0}:${event.colno || 0}`,
    );
  }, true);

  addEventListener("unhandledrejection", (event) => {
    pushBounded(state.pageErrors, event.reason);
  });

  try {
    const layoutShiftObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          state.cumulativeLayoutShift += entry.value || 0;
        }
      }
    });
    layoutShiftObserver.observe({ type: "layout-shift", buffered: true });
  } catch {}

  try {
    const paintObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const latest = entries[entries.length - 1];
      if (latest) {
        state.largestContentfulPaintMs = latest.startTime;
      }
    });
    paintObserver.observe({ type: "largest-contentful-paint", buffered: true });
  } catch {}

  try {
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTaskCount += 1;
        state.longTaskDurationMs += entry.duration || 0;
      }
    });
    longTaskObserver.observe({ type: "longtask", buffered: true });
  } catch {}

  const ensureCursor = () => {
    if (state.cursorHost?.isConnected && state.cursorNode) {
      return state.cursorNode;
    }
    const parent = document.documentElement || document.body;
    if (!parent) {
      return null;
    }

    const host = document.createElement("div");
    host.setAttribute("data-codex-agent-cursor", "");
    Object.assign(host.style, {
      all: "initial",
      display: "block",
      left: "0",
      pointerEvents: "none",
      position: "fixed",
      top: "0",
      transform: "translate3d(-80px, -80px, 0)",
      transition: "opacity 120ms ease",
      zIndex: "2147483647",
      opacity: "0",
    });

    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { color-scheme: dark; }
      .pointer {
        position: relative;
        width: 30px;
        height: 38px;
        filter:
          drop-shadow(0 0 4px rgb(255 115 0 / 1))
          drop-shadow(0 0 12px rgb(255 76 0 / .82))
          drop-shadow(0 4px 4px rgb(0 0 0 / .68));
      }
      svg { display: block; overflow: visible; }
      .badge {
        position: absolute;
        top: 29px;
        left: 22px;
        max-width: 150px;
        padding: 2px 8px;
        overflow: hidden;
        border: 1px solid rgb(255 112 0 / .86);
        border-radius: 999px;
        background: rgb(17 8 3 / .96);
        color: #ffe3c2;
        box-shadow:
          0 0 0 1px rgb(0 0 0 / .46) inset,
          0 0 12px rgb(255 76 0 / .52);
        font: 650 11px/15px system-ui, sans-serif;
        letter-spacing: .01em;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `;
    const pointer = document.createElement("div");
    pointer.className = "pointer";
    pointer.innerHTML = `
      <svg aria-hidden="true" width="30" height="38" viewBox="0 0 30 38">
        <defs>
          <filter id="codex-neon-halo" x="-80%" y="-70%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="2.8"/>
          </filter>
        </defs>
        <path d="M3.2 2.8 26.2 21.3l-10.4 1.5-5 10.3L3.2 2.8Z" fill="#ff6200" stroke="#ff6200" stroke-width="7" stroke-linejoin="round" opacity=".62" filter="url(#codex-neon-halo)"/>
        <path d="M3.2 2.8 26.2 21.3l-10.4 1.5-5 10.3L3.2 2.8Z" fill="#ff6800" stroke="#160801" stroke-width="5" stroke-linejoin="round"/>
        <path d="M3.2 2.8 26.2 21.3l-10.4 1.5-5 10.3L3.2 2.8Z" fill="#ff6800" stroke="#fff0df" stroke-width="2.4" stroke-linejoin="round"/>
        <path d="m15.8 23 6.1 8.3" stroke="#160801" stroke-width="5" stroke-linecap="round"/>
        <path d="m15.8 23 6.1 8.3" stroke="#ff7a12" stroke-width="2.2" stroke-linecap="round"/>
      </svg>
      <span class="badge">Codex</span>
    `;
    shadow.append(style, pointer);
    parent.append(host);
    state.cursorHost = host;
    state.cursorNode = pointer;
    state.cursorLabel = pointer.querySelector(".badge");
    return pointer;
  };

  state.moveCursor = (x, y, label = "Codex", duration = 180) => {
    ensureCursor();
    if (!state.cursorHost) {
      return { x: 0, y: 0, visible: false };
    }
    if (state.cursorLabel) {
      state.cursorLabel.textContent = boundedText(label, 80) || "Codex";
    }
    const targetX = Math.round(Number(x) || 0);
    const targetY = Math.round(Number(y) || 0);
    const requestedDuration = Math.min(600, Math.max(0, Number(duration) || 0));
    const motionDuration = matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 0
      : requestedDuration;
    const previous = {
      x: state.cursorVisible ? state.cursorX : targetX,
      y: state.cursorVisible ? state.cursorY : targetY,
      visible: state.cursorVisible,
    };
    state.cursorAnimation?.cancel();
    state.cursorHost.style.opacity = "1";
    const targetTransform = `translate3d(${targetX}px, ${targetY}px, 0)`;
    if (state.cursorVisible && motionDuration > 0) {
      const animation = state.cursorHost.animate(
        [
          { transform: `translate3d(${state.cursorX}px, ${state.cursorY}px, 0)` },
          { transform: targetTransform },
        ],
        {
          duration: motionDuration,
          easing: "cubic-bezier(.22,1,.36,1)",
          fill: "both",
        },
      );
      state.cursorAnimation = animation;
      animation.addEventListener("finish", () => {
        if (state.cursorAnimation === animation) {
          state.cursorHost.style.transform = targetTransform;
          state.cursorAnimation = null;
          animation.cancel();
        }
      }, { once: true });
    } else {
      state.cursorHost.style.transform = targetTransform;
    }
    state.cursorX = targetX;
    state.cursorY = targetY;
    state.cursorVisible = true;
    return previous;
  };

  if (document.documentElement) {
    ensureCursor();
  } else {
    addEventListener("DOMContentLoaded", ensureCursor, { once: true });
  }
})();
"##;

const PAGE_SNAPSHOT_SCRIPT: &str = r#"
(() => {
  const state = globalThis[Symbol.for("codex.desktop.browser-agent.v1")];
  if (!state) {
    return { __codexError: "browser agent initialization state is unavailable" };
  }

  const normalizeText = (value, maximum = 240) =>
    String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, maximum);
  const viewportWidth = Math.max(1, Math.round(globalThis.visualViewport?.width || innerWidth || 1));
  const viewportHeight = Math.max(1, Math.round(globalThis.visualViewport?.height || innerHeight || 1));
  const styleVisible = (element, rect) => {
    const style = getComputedStyle(element);
    return style.display !== "none"
      && style.visibility !== "hidden"
      && Number(style.opacity || "1") > 0
      && rect.width > 0
      && rect.height > 0
      && rect.bottom >= 0
      && rect.right >= 0
      && rect.top <= viewportHeight
      && rect.left <= viewportWidth;
  };
  const roleFor = (element) => {
    const explicit = normalizeText(element.getAttribute("role"), 80);
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "summary") return "button";
    if (/^h[1-6]$/u.test(tag)) return "heading";
    if (tag === "img") return "img";
    if (tag === "input") {
      const type = (element.type || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["button", "submit", "reset"].includes(type)) return "button";
      if (type === "range") return "slider";
      return "textbox";
    }
    return tag;
  };
  const referencedLabel = (element) => {
    const ids = normalizeText(element.getAttribute("aria-labelledby"), 500).split(" ").filter(Boolean);
    return ids.map((id) => normalizeText(document.getElementById(id)?.innerText, 160)).filter(Boolean).join(" ");
  };
  const nameFor = (element) => {
    const aria = normalizeText(element.getAttribute("aria-label"), 200);
    if (aria) return aria;
    const referenced = referencedLabel(element);
    if (referenced) return referenced;
    if (element.labels?.length) {
      const label = normalizeText(Array.from(element.labels).map((entry) => entry.innerText).join(" "), 200);
      if (label) return label;
    }
    const alternative = normalizeText(element.alt || element.placeholder || element.title, 200);
    if (alternative) return alternative;
    if (element.tagName === "INPUT" && ["button", "submit", "reset"].includes((element.type || "").toLowerCase())) {
      return normalizeText(element.value, 200);
    }
    return normalizeText(element.innerText || element.textContent, 200);
  };
  const referenceFor = (element) => {
    let reference = state.reverseRefs.get(element);
    if (!reference) {
      reference = `e${state.nextRef++}`;
      state.reverseRefs.set(element, reference);
    }
    state.refs.set(reference, element);
    return reference;
  };
  const snapshotElement = (element) => {
    const rect = element.getBoundingClientRect();
    if (!styleVisible(element, rect)) return null;
    const type = element.tagName === "INPUT" ? (element.type || "text").toLowerCase() : null;
    const value = type === "password"
      ? (element.value ? "••••••••" : "")
      : normalizeText(element.value, 240);
    return {
      ref: referenceFor(element),
      role: roleFor(element),
      name: nameFor(element),
      tag: element.tagName.toLowerCase(),
      kind: type,
      value: value || null,
      checked: typeof element.checked === "boolean" ? element.checked : null,
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      selected: typeof element.selected === "boolean" ? element.selected : null,
      href: element.href ? normalizeText(element.href, 2048) : null,
      interactive: element.matches(
        'a[href],button,input,textarea,select,summary,[contenteditable="true"],[tabindex]:not([tabindex="-1"]),[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="combobox"],[role="textbox"],[role="slider"],[role="switch"],[role="tab"],[role="menuitem"]',
      ),
      bounds: {
        x: Math.round(rect.left * 10) / 10,
        y: Math.round(rect.top * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
      },
    };
  };

  state.refs.clear();
  const selector = [
    "a[href]",
    "button",
    'input:not([type="hidden"])',
    "textarea",
    "select",
    "summary",
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="combobox"]',
    '[role="textbox"]',
    '[role="slider"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="menuitem"]',
    "h1",
    "h2",
    "h3",
    '[role="heading"]',
    "img",
  ].join(",");
  const elements = [];
  const seen = new Set();
  for (const element of document.querySelectorAll(selector)) {
    if (seen.has(element)) continue;
    seen.add(element);
    const snapshot = snapshotElement(element);
    if (snapshot) elements.push(snapshot);
    if (elements.length >= 240) break;
  }

  const active = document.activeElement && document.activeElement !== document.body
    ? snapshotElement(document.activeElement)
    : null;
  const root = document.documentElement;
  const body = document.body;
  const navigation = performance.getEntriesByType("navigation")[0] || null;
  const resources = performance.getEntriesByType("resource");
  const transferBytes = resources.reduce((total, entry) => total + (entry.transferSize || 0), 0);
  const controls = Array.from(document.querySelectorAll("button,input,textarea,select,[role=button],[role=textbox],[role=combobox]"));
  const unlabeledControls = controls.filter((element) => {
    const rect = element.getBoundingClientRect();
    return styleVisible(element, rect) && !nameFor(element);
  }).length;
  const images = Array.from(document.images);
  const missingAltImages = images.filter((image) => {
    const rect = image.getBoundingClientRect();
    return styleVisible(image, rect) && !normalizeText(image.alt, 10);
  }).length;
  const idCounts = new Map();
  for (const element of document.querySelectorAll("[id]")) {
    idCounts.set(element.id, (idCounts.get(element.id) || 0) + 1);
  }
  const duplicateIds = Array.from(idCounts.values()).filter((count) => count > 1).length;
  const scrollWidth = Math.max(root?.scrollWidth || 0, body?.scrollWidth || 0, viewportWidth);
  const scrollHeight = Math.max(root?.scrollHeight || 0, body?.scrollHeight || 0, viewportHeight);

  return {
    url: location.href,
    title: document.title || null,
    readyState: document.readyState,
    viewport: {
      width: viewportWidth,
      height: viewportHeight,
      deviceScaleFactor: devicePixelRatio || 1,
    },
    scroll: {
      x: Math.round(scrollX * 10) / 10,
      y: Math.round(scrollY * 10) / 10,
      maxX: Math.max(0, scrollWidth - viewportWidth),
      maxY: Math.max(0, scrollHeight - viewportHeight),
    },
    activeElement: active,
    elements,
    text: normalizeText(body?.innerText || root?.innerText || "", 8000),
    diagnostics: {
      consoleErrors: state.consoleErrors.slice(-20),
      pageErrors: state.pageErrors.slice(-20),
      resourceFailures: state.resourceFailures.slice(-20),
      navigation: navigation ? {
        responseStartMs: Math.round(navigation.responseStart * 10) / 10,
        domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd * 10) / 10,
        loadEventMs: Math.round(navigation.loadEventEnd * 10) / 10,
        durationMs: Math.round(navigation.duration * 10) / 10,
      } : null,
      resourceCount: resources.length,
      transferBytes,
      cumulativeLayoutShift: Math.round(state.cumulativeLayoutShift * 10000) / 10000,
      largestContentfulPaintMs: state.largestContentfulPaintMs == null
        ? null
        : Math.round(state.largestContentfulPaintMs * 10) / 10,
      longTaskCount: state.longTaskCount,
      longTaskDurationMs: Math.round(state.longTaskDurationMs * 10) / 10,
      horizontalOverflowPx: Math.max(0, Math.round((scrollWidth - viewportWidth) * 10) / 10),
      unlabeledControls,
      missingAltImages,
      duplicateIds,
    },
  };
})()
"#;

#[derive(Debug, Clone)]
pub(crate) enum BrowserTargetSelector {
    Reference(String),
    Coordinates { x: f64, y: f64 },
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum BrowserMouseButton {
    Left,
    Middle,
    Right,
}

impl BrowserMouseButton {
    fn cdp_name(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Middle => "middle",
            Self::Right => "right",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPageSnapshot {
    pub url: String,
    pub title: Option<String>,
    pub ready_state: String,
    pub viewport: BrowserViewportSnapshot,
    pub scroll: BrowserScrollSnapshot,
    pub active_element: Option<BrowserElementSnapshot>,
    pub elements: Vec<BrowserElementSnapshot>,
    pub text: String,
    pub diagnostics: BrowserPageDiagnostics,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserViewportSnapshot {
    pub width: u32,
    pub height: u32,
    pub device_scale_factor: f64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserScrollSnapshot {
    pub x: f64,
    pub y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserElementSnapshot {
    #[serde(rename = "ref")]
    pub reference: String,
    pub role: String,
    pub name: String,
    pub tag: String,
    pub kind: Option<String>,
    pub value: Option<String>,
    pub checked: Option<bool>,
    pub disabled: bool,
    pub selected: Option<bool>,
    pub href: Option<String>,
    pub interactive: bool,
    pub bounds: BrowserElementBounds,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserElementBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPageDiagnostics {
    pub console_errors: Vec<String>,
    pub page_errors: Vec<String>,
    pub resource_failures: Vec<String>,
    pub navigation: Option<BrowserNavigationTiming>,
    pub resource_count: u32,
    pub transfer_bytes: u64,
    pub cumulative_layout_shift: f64,
    pub largest_contentful_paint_ms: Option<f64>,
    pub long_task_count: u32,
    pub long_task_duration_ms: f64,
    pub horizontal_overflow_px: f64,
    pub unlabeled_controls: u32,
    pub missing_alt_images: u32,
    pub duplicate_ids: u32,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserNavigationTiming {
    pub response_start_ms: f64,
    pub dom_content_loaded_ms: f64,
    pub load_event_ms: f64,
    pub duration_ms: f64,
}

#[derive(Debug, Clone)]
pub(crate) struct BrowserResolvedTarget {
    pub x: f64,
    pub y: f64,
    pub label: String,
}

#[derive(Debug, Clone)]
pub(crate) struct BrowserAutomationCapture {
    pub snapshot: BrowserPageSnapshot,
    pub snapshot_ms: u64,
    pub screenshot: Option<BrowserScreenshotCapture>,
}

#[derive(Debug, Clone)]
pub(crate) struct BrowserScreenshotCapture {
    pub image_url: String,
    pub bytes: usize,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BrowserCaptureMode {
    Snapshot,
    SnapshotAndScreenshot,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedTargetPayload {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    x: Option<f64>,
    #[serde(default)]
    y: Option<f64>,
    #[serde(default)]
    label: Option<String>,
}

pub(crate) async fn capture(
    webview: &Webview,
    mode: BrowserCaptureMode,
) -> Result<BrowserAutomationCapture, AppError> {
    let snapshot_started = Instant::now();
    let snapshot = evaluate_json(webview, PAGE_SNAPSHOT_SCRIPT).await?;
    let snapshot_ms = elapsed_millis(snapshot_started)?;

    let screenshot = match mode {
        BrowserCaptureMode::Snapshot => None,
        BrowserCaptureMode::SnapshotAndScreenshot => {
            let screenshot_started = Instant::now();
            let image_url = capture_screenshot(webview).await?;
            Some(BrowserScreenshotCapture {
                bytes: image_url.len(),
                duration_ms: elapsed_millis(screenshot_started)?,
                image_url,
            })
        }
    };

    Ok(BrowserAutomationCapture {
        snapshot,
        snapshot_ms,
        screenshot,
    })
}

pub(crate) async fn set_viewport_override(
    webview: &Webview,
    viewport: Option<BrowserViewport>,
) -> Result<(), AppError> {
    match viewport {
        Some(viewport) => {
            call_cdp(
                webview,
                "Emulation.setDeviceMetricsOverride",
                json!({
                    "width": viewport.width,
                    "height": viewport.height,
                    "deviceScaleFactor": 1,
                    "mobile": false,
                    "scale": viewport.scale,
                    "screenWidth": viewport.width,
                    "screenHeight": viewport.height,
                }),
            )
            .await?;
        }
        None => {
            call_cdp(webview, "Emulation.clearDeviceMetricsOverride", json!({})).await?;
        }
    }
    Ok(())
}

pub(crate) async fn resolve_target(
    webview: &Webview,
    selector: &BrowserTargetSelector,
) -> Result<BrowserResolvedTarget, AppError> {
    let selector = match selector {
        BrowserTargetSelector::Reference(reference) => json!({
            "ref": reference,
            "x": Value::Null,
            "y": Value::Null,
        }),
        BrowserTargetSelector::Coordinates { x, y } => json!({
            "ref": Value::Null,
            "x": x,
            "y": y,
        }),
    };
    let encoded = serde_json::to_string(&selector)
        .map_err(|error| AppError::Tool(format!("browser target could not be encoded: {error}")))?;
    let script = format!(
        r#"
(() => {{
  const state = globalThis[Symbol.for("codex.desktop.browser-agent.v1")];
  if (!state) return {{ error: "browser agent initialization state is unavailable" }};
  const target = {encoded};
  let element = null;
  if (target.ref) {{
    element = state.refs.get(target.ref) || null;
    if (!element || !element.isConnected) {{
      return {{ error: `browser element reference ${{target.ref}} is stale; capture a new snapshot` }};
    }}
  }} else {{
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {{
      return {{ error: "browser coordinates must be finite" }};
    }}
    element = document.elementFromPoint(target.x, target.y);
    if (!element) {{
      return {{ error: "no browser element exists at the requested coordinates" }};
    }}
  }}
  element.scrollIntoView({{ block: "center", inline: "center", behavior: "instant" }});
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {{
    return {{ error: "browser target is not visible" }};
  }}
  const anchor = element.closest?.("a[href]") || null;
  const form = element.closest?.("form") || null;
  const navigationUrl = anchor?.href || (
    form && (element.matches("button,input[type=submit],input[type=image]") || element.getAttribute("type") === "submit")
      ? form.action
      : null
  );
  const label = String(
    element.getAttribute?.("aria-label")
      || element.innerText
      || element.textContent
      || element.getAttribute?.("title")
      || element.tagName
      || "element"
  ).replace(/\s+/gu, " ").trim().slice(0, 80);
  return {{
    x: Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
    y: Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)),
    label,
    navigationUrl: navigationUrl || null,
    opensNewWindow: Boolean(
      anchor?.target === "_blank"
      || form?.target === "_blank"
    ),
  }};
}})()
"#
    );
    let payload: ResolvedTargetPayload = evaluate_json(webview, &script).await?;
    if let Some(error) = payload.error {
        return Err(AppError::Tool(error));
    }
    let x = payload
        .x
        .filter(|value| value.is_finite())
        .ok_or_else(|| AppError::Tool("browser target did not resolve an x coordinate".into()))?;
    let y = payload
        .y
        .filter(|value| value.is_finite())
        .ok_or_else(|| AppError::Tool("browser target did not resolve a y coordinate".into()))?;
    Ok(BrowserResolvedTarget {
        x,
        y,
        label: payload.label.unwrap_or_else(|| "element".into()),
    })
}

pub(crate) async fn hover(
    webview: &Webview,
    target: &BrowserResolvedTarget,
) -> Result<(), AppError> {
    move_pointer(webview, target.x, target.y, &target.label, 0).await?;
    sleep(POST_ACTION_SETTLE_DURATION).await;
    Ok(())
}

pub(crate) async fn click(
    webview: &Webview,
    target: &BrowserResolvedTarget,
    button: BrowserMouseButton,
    click_count: u8,
) -> Result<(), AppError> {
    move_pointer(webview, target.x, target.y, &target.label, 0).await?;
    for count in 1..=click_count {
        dispatch_mouse(
            webview,
            json!({
                "type": "mousePressed",
                "x": target.x,
                "y": target.y,
                "button": button.cdp_name(),
                "buttons": button_mask(button),
                "clickCount": count,
            }),
        )
        .await?;
        sleep(POINTER_PRESS_DURATION).await;
        dispatch_mouse(
            webview,
            json!({
                "type": "mouseReleased",
                "x": target.x,
                "y": target.y,
                "button": button.cdp_name(),
                "buttons": 0,
                "clickCount": count,
            }),
        )
        .await?;
        if count < click_count {
            sleep(Duration::from_millis(70)).await;
        }
    }
    sleep(POST_ACTION_SETTLE_DURATION).await;
    Ok(())
}

pub(crate) async fn type_text(
    webview: &Webview,
    target: &BrowserResolvedTarget,
    text: &str,
    replace: bool,
    submit: bool,
) -> Result<(), AppError> {
    click(webview, target, BrowserMouseButton::Left, 1).await?;
    if replace {
        press_key(webview, "a", &["control".into()]).await?;
        press_key(webview, "Backspace", &[]).await?;
    }
    call_cdp(webview, "Input.insertText", json!({ "text": text })).await?;
    if submit {
        press_key(webview, "Enter", &[]).await?;
    }
    sleep(POST_ACTION_SETTLE_DURATION).await;
    Ok(())
}

pub(crate) async fn press_key(
    webview: &Webview,
    key: &str,
    modifiers: &[String],
) -> Result<(), AppError> {
    let descriptor = key_descriptor(key)?;
    let modifiers = modifier_mask(modifiers)?;
    let mut key_down = json!({
        "type": if descriptor.text.is_some() { "keyDown" } else { "rawKeyDown" },
        "key": descriptor.key,
        "code": descriptor.code,
        "windowsVirtualKeyCode": descriptor.virtual_key,
        "nativeVirtualKeyCode": descriptor.virtual_key,
        "modifiers": modifiers,
    });
    if modifiers == 0
        && let Some(text) = descriptor.text
    {
        key_down["text"] = Value::String(text.clone());
        key_down["unmodifiedText"] = Value::String(text);
    }
    call_cdp(webview, "Input.dispatchKeyEvent", key_down).await?;
    call_cdp(
        webview,
        "Input.dispatchKeyEvent",
        json!({
            "type": "keyUp",
            "key": descriptor.key,
            "code": descriptor.code,
            "windowsVirtualKeyCode": descriptor.virtual_key,
            "nativeVirtualKeyCode": descriptor.virtual_key,
            "modifiers": modifiers,
        }),
    )
    .await?;
    sleep(Duration::from_millis(60)).await;
    Ok(())
}

pub(crate) async fn scroll(
    webview: &Webview,
    x: f64,
    y: f64,
    delta_x: f64,
    delta_y: f64,
) -> Result<(), AppError> {
    move_pointer(webview, x, y, "Rolagem do Codex", 0).await?;
    dispatch_mouse(
        webview,
        json!({
            "type": "mouseWheel",
            "x": x,
            "y": y,
            "deltaX": delta_x,
            "deltaY": delta_y,
            "button": "none",
            "buttons": 0,
        }),
    )
    .await?;
    sleep(POST_ACTION_SETTLE_DURATION).await;
    Ok(())
}

pub(crate) async fn drag(
    webview: &Webview,
    start: &BrowserResolvedTarget,
    end: &BrowserResolvedTarget,
) -> Result<(), AppError> {
    move_pointer(webview, start.x, start.y, &start.label, 0).await?;
    dispatch_mouse(
        webview,
        json!({
            "type": "mousePressed",
            "x": start.x,
            "y": start.y,
            "button": "left",
            "buttons": 1,
            "clickCount": 1,
        }),
    )
    .await?;
    move_pointer_with_timing(
        webview,
        end.x,
        end.y,
        "Arraste do Codex",
        1,
        DRAG_MOVE_DURATION,
        DRAG_STEPS,
    )
    .await?;
    dispatch_mouse(
        webview,
        json!({
            "type": "mouseReleased",
            "x": end.x,
            "y": end.y,
            "button": "left",
            "buttons": 0,
            "clickCount": 1,
        }),
    )
    .await?;
    sleep(POST_ACTION_SETTLE_DURATION).await;
    Ok(())
}

pub(crate) async fn viewport_center(webview: &Webview) -> Result<(f64, f64), AppError> {
    #[derive(Deserialize)]
    struct Center {
        x: f64,
        y: f64,
    }
    let center: Center = evaluate_json(
        webview,
        "(() => ({ x: Math.max(0, innerWidth / 2), y: Math.max(0, innerHeight / 2) }))()",
    )
    .await?;
    Ok((center.x, center.y))
}

pub(crate) async fn stop_loading(webview: &Webview) -> Result<(), AppError> {
    call_cdp(webview, "Page.stopLoading", json!({}))
        .await
        .map(|_| ())
}

async fn move_pointer(
    webview: &Webview,
    x: f64,
    y: f64,
    label: &str,
    buttons: u8,
) -> Result<(), AppError> {
    move_pointer_with_timing(
        webview,
        x,
        y,
        label,
        buttons,
        CURSOR_MOVE_DURATION,
        CURSOR_MOVE_STEPS,
    )
    .await
}

async fn move_pointer_with_timing(
    webview: &Webview,
    x: f64,
    y: f64,
    label: &str,
    buttons: u8,
    duration: Duration,
    steps: u32,
) -> Result<(), AppError> {
    #[derive(Deserialize)]
    struct CursorOrigin {
        x: f64,
        y: f64,
        visible: bool,
    }

    let label = serde_json::to_string(label)
        .map_err(|error| AppError::Tool(format!("browser cursor label is invalid: {error}")))?;
    let origin: CursorOrigin = evaluate_json(
        webview,
        &format!(
            "(() => globalThis[Symbol.for(\"codex.desktop.browser-agent.v1\")]?.moveCursor({x}, {y}, {label}, {}) ?? {{ x: {x}, y: {y}, visible: false }})()",
            duration.as_millis(),
        ),
    )
    .await?;
    let samples = if origin.visible {
        cursor_motion_samples(origin.x, origin.y, x, y, steps)
    } else {
        vec![(x, y)]
    };
    let step_duration = if origin.visible && !samples.is_empty() {
        Duration::from_secs_f64(duration.as_secs_f64() / samples.len() as f64)
    } else {
        Duration::from_millis(28)
    };
    for (sample_x, sample_y) in samples {
        dispatch_mouse(
            webview,
            json!({
                "type": "mouseMoved",
                "x": sample_x,
                "y": sample_y,
                "button": if buttons == 0 { "none" } else { "left" },
                "buttons": buttons,
            }),
        )
        .await?;
        sleep(step_duration).await;
    }
    Ok(())
}

fn cursor_motion_samples(
    start_x: f64,
    start_y: f64,
    end_x: f64,
    end_y: f64,
    steps: u32,
) -> Vec<(f64, f64)> {
    let steps = steps.max(1);
    (1..=steps)
        .map(|step| {
            let progress = f64::from(step) / f64::from(steps);
            let eased = 1.0 - (1.0 - progress).powi(3);
            (
                start_x + (end_x - start_x) * eased,
                start_y + (end_y - start_y) * eased,
            )
        })
        .collect()
}

async fn dispatch_mouse(webview: &Webview, parameters: Value) -> Result<(), AppError> {
    call_cdp(webview, "Input.dispatchMouseEvent", parameters)
        .await
        .map(|_| ())
}

async fn capture_screenshot(webview: &Webview) -> Result<String, AppError> {
    let mut last_size = 0usize;
    for quality in SCREENSHOT_QUALITIES {
        let response = call_cdp(
            webview,
            "Page.captureScreenshot",
            json!({
                "format": "jpeg",
                "quality": quality,
                "fromSurface": true,
                "captureBeyondViewport": false,
                "optimizeForSpeed": true,
            }),
        )
        .await?;
        let data = response
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::Tool("browser screenshot response omitted image data".into())
            })?;
        last_size = data.len();
        if !data.is_empty() && data.len() <= MAX_SCREENSHOT_BASE64_BYTES {
            return Ok(format!("data:image/jpeg;base64,{data}"));
        }
    }
    Err(AppError::Tool(format!(
        "browser screenshot remained too large after bounded compression ({last_size} base64 bytes)"
    )))
}

async fn evaluate_json<T>(webview: &Webview, script: &str) -> Result<T, AppError>
where
    T: for<'de> Deserialize<'de>,
{
    let raw = execute_script(webview, script).await?;
    let value: Value = serde_json::from_str(&raw).map_err(|error| {
        AppError::Tool(format!("browser script returned invalid JSON: {error}"))
    })?;
    if let Some(error) = value
        .as_object()
        .and_then(|object| object.get("__codexError"))
        .and_then(Value::as_str)
    {
        return Err(AppError::Tool(error.to_string()));
    }
    serde_json::from_value(value)
        .map_err(|error| AppError::Tool(format!("browser script result is invalid: {error}")))
}

#[cfg(windows)]
async fn execute_script(webview: &Webview, script: &str) -> Result<String, AppError> {
    use std::sync::Arc;

    use parking_lot::Mutex;
    use tokio::sync::oneshot;
    use webview2_com::ExecuteScriptCompletedHandler;
    use windows::core::HSTRING;

    type Completion = Arc<Mutex<Option<oneshot::Sender<Result<String, String>>>>>;

    fn complete(completion: &Completion, result: Result<String, String>) {
        if let Some(sender) = completion.lock().take() {
            let _result_was_unobserved = sender.send(result);
        }
    }

    let script = HSTRING::from(script);
    let (sender, receiver) = oneshot::channel();
    let completion: Completion = Arc::new(Mutex::new(Some(sender)));
    let dispatched_completion = Arc::clone(&completion);
    webview
        .with_webview(move |platform| {
            let callback_completion = Arc::clone(&dispatched_completion);
            let dispatch = (|| {
                let controller = platform.controller();
                // SAFETY: Tauri supplies a live WebView2 controller on its owning UI thread;
                // the returned COM interface is used only inside this callback and HRESULTs
                // are converted into explicit errors before the interface can escape.
                let core = unsafe { controller.CoreWebView2() }
                    .map_err(|error| format!("could not access CoreWebView2: {error}"))?;
                let handler =
                    ExecuteScriptCompletedHandler::create(Box::new(move |error_code, result| {
                        let result = if error_code.is_err() {
                            Err(format!(
                                "WebView2 script execution failed with {error_code:?}"
                            ))
                        } else {
                            Ok(result)
                        };
                        complete(&callback_completion, result);
                        Ok(())
                    }));
                // SAFETY: `core`, the immutable script HSTRING, and the COM completion handler
                // are valid for dispatch. WebView2 retains the handler for the asynchronous
                // callback, whose sender is guarded so it can be completed at most once.
                unsafe { core.ExecuteScript(&script, &handler) }
                    .map_err(|error| format!("could not dispatch WebView2 script: {error}"))
            })();
            if let Err(error) = dispatch {
                complete(&dispatched_completion, Err(error));
            }
        })
        .map_err(|error| AppError::State(format!("could not access browser WebView: {error}")))?;

    match timeout(WEBVIEW_OPERATION_TIMEOUT, receiver).await {
        Ok(Ok(Ok(result))) => Ok(result),
        Ok(Ok(Err(error))) => Err(AppError::Tool(error)),
        Ok(Err(_)) => Err(AppError::State(
            "browser script callback closed without a result".into(),
        )),
        Err(_) => Err(AppError::Timeout {
            operation: "browser script execution",
        }),
    }
}

#[cfg(not(windows))]
async fn execute_script(_webview: &Webview, _script: &str) -> Result<String, AppError> {
    Err(AppError::State(
        "browser automation currently requires the Windows WebView2 runtime".into(),
    ))
}

#[cfg(windows)]
async fn call_cdp(webview: &Webview, method: &str, parameters: Value) -> Result<Value, AppError> {
    use std::sync::Arc;

    use parking_lot::Mutex;
    use tokio::sync::oneshot;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;

    type Completion = Arc<Mutex<Option<oneshot::Sender<Result<String, String>>>>>;

    fn complete(completion: &Completion, result: Result<String, String>) {
        if let Some(sender) = completion.lock().take() {
            let _result_was_unobserved = sender.send(result);
        }
    }

    let method_name = HSTRING::from(method);
    let parameters = HSTRING::from(
        serde_json::to_string(&parameters)
            .map_err(|error| AppError::Tool(format!("CDP parameters are invalid: {error}")))?,
    );
    let (sender, receiver) = oneshot::channel();
    let completion: Completion = Arc::new(Mutex::new(Some(sender)));
    let dispatched_completion = Arc::clone(&completion);
    webview
        .with_webview(move |platform| {
            let callback_completion = Arc::clone(&dispatched_completion);
            let dispatch = (|| {
                let controller = platform.controller();
                // SAFETY: Tauri supplies a live WebView2 controller on its owning UI thread;
                // the returned COM interface remains local to this callback and every HRESULT
                // is checked before any result crosses into async Rust.
                let core = unsafe { controller.CoreWebView2() }
                    .map_err(|error| format!("could not access CoreWebView2: {error}"))?;
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |error_code, response| {
                        let result = if error_code.is_err() {
                            Err(format!("WebView2 CDP call failed with {error_code:?}"))
                        } else {
                            Ok(response)
                        };
                        complete(&callback_completion, result);
                        Ok(())
                    },
                ));
                // SAFETY: the COM interface, HSTRING arguments, and completion handler are all
                // valid at dispatch. WebView2 retains the handler until callback completion, and
                // the shared sender enforces a single observable completion.
                unsafe { core.CallDevToolsProtocolMethod(&method_name, &parameters, &handler) }
                    .map_err(|error| format!("could not dispatch WebView2 CDP call: {error}"))
            })();
            if let Err(error) = dispatch {
                complete(&dispatched_completion, Err(error));
            }
        })
        .map_err(|error| AppError::State(format!("could not access browser WebView: {error}")))?;

    let raw = match timeout(WEBVIEW_OPERATION_TIMEOUT, receiver).await {
        Ok(Ok(Ok(result))) => result,
        Ok(Ok(Err(error))) => return Err(AppError::Tool(error)),
        Ok(Err(_)) => {
            return Err(AppError::State(
                "browser CDP callback closed without a result".into(),
            ));
        }
        Err(_) => {
            return Err(AppError::Timeout {
                operation: "browser CDP operation",
            });
        }
    };
    let response: Value = serde_json::from_str(&raw)
        .map_err(|error| AppError::Tool(format!("browser CDP returned invalid JSON: {error}")))?;
    if let Some(error) = response.get("error") {
        return Err(AppError::Tool(format!(
            "browser CDP rejected the operation: {error}"
        )));
    }
    Ok(response)
}

#[cfg(not(windows))]
async fn call_cdp(
    _webview: &Webview,
    _method: &str,
    _parameters: Value,
) -> Result<Value, AppError> {
    Err(AppError::State(
        "browser automation currently requires the Windows WebView2 runtime".into(),
    ))
}

fn button_mask(button: BrowserMouseButton) -> u8 {
    match button {
        BrowserMouseButton::Left => 1,
        BrowserMouseButton::Right => 2,
        BrowserMouseButton::Middle => 4,
    }
}

fn modifier_mask(modifiers: &[String]) -> Result<u8, AppError> {
    let mut mask = 0u8;
    for modifier in modifiers {
        mask |= match modifier.as_str() {
            "alt" => 1,
            "control" => 2,
            "meta" => 4,
            "shift" => 8,
            _ => {
                return Err(AppError::Tool(format!(
                    "unsupported browser key modifier `{modifier}`"
                )));
            }
        };
    }
    Ok(mask)
}

struct KeyDescriptor {
    key: String,
    code: String,
    virtual_key: u32,
    text: Option<String>,
}

fn key_descriptor(input: &str) -> Result<KeyDescriptor, AppError> {
    let named = match input {
        "Enter" => Some(("Enter", "Enter", 13)),
        "Tab" => Some(("Tab", "Tab", 9)),
        "Escape" => Some(("Escape", "Escape", 27)),
        "Backspace" => Some(("Backspace", "Backspace", 8)),
        "Delete" => Some(("Delete", "Delete", 46)),
        "ArrowLeft" => Some(("ArrowLeft", "ArrowLeft", 37)),
        "ArrowUp" => Some(("ArrowUp", "ArrowUp", 38)),
        "ArrowRight" => Some(("ArrowRight", "ArrowRight", 39)),
        "ArrowDown" => Some(("ArrowDown", "ArrowDown", 40)),
        "Home" => Some(("Home", "Home", 36)),
        "End" => Some(("End", "End", 35)),
        "PageUp" => Some(("PageUp", "PageUp", 33)),
        "PageDown" => Some(("PageDown", "PageDown", 34)),
        " " | "Space" => Some((" ", "Space", 32)),
        _ => None,
    };
    if let Some((key, code, virtual_key)) = named {
        return Ok(KeyDescriptor {
            key: key.into(),
            code: code.into(),
            virtual_key,
            text: (key == " ").then(|| " ".into()),
        });
    }

    if let Some(number) = input.strip_prefix('F')
        && let Ok(number) = number.parse::<u32>()
        && (1..=12).contains(&number)
    {
        return Ok(KeyDescriptor {
            key: input.into(),
            code: input.into(),
            virtual_key: 111 + number,
            text: None,
        });
    }

    let mut characters = input.chars();
    let Some(character) = characters.next() else {
        return Err(AppError::Tool("browser key cannot be empty".into()));
    };
    if characters.next().is_some() || character.is_control() {
        return Err(AppError::Tool(format!(
            "unsupported browser key `{input}`; use a named key or one printable character"
        )));
    }
    let upper = character.to_ascii_uppercase();
    let code = if upper.is_ascii_alphabetic() {
        format!("Key{upper}")
    } else if upper.is_ascii_digit() {
        format!("Digit{upper}")
    } else {
        String::new()
    };
    Ok(KeyDescriptor {
        key: character.to_string(),
        code,
        virtual_key: upper as u32,
        text: Some(character.to_string()),
    })
}

fn elapsed_millis(started_at: Instant) -> Result<u64, AppError> {
    u64::try_from(started_at.elapsed().as_millis())
        .map_err(|_| AppError::State("browser action duration exceeded u64".into()))
}

#[cfg(test)]
mod tests {
    use super::{
        BROWSER_AGENT_INITIALIZATION_SCRIPT, BrowserMouseButton, button_mask,
        cursor_motion_samples, key_descriptor, modifier_mask,
    };

    #[test]
    fn browser_input_contract_maps_buttons_and_modifiers() {
        assert_eq!(button_mask(BrowserMouseButton::Left), 1);
        assert_eq!(button_mask(BrowserMouseButton::Right), 2);
        assert_eq!(
            modifier_mask(&["control".into(), "shift".into()]).expect("valid modifiers"),
            10
        );
        assert!(modifier_mask(&["hyper".into()]).is_err());
    }

    #[test]
    fn browser_key_contract_supports_named_and_printable_keys() {
        let enter = key_descriptor("Enter").expect("named key");
        assert_eq!(enter.virtual_key, 13);
        let letter = key_descriptor("a").expect("printable key");
        assert_eq!(letter.code, "KeyA");
        assert_eq!(letter.text.as_deref(), Some("a"));
        assert!(key_descriptor("unsupported key").is_err());
    }

    #[test]
    fn cursor_motion_is_smooth_monotonic_and_finishes_on_target() {
        let samples = cursor_motion_samples(10.0, 20.0, 110.0, 70.0, 10);

        assert_eq!(samples.len(), 10);
        assert!(
            samples
                .windows(2)
                .all(|pair| pair[0].0 < pair[1].0 && pair[0].1 < pair[1].1)
        );
        assert_eq!(samples.last().copied(), Some((110.0, 70.0)));
        assert!(samples[0].0 > 10.0);
    }

    #[test]
    fn cursor_visual_is_thick_neon_and_remains_visible_between_actions() {
        assert!(BROWSER_AGENT_INITIALIZATION_SCRIPT.contains("width=\"30\" height=\"38\""));
        assert!(BROWSER_AGENT_INITIALIZATION_SCRIPT.contains("stroke-width=\"5\""));
        assert!(BROWSER_AGENT_INITIALIZATION_SCRIPT.contains("#ff6800"));
        assert!(BROWSER_AGENT_INITIALIZATION_SCRIPT.contains("#fff0df"));
        assert!(!BROWSER_AGENT_INITIALIZATION_SCRIPT.contains("cursorIdleTimer"));
    }
}
