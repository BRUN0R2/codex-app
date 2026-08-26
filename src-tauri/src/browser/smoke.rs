use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Manager as _};
use tokio::fs;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};

use super::{
    BrowserManager, BrowserMouseButton, BrowserPendingTransition, BrowserSurfaceBounds,
    BrowserTargetSelector, browser_origin,
};
use crate::error::AppError;

const SMOKE_ARGUMENT: &str = "--browser-smoke";
const SMOKE_CONVERSATION_ID: &str = "browser-smoke-thread";

pub(crate) fn runtime_smoke_requested() -> bool {
    std::env::args().any(|argument| argument == SMOKE_ARGUMENT)
}

pub(crate) fn start_runtime_smoke_if_requested(app: &AppHandle) {
    if !runtime_smoke_requested() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_smoke(&app).await;
        match result {
            Ok(report) => match persist_report(&app, &report).await {
                Ok(path) => {
                    eprintln!("browser runtime smoke passed: {}", path.display());
                    finish_smoke(&app, 0).await;
                }
                Err(error) => {
                    eprintln!("browser runtime smoke report failed: {error}");
                    finish_smoke(&app, 1).await;
                }
            },
            Err(error) => {
                eprintln!("browser runtime smoke failed: {error}");
                finish_smoke(&app, 1).await;
            }
        }
    });
}

async fn finish_smoke(app: &AppHandle, exit_code: i32) {
    if let Some(window) = app.get_webview_window("main") {
        let _destroy_result = window.destroy();
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    app.exit(exit_code);
}

async fn persist_report(
    app: &AppHandle,
    report: &serde_json::Value,
) -> Result<std::path::PathBuf, AppError> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::FileSystem(error.to_string()))?
        .join("logs");
    fs::create_dir_all(&directory)
        .await
        .map_err(|error| AppError::FileSystem(format!("could not create smoke log: {error}")))?;
    let path = directory.join("browser-smoke.json");
    let encoded = serde_json::to_vec_pretty(report)
        .map_err(|error| AppError::State(format!("browser smoke report is invalid: {error}")))?;
    fs::write(&path, encoded)
        .await
        .map_err(|error| AppError::FileSystem(format!("could not write smoke report: {error}")))?;
    Ok(path)
}

async fn run_smoke(app: &AppHandle) -> Result<serde_json::Value, AppError> {
    let started_at = Instant::now();
    let external_listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| AppError::Transport(format!("external smoke server failed: {error}")))?;
    let external_address = external_listener
        .local_addr()
        .map_err(|error| AppError::Transport(format!("external smoke address failed: {error}")))?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| AppError::Transport(format!("browser smoke server failed: {error}")))?;
    let address = listener
        .local_addr()
        .map_err(|error| AppError::Transport(format!("browser smoke address failed: {error}")))?;
    let server = tokio::spawn(serve(
        listener,
        format!("http://{external_address}/external"),
    ));
    let external_server = tokio::spawn(serve_external(external_listener));
    let manager = app.state::<BrowserManager>();
    let url = manager.parse_agent_url_for_smoke(&format!("http://{address}/"))?;
    manager.approve_agent_origin(SMOKE_CONVERSATION_ID, &url);
    let (tab, transition) = manager
        .new_agent_tab(app, SMOKE_CONVERSATION_ID, url.clone())
        .await?;
    if transition.is_some() {
        return Err(AppError::State(
            "browser smoke initial navigation requested an unexpected transition".into(),
        ));
    }
    manager.synchronize_surface(
        Some(SMOKE_CONVERSATION_ID),
        Some(&tab.browser_tab_id),
        Some(BrowserSurfaceBounds {
            x: 360.0,
            y: 64.0,
            width: 760.0,
            height: 640.0,
        }),
        true,
    )?;

    let result = async {
        let initial = manager
            .screenshot_active(app, SMOKE_CONVERSATION_ID)
            .await?;
        ensure_capture(&initial, "Browser Smoke")?;
        let button = element_ref(&initial, "Incrementar")?;
        manager
            .click_active(
                app,
                SMOKE_CONVERSATION_ID,
                &BrowserTargetSelector::Reference(button),
                BrowserMouseButton::Left,
                1,
            )
            .await?;
        let clicked = manager
            .screenshot_active(app, SMOKE_CONVERSATION_ID)
            .await?;
        if !clicked.automation.snapshot.text.contains("Contagem: 1") {
            return Err(AppError::State(
                "browser smoke click did not update rendered page state".into(),
            ));
        }

        let input = element_ref(&clicked, "Nome")?;
        manager
            .type_active(
                app,
                SMOKE_CONVERSATION_ID,
                &BrowserTargetSelector::Reference(input),
                "Codex",
                true,
                false,
            )
            .await?;
        let typed = manager
            .screenshot_active(app, SMOKE_CONVERSATION_ID)
            .await?;
        if !typed
            .automation
            .snapshot
            .elements
            .iter()
            .any(|element| element.name == "Nome" && element.value.as_deref() == Some("Codex"))
        {
            return Err(AppError::State(
                "browser smoke typing did not reach the input element".into(),
            ));
        }

        let link = element_ref(&typed, "Próxima página")?;
        manager
            .click_active(
                app,
                SMOKE_CONVERSATION_ID,
                &BrowserTargetSelector::Reference(link),
                BrowserMouseButton::Left,
                1,
            )
            .await?;
        let navigated = manager
            .screenshot_active(app, SMOKE_CONVERSATION_ID)
            .await?;
        if navigated.automation.snapshot.title.as_deref() != Some("Browser Smoke Next") {
            return Err(AppError::State(
                "browser smoke navigation did not reach the next page".into(),
            ));
        }

        let redirect = element_ref(&navigated, "Redirecionar origem")?;
        let (_target, transition) = manager
            .click_active(
                app,
                SMOKE_CONVERSATION_ID,
                &BrowserTargetSelector::Reference(redirect),
                BrowserMouseButton::Left,
                1,
            )
            .await?;
        let Some(BrowserPendingTransition::Navigate(external_url)) = transition else {
            return Err(AppError::State(
                "browser smoke did not block the cross-origin redirect".into(),
            ));
        };
        if manager.origin_is_approved(SMOKE_CONVERSATION_ID, &external_url) {
            return Err(AppError::State(
                "browser smoke approved a redirect origin before consent".into(),
            ));
        }
        manager.approve_agent_origin(SMOKE_CONVERSATION_ID, &external_url);
        if manager
            .apply_agent_transition(
                app,
                SMOKE_CONVERSATION_ID,
                BrowserPendingTransition::Navigate(external_url),
            )
            .await?
            .is_some()
        {
            return Err(AppError::State(
                "browser smoke external page requested an unexpected transition".into(),
            ));
        }
        let external = manager
            .screenshot_active(app, SMOKE_CONVERSATION_ID)
            .await?;
        if external.automation.snapshot.title.as_deref() != Some("Browser Smoke External") {
            return Err(AppError::State(
                "browser smoke did not resume the approved redirect".into(),
            ));
        }
        Ok::<_, AppError>((initial, clicked, typed, navigated, external))
    }
    .await;

    let close_result = manager.close_agent_browser(SMOKE_CONVERSATION_ID, true);
    server.abort();
    external_server.abort();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (initial, clicked, typed, navigated, external) = result?;
    close_result?;
    Ok(json!({
        "status": "ok",
        "origin": browser_origin(&url),
        "totalMs": elapsed_millis(started_at)?,
        "initial": smoke_capture_metric(&initial),
        "clicked": smoke_capture_metric(&clicked),
        "typed": smoke_capture_metric(&typed),
        "navigated": smoke_capture_metric(&navigated),
        "external": smoke_capture_metric(&external),
    }))
}

impl BrowserManager {
    fn parse_agent_url_for_smoke(&self, value: &str) -> Result<url::Url, AppError> {
        super::parse_browser_url(value)
    }
}

async fn serve(listener: TcpListener, redirect_target: String) {
    loop {
        let Ok((stream, _address)) = listener.accept().await else {
            return;
        };
        let redirect_target = redirect_target.clone();
        tokio::spawn(async move {
            let _result_was_unobserved = serve_connection(stream, &redirect_target).await;
        });
    }
}

async fn serve_external(listener: TcpListener) {
    loop {
        let Ok((stream, _address)) = listener.accept().await else {
            return;
        };
        tokio::spawn(async move {
            let _result_was_unobserved = serve_external_connection(stream).await;
        });
    }
}

async fn serve_connection(
    mut stream: TcpStream,
    redirect_target: &str,
) -> Result<(), std::io::Error> {
    let mut request = [0_u8; 4_096];
    let bytes = stream.read(&mut request).await?;
    let request = String::from_utf8_lossy(&request[..bytes]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    if path.starts_with("/redirect") {
        let response = format!(
            "HTTP/1.1 302 Found\r\nLocation: {redirect_target}\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(response.as_bytes()).await?;
        return stream.shutdown().await;
    }
    let body = if path.starts_with("/next") {
        next_page()
    } else {
        initial_page()
    };
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

async fn serve_external_connection(mut stream: TcpStream) -> Result<(), std::io::Error> {
    let mut request = [0_u8; 4_096];
    let _bytes = stream.read(&mut request).await?;
    let body = external_page();
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

fn initial_page() -> &'static str {
    r#"<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Browser Smoke</title>
  <style>
    body { margin: 0; padding: 40px; font: 16px/1.5 system-ui; background: #f4f4f5; color: #18181b; }
    main { max-width: 620px; margin: auto; padding: 28px; border-radius: 16px; background: white; box-shadow: 0 12px 36px #0002; }
    button, input, a { display: block; margin-top: 18px; font: inherit; }
    button { padding: 10px 16px; }
    input { width: 280px; padding: 9px 12px; }
  </style>
</head>
<body>
  <main>
    <h1>Browser Smoke</h1>
    <p id="count">Contagem: 0</p>
    <button aria-label="Incrementar" onclick="window.countValue=(window.countValue||0)+1;document.querySelector('#count').textContent='Contagem: '+window.countValue">Incrementar</button>
    <input aria-label="Nome" placeholder="Nome">
    <a href="/next">Próxima página</a>
  </main>
</body>
</html>"#
}

fn next_page() -> &'static str {
    r#"<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser Smoke Next</title></head>
<body><main><h1>Browser Smoke Next</h1><p>Navegação concluída.</p><a href="/redirect">Redirecionar origem</a></main></body>
</html>"#
}

fn external_page() -> &'static str {
    r#"<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser Smoke External</title></head>
<body><main><h1>Browser Smoke External</h1><p>Origem aprovada e retomada.</p></main></body>
</html>"#
}

fn element_ref(capture: &super::BrowserAgentCapture, name: &str) -> Result<String, AppError> {
    capture
        .automation
        .snapshot
        .elements
        .iter()
        .find(|element| element.name == name)
        .map(|element| element.reference.clone())
        .ok_or_else(|| AppError::State(format!("browser smoke could not find element `{name}`")))
}

fn ensure_capture(
    capture: &super::BrowserAgentCapture,
    expected_title: &str,
) -> Result<(), AppError> {
    if capture.automation.snapshot.title.as_deref() != Some(expected_title)
        || capture
            .automation
            .screenshot
            .as_ref()
            .is_none_or(|screenshot| screenshot.bytes < 1_024)
        || capture.automation.snapshot.viewport.width < 700
        || capture.automation.snapshot.viewport.height < 500
    {
        return Err(AppError::State(
            "browser smoke initial capture is incomplete".into(),
        ));
    }
    Ok(())
}

fn smoke_capture_metric(capture: &super::BrowserAgentCapture) -> serde_json::Value {
    json!({
        "url": capture.automation.snapshot.url,
        "title": capture.automation.snapshot.title,
        "loadMs": capture.load_ms,
        "loadTimedOut": capture.load_timed_out,
        "snapshotMs": capture.automation.snapshot_ms,
        "screenshotMs": capture.automation.screenshot.as_ref().map(|capture| capture.duration_ms),
        "screenshotBytes": capture.automation.screenshot.as_ref().map(|capture| capture.bytes),
        "elements": capture.automation.snapshot.elements.len(),
        "viewport": {
            "width": capture.automation.snapshot.viewport.width,
            "height": capture.automation.snapshot.viewport.height,
        },
    })
}

fn elapsed_millis(started_at: Instant) -> Result<u64, AppError> {
    u64::try_from(started_at.elapsed().as_millis())
        .map_err(|_| AppError::State("browser smoke duration exceeded u64".into()))
}
