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

use super::models::ModelCatalog;
use super::responses::ResponseRequest;
use super::responses::ResponseStream;
use crate::engine::native::auth::AuthSession;
use crate::error::AppError;

const CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";
pub const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ERROR_BYTES: usize = 65_536;
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
        let version = env!("CARGO_PKG_VERSION");
        let url = format!("{CODEX_BASE_URL}/models?client_version={version}");
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
    ) -> Result<ResponseStream, AppError> {
        let url = format!("{CODEX_BASE_URL}/responses");
        let response = tokio::time::timeout(
            REQUEST_TIMEOUT,
            self.authorized(Method::POST, &url, session)?
                .header(ACCEPT, "text/event-stream")
                .header(CONTENT_TYPE, "application/json")
                .header("session-id", thread_id)
                .header("thread-id", thread_id)
                .header("x-client-request-id", thread_id)
                .json(&request)
                .send(),
        )
        .await
        .map_err(|_| AppError::Timeout {
            operation: "response connection",
        })?
        .map_err(|error| AppError::Provider(error.to_string()))?;
        if !response.status().is_success() {
            return Err(response_error(response).await);
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .ok_or_else(|| {
                AppError::Provider("responses endpoint omitted the content-type header".into())
            })?
            .to_str()
            .map_err(|error| {
                AppError::Provider(format!(
                    "responses endpoint returned an invalid content-type header: {error}"
                ))
            })?;
        if !content_type.starts_with("text/event-stream") {
            return Err(AppError::Provider(format!(
                "responses endpoint returned unexpected content type `{content_type}`"
            )));
        }
        Ok(ResponseStream::new(response))
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
        Ok(bytes) => String::from_utf8(bytes)
            .map(|message| {
                if message.trim().is_empty() {
                    "the provider returned a blank error body".into()
                } else {
                    message
                }
            })
            .unwrap_or_else(|error| {
                format!("the provider returned a non-UTF-8 error body: {error}")
            }),
        Err(error) => format!("the provider error body could not be read: {error}"),
    };
    AppError::ProviderHttp { status, message }
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

    use super::CloudflareCookieStore;

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
}
