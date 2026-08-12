use std::io::ErrorKind;
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::Method;
use reqwest::Response;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue, USER_AGENT};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager as _};
use tokio::io::AsyncWriteExt as _;
use tokio::sync::watch;

use super::integrity::{IntegrityHeaders, IntegrityRequirements, requirements_key};
use super::models::ModelsWire;
use super::stream::ChatStream;
use crate::engine::ChatThinkingEffort;
use crate::engine::native::auth::AuthSession;
use crate::error::AppError;

const CHATGPT_BASE_URL: &str = "https://chatgpt.com/backend-api";
const MODELS_URL: &str = "https://chatgpt.com/backend-api/models?iim=false&include_icons=false";
const INTEGRITY_URL: &str = "https://chatgpt.com/backend-api/sentinel/chat-requirements/prepare";
const PREPARE_URL: &str = "https://chatgpt.com/backend-api/f/conversation/prepare";
const CONVERSATION_URL: &str = "https://chatgpt.com/backend-api/f/conversation";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ERROR_BYTES: usize = 65_536;
const MAX_PUBLIC_ERROR_CHARACTERS: usize = 2_000;
const DEVICE_ID_FILE_NAME: &str = "chatgpt-consumer-device-id";
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

pub(super) struct ChatClient {
    state: OnceLock<ClientState>,
}

struct ClientState {
    client: reqwest::Client,
    device_id: String,
}

impl Default for ChatClient {
    fn default() -> Self {
        Self {
            state: OnceLock::new(),
        }
    }
}

impl ChatClient {
    pub async fn initialize(&self, app: &AppHandle) -> Result<(), AppError> {
        if self.state.get().is_some() {
            return Ok(());
        }
        let device_id = load_or_create_device_id(app).await?;
        let state = build_client_state(device_id)?;
        if self.state.set(state).is_err() && self.state.get().is_none() {
            return Err(AppError::State(
                "ChatGPT consumer client initialization raced without producing a client".into(),
            ));
        }
        Ok(())
    }

    pub async fn fetch_models(&self, session: &AuthSession) -> Result<ModelsWire, AppError> {
        let response = tokio::time::timeout(
            REQUEST_TIMEOUT,
            self.authorized(Method::GET, MODELS_URL, session)?
                .header(ACCEPT, "application/json")
                .send(),
        )
        .await
        .map_err(|_| AppError::Timeout {
            operation: "ChatGPT model catalog",
        })?
        .map_err(|error| AppError::Provider(error.to_string()))?;
        decode_json(response, "ChatGPT model catalog", 4 * 1_048_576).await
    }

    pub async fn start_conversation(
        &self,
        session: &AuthSession,
        mut request: ChatConversationRequest,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<ChatStream, AppError> {
        if *cancellation.borrow() {
            return Err(AppError::Cancelled(
                "ChatGPT response connection was cancelled".into(),
            ));
        }
        let integrity = self.prepare_integrity(session).await?;
        let mut prepare_request = request.clone();
        prepare_request.client_prepare_state = Some("sent");
        let prepare = self.prepare_conversation(session, &prepare_request).await;
        request.client_prepare_state = Some(if prepare.is_some() {
            "success"
        } else {
            "failure"
        });

        let mut builder = self
            .authorized(Method::POST, CONVERSATION_URL, session)?
            .header(ACCEPT, "text/event-stream")
            .header(CONTENT_TYPE, "application/json");
        builder = apply_integrity_headers(builder, &integrity)?;
        if let Some(conduit_token) = prepare
            .as_ref()
            .and_then(|prepare| prepare.conduit_token.as_deref())
        {
            builder = builder.header(
                "x-conduit-token",
                safe_header("ChatGPT conduit token", conduit_token)?,
            );
        }

        let send = tokio::time::timeout(REQUEST_TIMEOUT, builder.json(&request).send());
        let response = tokio::select! {
            changed = cancellation.changed() => {
                if changed.is_err() || *cancellation.borrow() {
                    return Err(AppError::Cancelled(
                        "ChatGPT response connection was cancelled".into(),
                    ));
                }
                return Err(AppError::State(
                    "ChatGPT cancellation channel changed without cancellation".into(),
                ));
            }
            result = send => result
                .map_err(|_| AppError::Timeout { operation: "ChatGPT response connection" })?
                .map_err(|error| AppError::Provider(error.to_string()))?,
        };
        if !response.status().is_success() {
            return Err(response_error(response).await);
        }
        Ok(ChatStream::new(response))
    }

    async fn prepare_integrity(&self, session: &AuthSession) -> Result<IntegrityHeaders, AppError> {
        let key = requirements_key()?;
        let response = tokio::time::timeout(
            REQUEST_TIMEOUT,
            self.authorized(Method::POST, INTEGRITY_URL, session)?
                .header(ACCEPT, "application/json")
                .header(CONTENT_TYPE, "application/json")
                .json(&json!({ "p": key }))
                .send(),
        )
        .await
        .map_err(|_| AppError::Timeout {
            operation: "ChatGPT integrity preparation",
        })?
        .map_err(|error| AppError::Provider(error.to_string()))?;
        let requirements: IntegrityRequirements =
            decode_json(response, "ChatGPT integrity preparation", 1_048_576).await?;
        tokio::task::spawn_blocking(move || requirements.solve())
            .await
            .map_err(|error| {
                AppError::Provider(format!("ChatGPT proof-of-work task failed: {error}"))
            })?
    }

    async fn prepare_conversation(
        &self,
        session: &AuthSession,
        request: &ChatConversationRequest,
    ) -> Option<PrepareResponse> {
        let builder = self
            .authorized(Method::POST, PREPARE_URL, session)
            .ok()?
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .header("x-conduit-token", "no-token")
            .json(request);
        let response = tokio::time::timeout(REQUEST_TIMEOUT, builder.send())
            .await
            .ok()?
            .ok()?;
        decode_json(response, "ChatGPT conversation preparation", 1_048_576)
            .await
            .ok()
    }

    fn authorized(
        &self,
        method: Method,
        url: &str,
        session: &AuthSession,
    ) -> Result<reqwest::RequestBuilder, AppError> {
        if !url.starts_with(CHATGPT_BASE_URL) {
            return Err(AppError::State(
                "ChatGPT consumer request attempted an unexpected origin".into(),
            ));
        }
        let bearer = safe_header(
            "ChatGPT access token",
            &format!("Bearer {}", session.access_token()),
        )?;
        let account = safe_header("ChatGPT account id", session.account_id())?;
        let state = self
            .state
            .get()
            .ok_or_else(|| AppError::State("ChatGPT consumer client is not initialized".into()))?;
        Ok(state
            .client
            .request(method, url)
            .header(AUTHORIZATION, bearer)
            .header("ChatGPT-Account-ID", account)
            .header(
                "oai-did",
                safe_header("ChatGPT device id", &state.device_id)?,
            ))
    }
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ChatConversationRequest {
    action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    conversation_id: Option<String>,
    messages: Vec<ChatMessage>,
    model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_message_id: Option<String>,
    supported_encodings: [&'static str; 1],
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking_effort: Option<ChatThinkingEffort>,
    timezone: String,
    timezone_offset_min: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_prepare_state: Option<&'static str>,
}

impl ChatConversationRequest {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        conversation_id: Option<String>,
        parent_message_id: Option<String>,
        message_id: String,
        prompt: String,
        model: String,
        thinking_effort: Option<ChatThinkingEffort>,
        timezone: String,
        timezone_offset_min: i32,
    ) -> Self {
        Self {
            action: "next",
            conversation_id,
            messages: vec![ChatMessage::user(message_id, prompt)],
            model,
            parent_message_id,
            supported_encodings: ["v1"],
            thinking_effort,
            timezone,
            timezone_offset_min,
            client_prepare_state: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct ChatMessage {
    author: ChatAuthor,
    channel: Option<String>,
    content: ChatContent,
    create_time: f64,
    end_turn: Option<bool>,
    id: String,
    metadata: Value,
    recipient: &'static str,
    status: &'static str,
    update_time: Option<f64>,
    weight: u8,
}

impl ChatMessage {
    fn user(id: String, prompt: String) -> Self {
        let create_time = chrono::Utc::now().timestamp_millis() as f64 / 1_000.0;
        Self {
            author: ChatAuthor {
                metadata: json!({}),
                name: None,
                role: "user",
            },
            channel: None,
            content: ChatContent {
                content_type: "text",
                parts: vec![prompt],
            },
            create_time,
            end_turn: None,
            id,
            metadata: json!({}),
            recipient: "all",
            status: "finished_successfully",
            update_time: None,
            weight: 1,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct ChatAuthor {
    metadata: Value,
    name: Option<String>,
    role: &'static str,
}

#[derive(Debug, Clone, Serialize)]
struct ChatContent {
    content_type: &'static str,
    parts: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
struct PrepareResponse {
    #[serde(default)]
    conduit_token: Option<String>,
}

fn build_client_state(device_id: String) -> Result<ClientState, AppError> {
    let mut headers = HeaderMap::new();
    headers.insert("OAI-Language", HeaderValue::from_static("pt-BR"));
    headers.insert("X-OpenAI-Attach-Auth", HeaderValue::from_static("1"));
    headers.insert(
        "X-OpenAI-Attach-Integrity-State",
        HeaderValue::from_static("1"),
    );
    headers.insert("originator", HeaderValue::from_static("Codex Browser"));
    headers.insert(USER_AGENT, HeaderValue::from_static(BROWSER_USER_AGENT));
    headers.insert(
        "sec-ch-ua",
        HeaderValue::from_static(
            "\"Chromium\";v=\"136\", \"Google Chrome\";v=\"136\", \"Not=A?Brand\";v=\"24\"",
        ),
    );
    headers.insert("sec-ch-ua-mobile", HeaderValue::from_static("?0"));
    headers.insert(
        "sec-ch-ua-platform",
        HeaderValue::from_static("\"Windows\""),
    );
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .cookie_store(true)
        .default_headers(headers)
        .build()
        .map_err(|error| {
            AppError::Provider(format!("could not build ChatGPT consumer client: {error}"))
        })?;
    Ok(ClientState { client, device_id })
}

async fn load_or_create_device_id(app: &AppHandle) -> Result<String, AppError> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Storage(error.to_string()))?;
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| AppError::Storage(error.to_string()))?;
    let path = directory.join(DEVICE_ID_FILE_NAME);
    match tokio::fs::read_to_string(&path).await {
        Ok(value) => return validate_device_id(&value),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(AppError::Storage(error.to_string())),
    }

    let generated = uuid::Uuid::now_v7().to_string();
    match tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .await
    {
        Ok(mut file) => {
            file.write_all(generated.as_bytes())
                .await
                .map_err(|error| AppError::Storage(error.to_string()))?;
            file.sync_data()
                .await
                .map_err(|error| AppError::Storage(error.to_string()))?;
            Ok(generated)
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            let value = tokio::fs::read_to_string(path)
                .await
                .map_err(|error| AppError::Storage(error.to_string()))?;
            validate_device_id(&value)
        }
        Err(error) => Err(AppError::Storage(error.to_string())),
    }
}

fn validate_device_id(value: &str) -> Result<String, AppError> {
    uuid::Uuid::parse_str(value.trim())
        .map(|value| value.to_string())
        .map_err(|_| AppError::Storage("stored ChatGPT device id is invalid".into()))
}

fn apply_integrity_headers(
    mut builder: reqwest::RequestBuilder,
    integrity: &IntegrityHeaders,
) -> Result<reqwest::RequestBuilder, AppError> {
    if let Some(token) = integrity.requirements_token.as_deref() {
        builder = builder.header(
            "OpenAI-Sentinel-Chat-Requirements-Token",
            safe_header("ChatGPT requirements token", token)?,
        );
    } else if let Some(token) = integrity.requirements_prepare_token.as_deref() {
        builder = builder.header(
            "OpenAI-Sentinel-Chat-Requirements-Prepare-Token",
            safe_header("ChatGPT requirements prepare token", token)?,
        );
    }
    if let Some(token) = integrity.proof_token.as_deref() {
        builder = builder.header(
            "OpenAI-Sentinel-Proof-Token",
            safe_header("ChatGPT proof token", token)?,
        );
    }
    Ok(builder)
}

fn safe_header(label: &str, value: &str) -> Result<HeaderValue, AppError> {
    HeaderValue::from_str(value)
        .map_err(|_| AppError::Provider(format!("{label} cannot be encoded as an HTTP header")))
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
        Ok(bytes) => decode_error_message(&bytes),
        Err(error) => format!("the provider error body could not be read: {error}"),
    };
    AppError::ProviderHttp { status, message }
}

fn decode_error_message(bytes: &[u8]) -> String {
    let body = String::from_utf8_lossy(bytes);
    let value = serde_json::from_slice::<Value>(bytes).ok();
    let error = value
        .as_ref()
        .and_then(|value| value.get("error").or(Some(value)));
    let message = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or(body.trim());
    bounded_error_text(message)
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
    if output.is_empty() {
        "the provider rejected the ChatGPT request".into()
    } else {
        output
    }
}

async fn read_limited(response: Response, maximum_bytes: usize) -> Result<Vec<u8>, AppError> {
    use futures_util::StreamExt as _;

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

#[cfg(test)]
mod tests {
    use super::{ChatConversationRequest, validate_device_id};
    use crate::engine::ChatThinkingEffort;

    #[test]
    fn consumer_request_uses_thinking_effort_and_never_reasoning_mode() {
        let request = ChatConversationRequest::new(
            Some("conv_1".into()),
            Some("msg_parent".into()),
            "msg_user".into(),
            "Olá".into(),
            "gpt-5.6-pro".into(),
            Some(ChatThinkingEffort::Max),
            "America/Fortaleza".into(),
            180,
        );
        let encoded = serde_json::to_value(request).expect("request should encode");

        assert_eq!(encoded["thinking_effort"], "max");
        assert!(encoded.get("reasoning").is_none());
        assert!(encoded.get("reasoning_mode").is_none());
        assert_eq!(encoded["supported_encodings"][0], "v1");
        assert_eq!(encoded["messages"][0]["author"]["role"], "user");
    }

    #[test]
    fn device_id_is_canonical_and_strictly_validated() {
        assert_eq!(
            validate_device_id(" 018f22ec-a65c-7b33-98b1-3f66dc79dfef \n")
                .expect("UUID should validate"),
            "018f22ec-a65c-7b33-98b1-3f66dc79dfef"
        );
        assert!(validate_device_id("not-a-device-id").is_err());
    }
}
