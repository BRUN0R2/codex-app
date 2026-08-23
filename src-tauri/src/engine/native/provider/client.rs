use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

use futures_util::StreamExt as _;
use parking_lot::RwLock;
use reqwest::Method;
use reqwest::Response;
use reqwest::cookie::CookieStore;
use reqwest::cookie::Jar;
use reqwest::header::ACCEPT;
use reqwest::header::AUTHORIZATION;
use reqwest::header::CONTENT_TYPE;
use reqwest::header::HeaderValue;
use reqwest::header::USER_AGENT;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::sync::watch;
use uuid::Uuid;

use super::super::provider_error::decode_provider_response_failure;
use super::models::ModelCatalog;
use super::responses::ResponseRequest;
use super::responses::ResponseStream;
use crate::engine::native::auth::AuthSession;
use crate::error::AppError;

const CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";
const MODEL_CATALOG_COMPATIBILITY_VERSION: &str = "0.146.0";
pub const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REQUEST_ATTEMPTS: usize = 8;
const MAX_RETRY_DELAY: Duration = Duration::from_secs(30);
const ORIGINATOR: &str = "codex_desktop_next";

#[derive(Default)]
pub struct ProviderClient {
    state: OnceLock<ProviderClientState>,
}

struct ProviderClientState {
    client: reqwest::Client,
    cookies: Arc<CloudflareCookieStore>,
}

impl ProviderClient {
    pub fn initialize(&self) -> Result<(), AppError> {
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
    ) -> Result<ModelCatalog, AppError> {
        let url = model_catalog_url();
        let value: super::models::ModelsWire = self
            .get_json(session, &url, "model catalog", 4 * 1_048_576)
            .await?;
        ModelCatalog::from_wire(value, maximum_models)
    }

    pub async fn get_json<T: DeserializeOwned>(
        &self,
        session: &AuthSession,
        url: &str,
        operation: &'static str,
        maximum_bytes: usize,
    ) -> Result<T, AppError> {
        let mut last_error = None;
        for attempt in 0..MAX_REQUEST_ATTEMPTS {
            let request = self
                .authorized(Method::GET, url, session)?
                .header(ACCEPT, "application/json");
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
            return decode_json(response, operation, maximum_bytes).await;
        }
        Err(AppError::Transport(last_error.unwrap_or_else(|| {
            format!("{operation} failed without a diagnostic")
        })))
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
        B: Serialize + ?Sized,
        T: DeserializeOwned,
    {
        let mut last_error = None;
        for attempt in 0..MAX_REQUEST_ATTEMPTS {
            let request = self
                .authorized(Method::POST, url, session)?
                .header(ACCEPT, "application/json")
                .header(CONTENT_TYPE, "application/json")
                .json(body);
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
            return decode_json(response, operation, maximum_bytes).await;
        }
        Err(AppError::Transport(last_error.unwrap_or_else(|| {
            format!("{operation} failed without a diagnostic")
        })))
    }

    pub async fn start_response(
        &self,
        session: &AuthSession,
        request: ResponseRequest<'_>,
        thread_id: &str,
        turn_state: Option<&str>,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<ResponseStream, AppError> {
        let url = format!("{CODEX_BASE_URL}/responses");
        let request_id = Uuid::now_v7().to_string();
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
    let delay = Duration::from_millis(500u64.saturating_mul(multiplier)).min(MAX_RETRY_DELAY);
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
    use reqwest::cookie::CookieStore as _;
    use reqwest::header::HeaderValue;
    use tokio::io::AsyncReadExt as _;
    use tokio::io::AsyncWriteExt as _;
    use tokio::net::TcpListener;
    use tokio::sync::watch;

    use super::CloudflareCookieStore;
    use super::MODEL_CATALOG_COMPATIBILITY_VERSION;
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
}
