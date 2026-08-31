use std::collections::HashMap;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt as _;
use parking_lot::{Mutex, RwLock};
use reqwest::Method;
use reqwest::Response;
use reqwest::cookie::CookieStore;
use reqwest::cookie::Jar;
use reqwest::header::ACCEPT;
use reqwest::header::AUTHORIZATION;
use reqwest::header::CONTENT_TYPE;
use reqwest::header::ETAG;
use reqwest::header::HeaderValue;
use reqwest::header::USER_AGENT;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::sync::oneshot;
use tokio::sync::watch;
use uuid::Uuid;

use super::super::provider_error::decode_provider_response_failure;
use super::models::ModelCatalog;
use super::responses::CompletedWebSocketResponse;
use super::responses::ResponseEvent;
use super::responses::ResponseRequest;
use super::responses::ResponseRequestBaseline;
use super::responses::ResponseStream;
use super::websocket::{ResponsesWebSocketConnection, WebSocketConnectError};
use crate::engine::native::auth::AuthSession;
use crate::error::AppError;

const CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";
const MODEL_CATALOG_COMPATIBILITY_VERSION: &str = "0.151.0";
pub const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REQUEST_ATTEMPTS: usize = 8;
const MAX_RETRY_DELAY: Duration = Duration::from_secs(30);
const RETRY_BACKOFF_BASE_MILLIS: u64 = 500;
const MODEL_CATALOG_BODY_MAX_BYTES: usize = 4 * 1_048_576;
const MAX_ETAG_BYTES: usize = 1_024;
const ORIGINATOR: &str = "codex_desktop_next";
const RESPONSES_LITE_HEADER: &str = "x-openai-internal-codex-responses-lite";
const RESPONSES_WEBSOCKET_BETA_HEADER: &str = "responses_websockets=2026-02-06";
const MAX_CACHED_RESPONSE_SESSIONS: usize = 16;

#[derive(Default)]
pub struct ProviderClient {
    state: OnceLock<ProviderClientState>,
    response_sessions: Arc<Mutex<ResponseSessionCache>>,
    websocket_disabled: AtomicBool,
}

struct ProviderClientState {
    client: reqwest::Client,
    cookies: Arc<CloudflareCookieStore>,
}

pub struct ProviderResponseSession {
    thread_id: String,
    lease_id: Uuid,
    cache: Arc<Mutex<ResponseSessionCache>>,
    transport: ResponseTransport,
    websocket: Option<ResponsesWebSocketConnection>,
    websocket_uses_responses_lite: Option<bool>,
    last_request: Option<ResponseRequestBaseline>,
    last_response: Option<oneshot::Receiver<CompletedWebSocketResponse>>,
    has_requested: bool,
    pending_control_events: Vec<ResponseEvent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResponseTransport {
    WebSocket,
    Http,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ContinuationPolicy {
    Preserve,
    ResetAfterResponse,
}

enum WebSocketConnectionOutcome {
    Connected(ResponsesWebSocketConnection),
    HttpFallback(String),
}

struct ResponseSessionCache {
    sessions: HashMap<String, CachedResponseSession>,
    leases: HashMap<String, Uuid>,
    accepting: bool,
}

impl Default for ResponseSessionCache {
    fn default() -> Self {
        Self {
            sessions: HashMap::new(),
            leases: HashMap::new(),
            accepting: true,
        }
    }
}

struct CachedResponseSession {
    lease_id: Uuid,
    transport: ResponseTransport,
    websocket: Option<ResponsesWebSocketConnection>,
    websocket_uses_responses_lite: Option<bool>,
    last_request: Option<ResponseRequestBaseline>,
    last_response: Option<oneshot::Receiver<CompletedWebSocketResponse>>,
    has_requested: bool,
    pending_control_events: Vec<ResponseEvent>,
    cached_at: Instant,
}

impl ResponseSessionCache {
    fn take(&mut self, thread_id: &str) -> (Uuid, Option<CachedResponseSession>) {
        let cached = self.sessions.remove(thread_id);
        let lease_id = cached
            .as_ref()
            .map_or_else(Uuid::now_v7, |cached| cached.lease_id);
        self.leases.insert(thread_id.to_string(), lease_id);
        (lease_id, cached)
    }

    fn take_for_prewarm(
        &mut self,
        thread_id: &str,
    ) -> Option<(Uuid, Option<CachedResponseSession>)> {
        let has_active_lease =
            self.leases.contains_key(thread_id) && !self.sessions.contains_key(thread_id);
        (!has_active_lease).then(|| self.take(thread_id))
    }

    fn insert(&mut self, thread_id: String, session: CachedResponseSession) {
        if !self.accepting || self.leases.get(&thread_id).copied() != Some(session.lease_id) {
            return;
        }
        if !self.sessions.contains_key(&thread_id)
            && self.sessions.len() >= MAX_CACHED_RESPONSE_SESSIONS
        {
            self.evict_oldest_session();
        }
        self.sessions.insert(thread_id, session);
    }

    fn evict_oldest_session(&mut self) {
        let Some(oldest) = self
            .sessions
            .iter()
            .min_by_key(|(_, session)| session.cached_at)
            .map(|(thread_id, _)| thread_id.clone())
        else {
            return;
        };
        let Some(evicted) = self.sessions.remove(&oldest) else {
            return;
        };
        if self.leases.get(&oldest).copied() == Some(evicted.lease_id) {
            self.leases.remove(&oldest);
        }
    }

    fn invalidate(&mut self, thread_id: &str) {
        self.sessions.remove(thread_id);
        self.leases.remove(thread_id);
    }

    fn shutdown(&mut self) {
        self.accepting = false;
        self.clear();
    }

    fn clear(&mut self) {
        self.sessions.clear();
        self.leases.clear();
    }
}

impl ProviderResponseSession {
    fn new(
        thread_id: &str,
        cache: Arc<Mutex<ResponseSessionCache>>,
        lease: (Uuid, Option<CachedResponseSession>),
    ) -> Self {
        let (lease_id, cached) = lease;
        let (
            transport,
            websocket,
            websocket_uses_responses_lite,
            last_request,
            last_response,
            has_requested,
            pending_control_events,
        ) = cached.map_or(
            (
                ResponseTransport::WebSocket,
                None,
                None,
                None,
                None,
                false,
                Vec::new(),
            ),
            |cached| {
                (
                    cached.transport,
                    cached.websocket,
                    cached.websocket_uses_responses_lite,
                    cached.last_request,
                    cached.last_response,
                    cached.has_requested,
                    cached.pending_control_events,
                )
            },
        );
        Self {
            thread_id: thread_id.to_string(),
            lease_id,
            cache,
            transport,
            websocket,
            websocket_uses_responses_lite,
            last_request,
            last_response,
            has_requested,
            pending_control_events,
        }
    }

    async fn take_completed_response(&mut self) -> Option<CompletedWebSocketResponse> {
        let receiver = self.last_response.take()?;
        receiver.await.ok()
    }

    fn reset_websocket_state(&mut self) {
        self.websocket = None;
        self.websocket_uses_responses_lite = None;
        self.last_request = None;
        self.last_response = None;
        self.has_requested = false;
        self.pending_control_events.clear();
    }

    pub(in crate::engine::native) fn needs_prewarm(&self) -> bool {
        self.transport == ResponseTransport::WebSocket && !self.has_requested
    }

    pub(in crate::engine::native) fn owns_current_lease(&self) -> bool {
        self.cache.lock().leases.get(&self.thread_id).copied() == Some(self.lease_id)
    }

    pub(in crate::engine::native) fn retain_prewarm_control_events(
        &mut self,
        events: Vec<ResponseEvent>,
    ) {
        self.pending_control_events = events;
    }

    pub(in crate::engine::native) fn take_prewarm_control_events(&mut self) -> Vec<ResponseEvent> {
        std::mem::take(&mut self.pending_control_events)
    }

    pub(in crate::engine::native) fn abandon_pending_response(&mut self) {
        self.reset_websocket_state();
    }
}

impl Drop for ProviderResponseSession {
    fn drop(&mut self) {
        self.cache.lock().insert(
            self.thread_id.clone(),
            CachedResponseSession {
                lease_id: self.lease_id,
                transport: self.transport,
                websocket: self.websocket.take(),
                websocket_uses_responses_lite: self.websocket_uses_responses_lite,
                last_request: self.last_request.take(),
                last_response: self.last_response.take(),
                has_requested: self.has_requested,
                pending_control_events: std::mem::take(&mut self.pending_control_events),
                cached_at: Instant::now(),
            },
        );
    }
}

impl ProviderClient {
    pub fn initialize(&self) -> Result<(), AppError> {
        self.response_sessions.lock().accepting = true;
        if self.state.get().is_some() {
            return Ok(());
        }
        let state = build_client()?;
        if self.state.set(state).is_err() && self.state.get().is_none() {
            return Err(AppError::State(
                "provider client initialization raced without producing a client".into(),
            ));
        }
        Ok(())
    }

    pub async fn fetch_models(
        &self,
        session: &AuthSession,
        maximum_models: usize,
    ) -> Result<(ModelCatalog, Option<String>), AppError> {
        let url = model_catalog_url();
        let response = self
            .request_response_with_retries("model catalog", || {
                self.authorized(Method::GET, &url, session)
                    .map(|request| request.header(ACCEPT, "application/json"))
            })
            .await?;
        let etag = optional_response_header(&response, ETAG.as_str(), MAX_ETAG_BYTES)?;
        let value: super::models::ModelsWire =
            decode_json(response, "model catalog", MODEL_CATALOG_BODY_MAX_BYTES).await?;
        Ok((ModelCatalog::from_wire(value, maximum_models)?, etag))
    }

    pub fn response_session(&self, thread_id: &str) -> ProviderResponseSession {
        let cache = Arc::clone(&self.response_sessions);
        let lease = cache.lock().take(thread_id);
        let mut session = ProviderResponseSession::new(thread_id, cache, lease);
        self.apply_websocket_policy(&mut session);
        session
    }

    pub fn startup_response_session(&self, thread_id: &str) -> Option<ProviderResponseSession> {
        let cache = Arc::clone(&self.response_sessions);
        let lease = cache.lock().take_for_prewarm(thread_id)?;
        let mut session = ProviderResponseSession::new(thread_id, cache, lease);
        self.apply_websocket_policy(&mut session);
        Some(session)
    }

    fn apply_websocket_policy(&self, session: &mut ProviderResponseSession) {
        if self.websocket_disabled.load(Ordering::Acquire) {
            session.reset_websocket_state();
            session.transport = ResponseTransport::Http;
        }
    }

    pub fn close_response_session(&self, thread_id: &str) {
        self.response_sessions.lock().invalidate(thread_id);
    }

    pub fn shutdown_response_sessions(&self) {
        self.response_sessions.lock().shutdown();
    }

    pub fn clear_response_sessions(&self) {
        self.websocket_disabled.store(false, Ordering::Release);
        self.response_sessions.lock().clear();
    }

    pub async fn get_json<T: DeserializeOwned>(
        &self,
        session: &AuthSession,
        url: &str,
        operation: &'static str,
        maximum_bytes: usize,
    ) -> Result<T, AppError> {
        self.request_with_retries(operation, maximum_bytes, || {
            self.authorized(Method::GET, url, session)
                .map(|request| request.header(ACCEPT, "application/json"))
        })
        .await
    }

    pub async fn post_json<B, T>(
        &self,
        session: &AuthSession,
        url: &str,
        body: &B,
        operation: &'static str,
        maximum_bytes: usize,
    ) -> Result<T, AppError>
    where
        B: Serialize,
        T: DeserializeOwned,
    {
        self.request_with_retries(operation, maximum_bytes, || {
            self.authorized(Method::POST, url, session)
                .map(|request| request.header(CONTENT_TYPE, "application/json").json(body))
        })
        .await
    }

    async fn request_with_retries<T>(
        &self,
        operation: &'static str,
        maximum_bytes: usize,
        build_request: impl Fn() -> Result<reqwest::RequestBuilder, AppError>,
    ) -> Result<T, AppError>
    where
        T: DeserializeOwned,
    {
        let response = self
            .request_response_with_retries(operation, build_request)
            .await?;
        decode_json(response, operation, maximum_bytes).await
    }

    async fn request_response_with_retries(
        &self,
        operation: &'static str,
        build_request: impl Fn() -> Result<reqwest::RequestBuilder, AppError>,
    ) -> Result<Response, AppError> {
        let mut last_error = None;
        for attempt in 0..MAX_REQUEST_ATTEMPTS {
            let request = build_request()?;
            let response = match tokio::time::timeout(REQUEST_TIMEOUT, request.send()).await {
                Ok(Ok(response)) => response,
                Ok(Err(error)) if error.is_connect() || error.is_timeout() => {
                    last_error = Some(error.to_string());
                    if attempt + 1 < MAX_REQUEST_ATTEMPTS {
                        retry_delay(attempt).await;
                    }
                    continue;
                }
                Ok(Err(error)) => return Err(AppError::Transport(error.to_string())),
                Err(_) => {
                    last_error = Some(format!("{operation} timed out"));
                    if attempt + 1 < MAX_REQUEST_ATTEMPTS {
                        retry_delay(attempt).await;
                    }
                    continue;
                }
            };
            if response.status().is_server_error() && attempt + 1 < MAX_REQUEST_ATTEMPTS {
                last_error = Some(format!("HTTP {}", response.status().as_u16()));
                retry_delay(attempt).await;
                continue;
            }
            if !response.status().is_success() {
                let failure = decode_provider_response_failure(response).await;
                if failure.edge_blocked {
                    self.clear_cloudflare_cookies()?;
                    if attempt + 1 < MAX_REQUEST_ATTEMPTS {
                        retry_delay(attempt).await;
                        continue;
                    }
                }
                return Err(failure.error);
            }
            return Ok(response);
        }
        Err(AppError::Transport(last_error.unwrap_or_else(|| {
            format!("{operation} failed without a diagnostic")
        })))
    }

    pub async fn start_response(
        &self,
        auth: &AuthSession,
        session: &mut ProviderResponseSession,
        request: ResponseRequest<'_>,
        continuation: ContinuationPolicy,
        turn_state: Option<&str>,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<ResponseStream, AppError> {
        if session.transport == ResponseTransport::Http {
            session.has_requested = true;
            return self
                .start_http_response(auth, request, &session.thread_id, turn_state, cancellation)
                .await;
        }
        let uses_responses_lite = request.uses_responses_lite();
        if session.websocket.is_some()
            && session.websocket_uses_responses_lite != Some(uses_responses_lite)
        {
            session.reset_websocket_state();
        }
        let websocket_closed = match session.websocket.as_ref() {
            Some(websocket) => websocket.is_closed().await,
            None => true,
        };
        if websocket_closed {
            session.reset_websocket_state();
            match self
                .connect_websocket(
                    auth,
                    &session.thread_id,
                    turn_state,
                    request.uses_responses_lite(),
                    MAX_REQUEST_ATTEMPTS,
                    cancellation,
                )
                .await?
            {
                WebSocketConnectionOutcome::Connected(connection) => {
                    session.websocket = Some(connection);
                    session.websocket_uses_responses_lite = Some(uses_responses_lite);
                }
                WebSocketConnectionOutcome::HttpFallback(reason) => {
                    session.transport = ResponseTransport::Http;
                    let mut stream = self
                        .start_http_response(
                            auth,
                            request,
                            &session.thread_id,
                            turn_state,
                            cancellation,
                        )
                        .await?;
                    stream.push_pending(ResponseEvent::TransportFallback(reason));
                    return Ok(stream);
                }
            }
        }

        let previous_request = session.last_request.take();
        let previous_response = session.take_completed_response().await;
        let prepared = match continuation {
            ContinuationPolicy::Preserve => request.prepare_websocket_request(
                previous_request,
                previous_response,
                &session.thread_id,
                turn_state,
            )?,
            ContinuationPolicy::ResetAfterResponse => request
                .prepare_websocket_compaction_request(
                    previous_request,
                    previous_response,
                    &session.thread_id,
                    turn_state,
                )?,
        };
        let (completed_tx, completed_rx) = oneshot::channel();
        let websocket = session.websocket.as_mut().ok_or_else(|| {
            AppError::State("websocket connection disappeared before the request".into())
        })?;
        let stream = websocket.stream_request(prepared.payload, completed_tx);
        session.has_requested = true;
        session.last_request = prepared.baseline;
        session.last_response = session.last_request.as_ref().map(|_| completed_rx);
        Ok(stream)
    }

    pub async fn prewarm_response(
        &self,
        session: &mut ProviderResponseSession,
        request: ResponseRequest<'_>,
        turn_state: Option<&str>,
    ) -> Result<Option<ResponseStream>, AppError> {
        if session.transport == ResponseTransport::Http || session.has_requested {
            return Ok(None);
        }
        let Some(websocket) = session.websocket.as_ref() else {
            return Ok(None);
        };
        if websocket.is_closed().await {
            session.reset_websocket_state();
            return Ok(None);
        }

        let prepared = request.prepare_websocket_prewarm_request(&session.thread_id, turn_state)?;
        let (completed_tx, completed_rx) = oneshot::channel();
        let websocket = session.websocket.as_mut().ok_or_else(|| {
            AppError::State("websocket connection disappeared before prewarm".into())
        })?;
        let stream = websocket.stream_request(prepared.payload, completed_tx);
        session.has_requested = true;
        session.last_request = prepared.baseline;
        session.last_response = Some(completed_rx);
        Ok(Some(stream))
    }

    pub async fn preconnect_response(
        &self,
        auth: &AuthSession,
        session: &mut ProviderResponseSession,
        uses_responses_lite: bool,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<Option<String>, AppError> {
        if session.transport == ResponseTransport::Http {
            return Ok(None);
        }
        if let Some(websocket) = session.websocket.as_ref()
            && !websocket.is_closed().await
            && session.websocket_uses_responses_lite == Some(uses_responses_lite)
        {
            return Ok(None);
        }
        session.reset_websocket_state();
        match self
            .connect_websocket(
                auth,
                &session.thread_id,
                None,
                uses_responses_lite,
                1,
                cancellation,
            )
            .await?
        {
            WebSocketConnectionOutcome::Connected(connection) => {
                session.websocket = Some(connection);
                session.websocket_uses_responses_lite = Some(uses_responses_lite);
                Ok(None)
            }
            WebSocketConnectionOutcome::HttpFallback(reason) => {
                session.transport = ResponseTransport::Http;
                Ok(Some(reason))
            }
        }
    }

    async fn connect_websocket(
        &self,
        session: &AuthSession,
        thread_id: &str,
        turn_state: Option<&str>,
        uses_responses_lite: bool,
        maximum_attempts: usize,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<WebSocketConnectionOutcome, AppError> {
        let url = format!("{CODEX_BASE_URL}/responses");
        let request_id = Uuid::now_v7().to_string();
        for attempt in 0..maximum_attempts {
            if *cancellation.borrow() {
                return Err(AppError::Cancelled(
                    "websocket connection was cancelled".into(),
                ));
            }
            let mut request_builder = self
                .authorized(Method::GET, &url, session)?
                .header("OpenAI-Beta", RESPONSES_WEBSOCKET_BETA_HEADER)
                .header("session-id", thread_id)
                .header("thread-id", thread_id)
                .header("x-client-request-id", &request_id);
            if let Some(turn_state) = turn_state {
                request_builder = request_builder.header("x-codex-turn-state", turn_state);
            }
            if uses_responses_lite {
                request_builder = request_builder.header(RESPONSES_LITE_HEADER, "true");
            }
            match ResponsesWebSocketConnection::connect(request_builder, cancellation).await {
                Ok(connection) => {
                    return Ok(WebSocketConnectionOutcome::Connected(connection));
                }
                Err(WebSocketConnectError::Error(AppError::Cancelled(message))) => {
                    return Err(AppError::Cancelled(message));
                }
                Err(WebSocketConnectError::Error(error))
                    if error.is_transient() && attempt + 1 < maximum_attempts =>
                {
                    if retry_delay_or_cancel(attempt, cancellation).await {
                        return Err(AppError::Cancelled(
                            "websocket connection retry was cancelled".into(),
                        ));
                    }
                }
                Err(WebSocketConnectError::Error(error)) => return Err(error),
                Err(WebSocketConnectError::Http(response)) => {
                    let response = *response;
                    let status = response.status();
                    let failure = decode_provider_response_failure(response).await;
                    if status == reqwest::StatusCode::UPGRADE_REQUIRED {
                        self.websocket_disabled.store(true, Ordering::Release);
                        return Ok(WebSocketConnectionOutcome::HttpFallback(format!(
                            "Responses WebSocket is unavailable; using HTTP streaming for this provider session: {}",
                            failure.error
                        )));
                    }
                    if failure.edge_blocked {
                        self.clear_cloudflare_cookies()?;
                    }
                    if (failure.edge_blocked || status.is_server_error())
                        && attempt + 1 < maximum_attempts
                        && retry_delay_or_cancel(attempt, cancellation).await
                    {
                        return Err(AppError::Cancelled(
                            "websocket connection retry was cancelled".into(),
                        ));
                    }
                    if attempt + 1 == maximum_attempts
                        || (!failure.edge_blocked && !status.is_server_error())
                    {
                        return Err(failure.error);
                    }
                }
            }
        }
        Err(AppError::Transport(
            "websocket connection exhausted its retry budget".into(),
        ))
    }

    async fn start_http_response(
        &self,
        session: &AuthSession,
        request: ResponseRequest<'_>,
        thread_id: &str,
        turn_state: Option<&str>,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<ResponseStream, AppError> {
        let url = format!("{CODEX_BASE_URL}/responses");
        let request_id = Uuid::now_v7().to_string();
        let uses_responses_lite = request.uses_responses_lite();
        for attempt in 0..MAX_REQUEST_ATTEMPTS {
            if *cancellation.borrow() {
                return Err(AppError::Cancelled(
                    "response connection was cancelled".into(),
                ));
            }
            let mut request_builder = self
                .authorized(Method::POST, &url, session)?
                .header(ACCEPT, "text/event-stream")
                .header(CONTENT_TYPE, "application/json")
                .header("session-id", thread_id)
                .header("thread-id", thread_id)
                .header("x-client-request-id", &request_id);
            if let Some(turn_state) = turn_state {
                request_builder = request_builder.header("x-codex-turn-state", turn_state);
            }
            if uses_responses_lite {
                request_builder = request_builder.header(RESPONSES_LITE_HEADER, "true");
            }
            let send = tokio::time::timeout(REQUEST_TIMEOUT, request_builder.json(&request).send());
            let response = tokio::select! {
                changed = cancellation.changed() => {
                    if changed.is_err() || *cancellation.borrow() {
                        return Err(AppError::Cancelled("response connection was cancelled".into()));
                    }
                    continue;
                }
                result = send => match result {
                    Ok(Ok(response)) => response,
                    Ok(Err(error)) if (error.is_connect() || error.is_timeout())
                        && attempt + 1 < MAX_REQUEST_ATTEMPTS =>
                    {
                        if retry_delay_or_cancel(attempt, cancellation).await {
                            return Err(AppError::Cancelled("response retry was cancelled".into()));
                        }
                        continue;
                    }
                    Ok(Err(error)) => return Err(AppError::Transport(error.to_string())),
                    Err(_) if attempt + 1 < MAX_REQUEST_ATTEMPTS => {
                        if retry_delay_or_cancel(attempt, cancellation).await {
                            return Err(AppError::Cancelled("response retry was cancelled".into()));
                        }
                        continue;
                    }
                    Err(_) => return Err(AppError::Timeout {
                        operation: "response connection",
                    }),
                }
            };
            if response.status().is_server_error() && attempt + 1 < MAX_REQUEST_ATTEMPTS {
                if retry_delay_or_cancel(attempt, cancellation).await {
                    return Err(AppError::Cancelled("response retry was cancelled".into()));
                }
                continue;
            }
            if !response.status().is_success() {
                let failure = decode_provider_response_failure(response).await;
                if failure.edge_blocked {
                    self.clear_cloudflare_cookies()?;
                    if attempt + 1 < MAX_REQUEST_ATTEMPTS {
                        if retry_delay_or_cancel(attempt, cancellation).await {
                            return Err(AppError::Cancelled("response retry was cancelled".into()));
                        }
                        continue;
                    }
                }
                return Err(failure.error);
            }
            return open_response_stream(response);
        }
        Err(AppError::Transport(
            "response connection exhausted its retry budget".into(),
        ))
    }

    fn authorized(
        &self,
        method: Method,
        url: &str,
        session: &AuthSession,
    ) -> Result<reqwest::RequestBuilder, AppError> {
        let bearer = HeaderValue::from_str(&format!("Bearer {}", session.access_token()))
            .map_err(|_| AppError::Auth("the access token cannot be encoded as a header".into()))?;
        let account = HeaderValue::from_str(session.account_id())
            .map_err(|_| AppError::Auth("the account id cannot be encoded as a header".into()))?;
        let state = self
            .state
            .get()
            .ok_or_else(|| AppError::State("provider client is not initialized".into()))?;
        Ok(state
            .client
            .request(method, url)
            .header(AUTHORIZATION, bearer)
            .header("ChatGPT-Account-ID", account))
    }

    fn clear_cloudflare_cookies(&self) -> Result<(), AppError> {
        let state = self
            .state
            .get()
            .ok_or_else(|| AppError::State("provider client is not initialized".into()))?;
        state.cookies.clear();
        Ok(())
    }
}

fn optional_response_header(
    response: &Response,
    name: &str,
    maximum_bytes: usize,
) -> Result<Option<String>, AppError> {
    let Some(value) = response.headers().get(name) else {
        return Ok(None);
    };
    let value = value
        .to_str()
        .map_err(|_| AppError::Provider(format!("provider header `{name}` is not valid UTF-8")))?;
    let value = value.trim();
    if value.is_empty() || value.len() > maximum_bytes {
        return Err(AppError::Provider(format!(
            "provider header `{name}` must contain between 1 and {maximum_bytes} bytes"
        )));
    }
    Ok(Some(value.to_string()))
}

fn open_response_stream(response: Response) -> Result<ResponseStream, AppError> {
    if !response.status().is_success() {
        return Err(AppError::State(
            "provider stream was opened from an unsuccessful HTTP response".into(),
        ));
    }
    // Successful ChatGPT streams may omit Content-Type. The SSE parser is the
    // authoritative protocol boundary and rejects malformed or unbounded input.
    ResponseStream::new(response)
}

async fn retry_delay_or_cancel(attempt: usize, cancellation: &mut watch::Receiver<bool>) -> bool {
    tokio::select! {
        _ = retry_delay(attempt) => false,
        changed = cancellation.changed() => changed.is_err() || *cancellation.borrow(),
    }
}

fn model_catalog_url() -> String {
    format!("{CODEX_BASE_URL}/models?client_version={MODEL_CATALOG_COMPATIBILITY_VERSION}")
}

fn build_client() -> Result<ProviderClientState, AppError> {
    let user_agent = format!("codex-desktop-next/{}", env!("CARGO_PKG_VERSION"));
    let cookies = Arc::new(CloudflareCookieStore::default());
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("originator", HeaderValue::from_static(ORIGINATOR));
    headers.insert(
        USER_AGENT,
        HeaderValue::from_str(&user_agent)
            .map_err(|error| AppError::Provider(error.to_string()))?,
    );
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .cookie_provider(Arc::clone(&cookies))
        .default_headers(headers)
        .build()
        .map_err(|error| AppError::Provider(format!("could not build HTTP client: {error}")))?;
    Ok(ProviderClientState { client, cookies })
}

async fn decode_json<T: DeserializeOwned>(
    response: Response,
    operation: &'static str,
    maximum_bytes: usize,
) -> Result<T, AppError> {
    if !response.status().is_success() {
        return Err(decode_provider_response_failure(response).await.error);
    }
    let bytes = read_limited(response, maximum_bytes).await?;
    serde_json::from_slice(&bytes)
        .map_err(|error| AppError::Provider(format!("invalid {operation} response: {error}")))
}

async fn read_limited(response: Response, maximum_bytes: usize) -> Result<Vec<u8>, AppError> {
    let mut output = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| AppError::Transport(error.to_string()))?;
        if output.len().saturating_add(chunk.len()) > maximum_bytes {
            return Err(AppError::Provider(format!(
                "provider response exceeds {maximum_bytes} bytes"
            )));
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

async fn retry_delay(attempt: usize) {
    let exponent = u32::try_from(attempt).unwrap_or(u32::MAX).min(16);
    let multiplier = 1u64.checked_shl(exponent).unwrap_or(u64::MAX);
    let delay = Duration::from_millis(RETRY_BACKOFF_BASE_MILLIS.saturating_mul(multiplier))
        .min(MAX_RETRY_DELAY);
    tokio::time::sleep(delay).await;
}

#[derive(Debug, Default)]
struct CloudflareCookieStore {
    jar: RwLock<Jar>,
}

impl CloudflareCookieStore {
    fn clear(&self) {
        *self.jar.write() = Jar::default();
    }
}

impl CookieStore for CloudflareCookieStore {
    fn set_cookies(&self, headers: &mut dyn Iterator<Item = &HeaderValue>, url: &reqwest::Url) {
        if !is_chatgpt_url(url) {
            return;
        }
        let mut allowed_headers =
            headers.filter(|header| allowed_cloudflare_set_cookie_header(header));
        self.jar.read().set_cookies(&mut allowed_headers, url);
    }

    fn cookies(&self, url: &reqwest::Url) -> Option<HeaderValue> {
        if !is_chatgpt_url(url) {
            return None;
        }
        self.jar
            .read()
            .cookies(url)
            .and_then(only_cloudflare_cookies)
    }
}

fn is_chatgpt_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("chatgpt.com")
}

fn allowed_cloudflare_set_cookie_header(header: &HeaderValue) -> bool {
    header
        .to_str()
        .ok()
        .and_then(|header| header.split_once('=').map(|(name, _)| name.trim()))
        .is_some_and(allowed_cloudflare_cookie)
}

fn only_cloudflare_cookies(header: HeaderValue) -> Option<HeaderValue> {
    let cookies = header
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|cookie| {
            let cookie = cookie.trim();
            let name = cookie.split_once('=')?.0.trim();
            allowed_cloudflare_cookie(name).then_some(cookie)
        })
        .collect::<Vec<_>>()
        .join("; ");
    (!cookies.is_empty())
        .then(|| HeaderValue::from_str(&cookies).ok())
        .flatten()
}

fn allowed_cloudflare_cookie(name: &str) -> bool {
    matches!(
        name,
        "__cf_bm"
            | "__cflb"
            | "__cfruid"
            | "__cfseq"
            | "__cfwaitingroom"
            | "_cfuvid"
            | "cf_clearance"
            | "cf_ob_info"
            | "cf_use_ob"
    ) || name.starts_with("cf_chl_")
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use reqwest::cookie::CookieStore as _;
    use reqwest::header::HeaderValue;
    use tokio::io::AsyncReadExt as _;
    use tokio::io::AsyncWriteExt as _;
    use tokio::net::TcpListener;
    use tokio::sync::watch;

    use super::CloudflareCookieStore;
    use super::MAX_CACHED_RESPONSE_SESSIONS;
    use super::MODEL_CATALOG_COMPATIBILITY_VERSION;
    use super::ProviderClient;
    use super::ResponseTransport;
    use super::model_catalog_url;
    use super::open_response_stream;
    use crate::engine::native::provider::responses::ResponseEvent;

    #[tokio::test]
    async fn accepts_a_headerless_successful_sse_stream() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("loopback listener should bind");
        let address = listener
            .local_addr()
            .expect("loopback listener should expose its address");
        let server = tokio::spawn(async move {
            let (mut connection, _) = listener.accept().await.expect("request should connect");
            let mut request = [0_u8; 2_048];
            let _ = connection
                .read(&mut request)
                .await
                .expect("request should be readable");
            let body = b"data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg-1\",\"delta\":\"OK.\"}\n\n";
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            connection
                .write_all(headers.as_bytes())
                .await
                .expect("response headers should be writable");
            connection
                .write_all(body)
                .await
                .expect("response body should be writable");
        });

        let response = reqwest::Client::new()
            .get(format!("http://{address}"))
            .send()
            .await
            .expect("loopback response should arrive");
        assert!(
            response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .is_none()
        );
        let mut stream = open_response_stream(response)
            .expect("a successful SSE body does not require Content-Type");
        let (_cancellation_sender, mut cancellation) = watch::channel(false);
        let event = stream
            .next_event(&mut cancellation)
            .await
            .expect("SSE event should parse");

        assert!(matches!(
            event,
            Some(ResponseEvent::OutputTextDelta { delta, .. }) if delta == "OK."
        ));
        server.await.expect("loopback server should finish");
    }

    #[test]
    fn model_catalog_url_uses_the_explicit_compatibility_version() {
        let url =
            reqwest::Url::parse(&model_catalog_url()).expect("model catalog URL should parse");
        let client_version = url
            .query_pairs()
            .find_map(|(name, value)| (name == "client_version").then(|| value.into_owned()));

        assert_eq!(
            client_version.as_deref(),
            Some(MODEL_CATALOG_COMPATIBILITY_VERSION)
        );
    }

    #[test]
    fn cookie_store_retains_only_cloudflare_infrastructure_cookies() {
        let store = CloudflareCookieStore::default();
        let url = reqwest::Url::parse("https://chatgpt.com/backend-api/codex/models")
            .expect("fixture URL should parse");
        let infrastructure = HeaderValue::from_static("__cf_bm=value; Path=/; Secure");
        let session = HeaderValue::from_static("chatgpt_session=secret; Path=/; Secure");
        store.set_cookies(&mut [&infrastructure, &session].into_iter(), &url);
        assert_eq!(
            store
                .cookies(&url)
                .and_then(|value| value.to_str().ok().map(str::to_string)),
            Some("__cf_bm=value".into())
        );
    }

    #[test]
    fn cookie_store_honors_path_expiry_and_explicit_reset() {
        let store = CloudflareCookieStore::default();
        let models = reqwest::Url::parse("https://chatgpt.com/backend-api/codex/models")
            .expect("models URL should parse");
        let responses = reqwest::Url::parse("https://chatgpt.com/backend-api/codex/responses")
            .expect("responses URL should parse");
        let scoped = HeaderValue::from_static(
            "__cflb=west; Path=/backend-api/codex/models; Max-Age=3600; Secure",
        );
        store.set_cookies(&mut std::iter::once(&scoped), &models);

        assert_eq!(
            store
                .cookies(&models)
                .and_then(|value| value.to_str().ok().map(str::to_string)),
            Some("__cflb=west".into())
        );
        assert!(store.cookies(&responses).is_none());

        let expired =
            HeaderValue::from_static("__cflb=; Path=/backend-api/codex/models; Max-Age=0; Secure");
        store.set_cookies(&mut std::iter::once(&expired), &models);
        assert!(store.cookies(&models).is_none());

        let shared = HeaderValue::from_static("__cf_bm=value; Path=/; Max-Age=3600; Secure");
        store.set_cookies(&mut std::iter::once(&shared), &models);
        assert!(store.cookies(&responses).is_some());
        store.clear();
        assert!(store.cookies(&models).is_none());
        assert!(store.cookies(&responses).is_none());
    }

    #[test]
    fn response_transport_state_survives_across_turn_scoped_leases() {
        let client = ProviderClient::default();
        {
            let mut first_turn = client.response_session("thread-1");
            first_turn.transport = ResponseTransport::Http;
            first_turn.has_requested = true;
            first_turn
                .retain_prewarm_control_events(vec![ResponseEvent::TurnState("route-1".into())]);
        }

        let mut second_turn = client.response_session("thread-1");

        assert_eq!(second_turn.transport, ResponseTransport::Http);
        assert!(second_turn.has_requested);
        assert!(matches!(
            second_turn.take_prewarm_control_events().as_slice(),
            [ResponseEvent::TurnState(turn_state)] if turn_state == "route-1"
        ));
    }

    #[test]
    fn startup_prewarm_never_supersedes_an_active_turn_lease() {
        let client = ProviderClient::default();
        let active_turn = client.response_session("thread-1");

        assert!(client.startup_response_session("thread-1").is_none());

        drop(active_turn);
        let startup_prewarm = client
            .startup_response_session("thread-1")
            .expect("cached session should be available to startup prewarm");
        assert!(startup_prewarm.owns_current_lease());

        let active_turn = client.response_session("thread-1");
        assert!(!startup_prewarm.owns_current_lease());
        assert!(active_turn.owns_current_lease());
    }

    #[test]
    fn response_session_cache_is_bounded_and_explicitly_releasable() {
        let client = ProviderClient::default();
        for index in 0..=MAX_CACHED_RESPONSE_SESSIONS {
            drop(client.response_session(&format!("thread-{index}")));
        }
        assert_eq!(
            client.response_sessions.lock().sessions.len(),
            MAX_CACHED_RESPONSE_SESSIONS
        );

        client.close_response_session("thread-16");
        assert!(
            !client
                .response_sessions
                .lock()
                .sessions
                .contains_key("thread-16")
        );
        let invalidated_while_active = client.response_session("active-thread");
        client.close_response_session("active-thread");
        drop(invalidated_while_active);
        assert!(
            !client
                .response_sessions
                .lock()
                .sessions
                .contains_key("active-thread")
        );
        let late_session = client.response_session("late-thread");
        client.shutdown_response_sessions();
        drop(late_session);
        assert!(client.response_sessions.lock().sessions.is_empty());
    }

    #[test]
    fn clearing_account_state_invalidates_sessions_without_disabling_future_leases() {
        let client = ProviderClient::default();
        client.websocket_disabled.store(true, Ordering::Release);
        let session_from_previous_account = client.response_session("thread-1");
        assert_eq!(
            session_from_previous_account.transport,
            ResponseTransport::Http
        );
        client.clear_response_sessions();
        drop(session_from_previous_account);
        assert!(client.response_sessions.lock().sessions.is_empty());

        let session_for_new_account = client.response_session("thread-1");
        assert_eq!(
            session_for_new_account.transport,
            ResponseTransport::WebSocket
        );
        drop(session_for_new_account);
        assert!(
            client
                .response_sessions
                .lock()
                .sessions
                .contains_key("thread-1")
        );
    }
}
