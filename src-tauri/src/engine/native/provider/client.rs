use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

use futures_util::StreamExt as _;
use parking_lot::RwLock;
use reqwest::Method;
use reqwest::Response;
use reqwest::cookie::CookieStore;
use reqwest::header::ACCEPT;
use reqwest::header::AUTHORIZATION;
use reqwest::header::CONTENT_TYPE;
use reqwest::header::HeaderValue;
use reqwest::header::USER_AGENT;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::watch;
use uuid::Uuid;

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
const MAX_ERROR_BYTES: usize = 65_536;
const MAX_PUBLIC_ERROR_CHARACTERS: usize = 2_000;
const MAX_REQUEST_ATTEMPTS: usize = 3;
const ORIGINATOR: &str = "codex_desktop_next";

#[derive(Default)]
pub struct ProviderClient {
    client: OnceLock<reqwest::Client>,
}

impl ProviderClient {
    pub fn initialize(&self) -> Result<(), AppError> {
        if self.client.get().is_some() {
            return Ok(());
        }
        let client = build_client()?;
        if self.client.set(client).is_err() && self.client.get().is_none() {
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
                Ok(Err(error)) => return Err(AppError::Provider(error.to_string())),
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
            return decode_json(response, operation, maximum_bytes).await;
        }
        Err(AppError::Provider(last_error.unwrap_or_else(|| {
            format!("{operation} failed without a diagnostic")
        })))
    }

    pub async fn start_response(
        &self,
        session: &AuthSession,
        request: ResponseRequest,
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
                    Ok(Err(error)) => return Err(AppError::Provider(error.to_string())),
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
            return open_response_stream(response).await;
        }
        Err(AppError::Provider(
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
        let client = self
            .client
            .get()
            .ok_or_else(|| AppError::State("provider client is not initialized".into()))?;
        Ok(client
            .request(method, url)
            .header(AUTHORIZATION, bearer)
            .header("ChatGPT-Account-ID", account))
    }
}

async fn open_response_stream(response: Response) -> Result<ResponseStream, AppError> {
    if !response.status().is_success() {
        return Err(response_error(response).await);
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

fn build_client() -> Result<reqwest::Client, AppError> {
    let user_agent = format!("codex-desktop-next/{}", env!("CARGO_PKG_VERSION"));
    let cookies = Arc::new(CloudflareCookieStore::default());
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("originator", HeaderValue::from_static(ORIGINATOR));
    headers.insert(
        USER_AGENT,
        HeaderValue::from_str(&user_agent)
            .map_err(|error| AppError::Provider(error.to_string()))?,
    );
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .cookie_provider(cookies)
        .default_headers(headers)
        .build()
        .map_err(|error| AppError::Provider(format!("could not build HTTP client: {error}")))
}

async fn decode_json<T: DeserializeOwned>(
    response: Response,
    operation: &'static str,
    maximum_bytes: usize,
) -> Result<T, AppError> {
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let bytes = read_limited(response, maximum_bytes).await?;
    serde_json::from_slice(&bytes)
        .map_err(|error| AppError::Provider(format!("invalid {operation} response: {error}")))
}

async fn response_error(response: Response) -> AppError {
    let status = response.status().as_u16();
    let message = match read_limited(response, MAX_ERROR_BYTES).await {
        Ok(bytes) if bytes.is_empty() => "the provider returned an empty error body".into(),
        Ok(bytes) => format_provider_error_body(bytes),
        Err(error) => format!("the provider error body could not be read: {error}"),
    };
    AppError::ProviderHttp { status, message }
}

fn format_provider_error_body(bytes: Vec<u8>) -> String {
    let body = match String::from_utf8(bytes) {
        Ok(body) if !body.trim().is_empty() => body,
        Ok(_) => return "the provider returned a blank error body".into(),
        Err(error) => return format!("the provider returned a non-UTF-8 error body: {error}"),
    };
    let Ok(value) = serde_json::from_str::<Value>(&body) else {
        return bounded_error_text(&body);
    };
    let error = value.get("error").unwrap_or(&value);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .map(bounded_error_text)
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| "the provider rejected the request".into());
    let kind = error
        .get("type")
        .and_then(Value::as_str)
        .or_else(|| error.get("code").and_then(Value::as_str));
    let reset = error
        .get("resets_in_seconds")
        .and_then(Value::as_u64)
        .filter(|seconds| *seconds > 0)
        .map(format_reset_duration);

    let mut formatted = message;
    if let Some(reset) = reset {
        formatted.push_str("; reset in approximately ");
        formatted.push_str(&reset);
    }
    if let Some(kind) = kind {
        formatted.push_str(" (provider type: ");
        formatted.push_str(&bounded_error_text(kind));
        formatted.push(')');
    }
    bounded_error_text(&formatted)
}

fn bounded_error_text(value: &str) -> String {
    let mut output = String::new();
    let mut previous_was_space = false;
    for character in value.trim().chars().take(MAX_PUBLIC_ERROR_CHARACTERS) {
        let character = if character.is_control() {
            ' '
        } else {
            character
        };
        if character.is_whitespace() {
            if previous_was_space {
                continue;
            }
            output.push(' ');
            previous_was_space = true;
        } else {
            output.push(character);
            previous_was_space = false;
        }
    }
    output
}

fn format_reset_duration(seconds: u64) -> String {
    let days = seconds / 86_400;
    let hours = (seconds % 86_400) / 3_600;
    let minutes = (seconds % 3_600) / 60;
    if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        format!("{hours}h {minutes}m")
    } else {
        format!("{}m", minutes.max(1))
    }
}

async fn read_limited(response: Response, maximum_bytes: usize) -> Result<Vec<u8>, AppError> {
    let mut output = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| AppError::Provider(error.to_string()))?;
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
    let multiplier = (attempt + 1) as u64;
    tokio::time::sleep(Duration::from_millis(200 * multiplier)).await;
}

#[derive(Debug, Default)]
struct CloudflareCookieStore {
    cookies: RwLock<BTreeMap<String, String>>,
}

impl CookieStore for CloudflareCookieStore {
    fn set_cookies(&self, headers: &mut dyn Iterator<Item = &HeaderValue>, url: &reqwest::Url) {
        if !is_chatgpt_url(url) {
            return;
        }
        let mut cookies = self.cookies.write();
        for header in headers {
            let Some((name, value)) = header
                .to_str()
                .ok()
                .and_then(|header| header.split(';').next())
                .and_then(|pair| pair.split_once('='))
            else {
                continue;
            };
            let name = name.trim();
            if allowed_cloudflare_cookie(name) {
                cookies.insert(name.into(), value.trim().into());
            }
        }
    }

    fn cookies(&self, url: &reqwest::Url) -> Option<HeaderValue> {
        if !is_chatgpt_url(url) {
            return None;
        }
        let cookies = self.cookies.read();
        if cookies.is_empty() {
            return None;
        }
        HeaderValue::from_str(
            &cookies
                .iter()
                .map(|(name, value)| format!("{name}={value}"))
                .collect::<Vec<_>>()
                .join("; "),
        )
        .ok()
    }
}

fn is_chatgpt_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("chatgpt.com")
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
    use super::format_provider_error_body;
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
            .await
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
    fn provider_errors_are_bounded_and_human_readable() {
        let usage = format_provider_error_body(
            br#"{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":511936}}"#
                .to_vec(),
        );
        assert_eq!(
            usage,
            "The usage limit has been reached; reset in approximately 5d 22h (provider type: usage_limit_reached)"
        );

        let invalid = format_provider_error_body(
            br#"{"error":{"message":"No tool output found","type":"invalid_request_error"}}"#
                .to_vec(),
        );
        assert_eq!(
            invalid,
            "No tool output found (provider type: invalid_request_error)"
        );
    }
}
