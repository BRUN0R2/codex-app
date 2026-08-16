use std::collections::VecDeque;
use std::time::Duration;

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::watch;
use tokio::time::Instant;

use crate::engine::ImageDetail;
use crate::engine::ModelVerbosity;
use crate::engine::ModelVerification;
use crate::engine::ModerationMetadata;
use crate::engine::ReasoningEffort;
use crate::engine::TokenUsage;
use crate::error::AppError;

const MAX_SSE_LINE_BYTES: usize = 1_048_576;
const MAX_SSE_EVENT_BYTES: usize = 2_097_152;
const MAX_DELTA_BYTES: usize = 262_144;
const MAX_HEADER_VALUE_BYTES: usize = 4_096;
const MAX_METADATA_LIST_ITEMS: usize = 64;
const MAX_METADATA_STRING_BYTES: usize = 1_024;
const MAX_USAGE_TOKENS: u64 = 1_000_000_000;
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Serialize)]
pub struct ResponseRequest<'a> {
    pub model: &'a str,
    pub instructions: &'a str,
    pub input: &'a [ResponseItem],
    pub tools: &'a [Value],
    pub tool_choice: &'static str,
    pub parallel_tool_calls: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningOptions>,
    pub store: bool,
    pub stream: bool,
    pub include: [&'static str; 1],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_key: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<TextOptions>,
}

#[derive(Debug, Clone, Default)]
pub struct ResponseRequestSettings<'a> {
    pub parallel_tool_calls: bool,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub service_tier: Option<&'a str>,
    pub prompt_cache_key: Option<&'a str>,
    pub verbosity: Option<ModelVerbosity>,
}

impl<'a> ResponseRequest<'a> {
    pub fn new(
        model: &'a str,
        instructions: &'a str,
        input: &'a [ResponseItem],
        tools: &'a [Value],
        settings: ResponseRequestSettings<'a>,
    ) -> Self {
        Self {
            model,
            instructions,
            input,
            tools,
            tool_choice: "auto",
            parallel_tool_calls: settings.parallel_tool_calls,
            reasoning: settings.reasoning_effort.map(|effort| ReasoningOptions {
                effort,
                summary: "auto",
            }),
            store: false,
            stream: true,
            include: ["reasoning.encrypted_content"],
            service_tier: settings.service_tier,
            prompt_cache_key: settings.prompt_cache_key,
            text: settings
                .verbosity
                .map(|verbosity| TextOptions { verbosity }),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ReasoningOptions {
    effort: ReasoningEffort,
    summary: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct TextOptions {
    verbosity: ModelVerbosity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResponseItem {
    Message {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        role: String,
        content: Vec<ResponseContent>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<ResponseMessagePhase>,
    },
    Reasoning {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default)]
        summary: Vec<ReasoningSummary>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Vec<ReasoningContent>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        encrypted_content: Option<String>,
    },
    FunctionCall {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        name: String,
        arguments: String,
        call_id: String,
    },
    FunctionCallOutput {
        call_id: String,
        output: String,
    },
    CustomToolCall {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        call_id: String,
        name: String,
        input: String,
    },
    CustomToolCallOutput {
        call_id: String,
        output: String,
    },
    WebSearchCall {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<ResponseCallStatus>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        action: Option<WebSearchAction>,
    },
    Compaction {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        encrypted_content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        internal_chat_message_metadata_passthrough: Option<InternalChatMessageMetadataPassthrough>,
    },
    CompactionTrigger {},
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct InternalChatMessageMetadataPassthrough {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
}

impl ResponseItem {
    pub fn user_content(content: Vec<ResponseContent>) -> Self {
        Self::Message {
            id: None,
            role: "user".into(),
            content,
            phase: None,
        }
    }

    pub fn function_output(call_id: String, output: String) -> Self {
        Self::FunctionCallOutput { call_id, output }
    }

    pub fn custom_output(call_id: String, output: String) -> Self {
        Self::CustomToolCallOutput { call_id, output }
    }

    pub fn compaction_trigger() -> Self {
        Self::CompactionTrigger {}
    }

    pub fn id(&self) -> Option<&str> {
        match self {
            Self::Message { id, .. }
            | Self::Reasoning { id, .. }
            | Self::FunctionCall { id, .. }
            | Self::CustomToolCall { id, .. }
            | Self::WebSearchCall { id, .. }
            | Self::Compaction { id, .. } => id.as_deref(),
            Self::FunctionCallOutput { .. }
            | Self::CustomToolCallOutput { .. }
            | Self::CompactionTrigger { .. } => None,
        }
    }

    pub fn assistant_text(&self) -> Option<String> {
        let Self::Message { role, content, .. } = self else {
            return None;
        };
        if role != "assistant" {
            return None;
        }
        let text = content
            .iter()
            .filter_map(|content| match content {
                ResponseContent::OutputText { text } => Some(text.as_str()),
                ResponseContent::Refusal { refusal } => Some(refusal.as_str()),
                ResponseContent::InputText { .. } | ResponseContent::InputImage { .. } => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        Some(text)
    }

    pub fn reasoning_text(&self) -> Option<(Vec<String>, Vec<String>)> {
        let Self::Reasoning {
            summary, content, ..
        } = self
        else {
            return None;
        };
        Some((
            summary.iter().map(|part| part.text.clone()).collect(),
            content
                .as_ref()
                .into_iter()
                .flatten()
                .map(|part| part.text.clone())
                .collect(),
        ))
    }

    pub fn is_compaction_checkpoint(&self) -> bool {
        matches!(self, Self::Compaction { .. })
    }

    pub fn compaction_checkpoint(&self) -> Option<(&str, Option<&str>)> {
        let Self::Compaction {
            encrypted_content,
            internal_chat_message_metadata_passthrough,
            ..
        } = self
        else {
            return None;
        };
        Some((
            encrypted_content,
            internal_chat_message_metadata_passthrough
                .as_ref()
                .and_then(|metadata| metadata.turn_id.as_deref()),
        ))
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseCallStatus {
    InProgress,
    Searching,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WebSearchAction {
    Search {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        query: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queries: Option<Vec<String>>,
    },
    OpenPage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
    FindInPage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pattern: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResponseContent {
    InputText {
        text: String,
    },
    InputImage {
        image_url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<ImageDetail>,
    },
    OutputText {
        text: String,
    },
    Refusal {
        refusal: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseMessagePhase {
    Commentary,
    FinalAnswer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReasoningSummary {
    #[serde(rename = "type")]
    kind: ReasoningSummaryType,
    text: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ReasoningSummaryType {
    SummaryText,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReasoningContent {
    #[serde(rename = "type")]
    kind: ReasoningContentType,
    text: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ReasoningContentType {
    ReasoningText,
}

#[derive(Debug)]
pub enum ResponseEvent {
    OutputItemAdded(ResponseItem),
    OutputTextDelta {
        item_id: String,
        delta: String,
    },
    ReasoningSummaryDelta {
        item_id: String,
        summary_index: usize,
        delta: String,
    },
    ReasoningContentDelta {
        item_id: String,
        content_index: usize,
        delta: String,
    },
    ServerModel(String),
    TurnState(String),
    ModelVerifications(Vec<ModelVerification>),
    TurnModerationMetadata(ModerationMetadata),
    SafetyBuffering(SafetyBuffering),
    OutputItemDone(ResponseItem),
    Completed(Option<TokenUsage>),
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafetyBuffering {
    pub use_cases: Vec<String>,
    pub reasons: Vec<String>,
    pub faster_model: Option<String>,
}

pub struct ResponseStream {
    response: reqwest::Response,
    parser: SseParser,
    pending: VecDeque<ResponseEvent>,
    ended: bool,
}

impl ResponseStream {
    pub(super) fn new(response: reqwest::Response) -> Result<Self, AppError> {
        let mut pending = VecDeque::new();
        if let Some(model) = response_header(&response, "openai-model", 256)? {
            pending.push_back(ResponseEvent::ServerModel(model));
        }
        if let Some(turn_state) =
            response_header(&response, "x-codex-turn-state", MAX_HEADER_VALUE_BYTES)?
        {
            pending.push_back(ResponseEvent::TurnState(turn_state));
        }
        let safety_faster_model =
            response_header(&response, "x-codex-safety-buffering-faster-model", 256)?;
        Ok(Self {
            response,
            parser: SseParser::new(safety_faster_model),
            pending,
            ended: false,
        })
    }

    pub async fn next_event(
        &mut self,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<Option<ResponseEvent>, AppError> {
        // Heartbeat chunks are transport activity, not model progress. Keep one deadline for the
        // next decoded event so a heartbeat-only connection cannot remain in progress forever.
        let event_deadline = Instant::now() + STREAM_IDLE_TIMEOUT;
        loop {
            if let Some(event) = self.pending.pop_front() {
                return Ok(Some(event));
            }
            if self.ended {
                return Ok(None);
            }
            if *cancellation.borrow() {
                self.ended = true;
                return Ok(Some(ResponseEvent::Interrupted));
            }

            let next_chunk = tokio::time::timeout_at(event_deadline, self.response.chunk());
            let chunk = tokio::select! {
                changed = cancellation.changed() => {
                    if changed.is_err() || *cancellation.borrow() {
                        self.ended = true;
                        return Ok(Some(ResponseEvent::Interrupted));
                    }
                    continue;
                }
                result = next_chunk => {
                    result.map_err(|_| AppError::Timeout { operation: "response stream" })?
                        .map_err(|error| AppError::Transport(error.to_string()))?
                }
            };
            match chunk {
                Some(chunk) => self.parser.push(&chunk, &mut self.pending)?,
                None => {
                    self.parser.finish(&mut self.pending)?;
                    self.ended = true;
                }
            }
        }
    }
}

#[derive(Default)]
struct SseParser {
    line: Vec<u8>,
    data: Vec<String>,
    event_bytes: usize,
    safety_faster_model: Option<String>,
}

impl SseParser {
    fn new(safety_faster_model: Option<String>) -> Self {
        Self {
            safety_faster_model,
            ..Self::default()
        }
    }

    fn push(&mut self, chunk: &[u8], output: &mut VecDeque<ResponseEvent>) -> Result<(), AppError> {
        for byte in chunk {
            if *byte == b'\n' {
                let mut line = std::mem::take(&mut self.line);
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                self.process_line(&line, output)?;
            } else {
                if self.line.len() >= MAX_SSE_LINE_BYTES {
                    return Err(AppError::Provider(format!(
                        "SSE line exceeds {MAX_SSE_LINE_BYTES} bytes"
                    )));
                }
                self.line.push(*byte);
            }
        }
        Ok(())
    }

    fn finish(&mut self, output: &mut VecDeque<ResponseEvent>) -> Result<(), AppError> {
        if !self.line.is_empty() {
            let line = std::mem::take(&mut self.line);
            self.process_line(&line, output)?;
        }
        self.dispatch(output)
    }

    fn process_line(
        &mut self,
        line: &[u8],
        output: &mut VecDeque<ResponseEvent>,
    ) -> Result<(), AppError> {
        if line.is_empty() {
            return self.dispatch(output);
        }
        if line.first() == Some(&b':') {
            return Ok(());
        }
        let line = std::str::from_utf8(line)
            .map_err(|error| AppError::Provider(format!("SSE is not UTF-8: {error}")))?;
        if let Some(value) = line.strip_prefix("data:") {
            let value = value.strip_prefix(' ').unwrap_or(value);
            self.event_bytes = self.event_bytes.saturating_add(value.len());
            if self.event_bytes > MAX_SSE_EVENT_BYTES {
                return Err(AppError::Provider(format!(
                    "SSE event exceeds {MAX_SSE_EVENT_BYTES} bytes"
                )));
            }
            self.data.push(value.into());
        } else if !line.starts_with("event:") && !line.starts_with("id:") {
            return Err(AppError::Provider(format!(
                "SSE contains unsupported field `{line}`"
            )));
        }
        Ok(())
    }

    fn dispatch(&mut self, output: &mut VecDeque<ResponseEvent>) -> Result<(), AppError> {
        self.event_bytes = 0;
        if self.data.is_empty() {
            return Ok(());
        }
        let data = std::mem::take(&mut self.data).join("\n");
        if data == "[DONE]" {
            return Ok(());
        }
        decode_event(&data, self.safety_faster_model.as_deref(), output)
    }
}

#[derive(Debug, Deserialize)]
struct StreamEventWire {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    headers: Option<Value>,
    #[serde(default)]
    metadata: Option<Value>,
    #[serde(default)]
    safety_buffering: Option<Value>,
    #[serde(default)]
    item: Option<Value>,
    #[serde(default)]
    item_id: Option<String>,
    #[serde(default)]
    delta: Option<String>,
    #[serde(default)]
    summary_index: Option<usize>,
    #[serde(default)]
    content_index: Option<usize>,
    #[serde(default)]
    response: Option<ResponseStateWire>,
    #[serde(default)]
    error: Option<ResponseErrorWire>,
}

#[derive(Debug, Deserialize)]
struct ResponseStateWire {
    #[serde(default)]
    headers: Option<Value>,
    #[serde(default)]
    error: Option<ResponseErrorWire>,
    #[serde(default)]
    incomplete_details: Option<IncompleteDetailsWire>,
    #[serde(default)]
    usage: Option<ResponseUsageWire>,
}

#[derive(Debug, Deserialize)]
struct SafetyBufferingWire {
    use_cases: Vec<String>,
    reasons: Vec<String>,
    #[serde(default, rename = "retry_model")]
    faster_model: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ResponseUsageWire {
    input_tokens: u64,
    #[serde(default)]
    input_tokens_details: InputTokenDetailsWire,
    output_tokens: u64,
    #[serde(default)]
    output_tokens_details: OutputTokenDetailsWire,
    total_tokens: u64,
}

#[derive(Debug, Default, Deserialize)]
struct InputTokenDetailsWire {
    #[serde(default)]
    cached_tokens: u64,
}

#[derive(Debug, Default, Deserialize)]
struct OutputTokenDetailsWire {
    #[serde(default)]
    reasoning_tokens: u64,
}

#[derive(Debug, Deserialize)]
struct ResponseErrorWire {
    #[serde(default)]
    code: Option<String>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    resets_in_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct IncompleteDetailsWire {
    #[serde(default)]
    reason: Option<String>,
}

fn decode_event(
    data: &str,
    safety_faster_model: Option<&str>,
    output: &mut VecDeque<ResponseEvent>,
) -> Result<(), AppError> {
    let event: StreamEventWire = serde_json::from_str(data)
        .map_err(|error| AppError::Provider(format!("invalid SSE event: {error}")))?;
    emit_metadata_events(&event, safety_faster_model, output)?;
    let decoded = match event.kind.as_str() {
        "response.output_item.added" => {
            let item = event.item.ok_or_else(|| {
                AppError::Provider("response.output_item.added is missing item".into())
            })?;
            let item = serde_json::from_value(item).map_err(|error| {
                AppError::Provider(format!("unsupported response output item: {error}"))
            })?;
            Some(ResponseEvent::OutputItemAdded(item))
        }
        "response.output_text.delta" => Some(ResponseEvent::OutputTextDelta {
            item_id: required_id(event.item_id, &event.kind)?,
            delta: required_delta(event.delta, &event.kind)?,
        }),
        "response.reasoning_summary_text.delta" => Some(ResponseEvent::ReasoningSummaryDelta {
            item_id: required_id(event.item_id, &event.kind)?,
            summary_index: event.summary_index.ok_or_else(|| {
                AppError::Provider(format!("{} is missing summary_index", event.kind))
            })?,
            delta: required_delta(event.delta, &event.kind)?,
        }),
        "response.reasoning_text.delta" => Some(ResponseEvent::ReasoningContentDelta {
            item_id: required_id(event.item_id, &event.kind)?,
            content_index: event.content_index.ok_or_else(|| {
                AppError::Provider(format!("{} is missing content_index", event.kind))
            })?,
            delta: required_delta(event.delta, &event.kind)?,
        }),
        "response.output_item.done" => {
            let item = event.item.ok_or_else(|| {
                AppError::Provider("response.output_item.done is missing item".into())
            })?;
            let item = serde_json::from_value(item).map_err(|error| {
                AppError::Provider(format!("unsupported response output item: {error}"))
            })?;
            Some(ResponseEvent::OutputItemDone(item))
        }
        "response.completed" => Some(ResponseEvent::Completed(decode_completed_usage(
            event.response,
        )?)),
        "response.failed" | "error" => return Err(stream_failure(event)),
        "response.incomplete" => {
            let reason = event
                .response
                .and_then(|response| response.incomplete_details)
                .and_then(|details| details.reason)
                .unwrap_or_else(|| "unknown reason".into());
            return Err(AppError::Provider(format!(
                "provider returned an incomplete response: {reason}"
            )));
        }
        kind if is_non_output_event(kind) => None,
        kind => {
            return Err(AppError::Provider(format!(
                "unsupported response stream event `{kind}`"
            )));
        }
    };
    if let Some(event) = decoded {
        output.push_back(event);
    }
    Ok(())
}

fn is_non_output_event(kind: &str) -> bool {
    matches!(
        kind,
        "keepalive"
            | "response.content_part.added"
            | "response.content_part.done"
            | "response.created"
            | "response.custom_tool_call_input.delta"
            | "response.custom_tool_call_input.done"
            | "response.function_call_arguments.delta"
            | "response.function_call_arguments.done"
            | "response.in_progress"
            | "response.metadata"
            | "response.output_text.annotation.added"
            | "response.output_text.done"
            | "response.queued"
            | "response.reasoning_summary_part.added"
            | "response.reasoning_summary_part.done"
            | "response.reasoning_summary_text.done"
            | "response.reasoning_text.done"
            | "response.web_search_call.completed"
            | "response.web_search_call.in_progress"
            | "response.web_search_call.searching"
    )
}

fn emit_metadata_events(
    event: &StreamEventWire,
    safety_faster_model: Option<&str>,
    output: &mut VecDeque<ResponseEvent>,
) -> Result<(), AppError> {
    let response_model = event
        .response
        .as_ref()
        .and_then(|response| response.headers.as_ref())
        .and_then(|headers| json_header(headers, &["openai-model", "x-openai-model"]))
        .or_else(|| {
            event
                .headers
                .as_ref()
                .and_then(|headers| json_header(headers, &["openai-model", "x-openai-model"]))
        });
    if let Some(model) = response_model {
        output.push_back(ResponseEvent::ServerModel(validated_metadata_text(
            model,
            "server model",
            256,
        )?));
    }

    if event.kind == "response.metadata" {
        if let Some(turn_state) = event
            .headers
            .as_ref()
            .and_then(|headers| json_header(headers, &["x-codex-turn-state"]))
        {
            output.push_back(ResponseEvent::TurnState(validated_metadata_text(
                turn_state,
                "turn state",
                MAX_HEADER_VALUE_BYTES,
            )?));
        }
        if let Some(value) = event
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("openai_verification_recommendation"))
        {
            let verifications = decode_model_verifications(value)?;
            if !verifications.is_empty() {
                output.push_back(ResponseEvent::ModelVerifications(verifications));
            }
        }
        if let Some(metadata) = event
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("openai_chatgpt_moderation_metadata"))
        {
            output.push_back(ResponseEvent::TurnModerationMetadata(
                decode_moderation_metadata(metadata)?,
            ));
        }
    }

    if let Some(buffering) =
        decode_safety_buffering(event.safety_buffering.as_ref(), safety_faster_model)?
    {
        output.push_back(ResponseEvent::SafetyBuffering(buffering));
    }
    Ok(())
}

fn decode_moderation_metadata(value: &Value) -> Result<ModerationMetadata, AppError> {
    serde_json::from_value(value.clone()).map_err(|error| {
        AppError::Provider(format!("invalid ChatGPT moderation metadata: {error}"))
    })
}

fn decode_model_verifications(value: &Value) -> Result<Vec<ModelVerification>, AppError> {
    let values = value
        .as_array()
        .ok_or_else(|| AppError::Provider("model verification metadata is not an array".into()))?;
    if values.len() > MAX_METADATA_LIST_ITEMS {
        return Err(AppError::Provider(format!(
            "model verification list exceeds {MAX_METADATA_LIST_ITEMS} entries"
        )));
    }
    let mut decoded = Vec::new();
    for (index, value) in values.iter().enumerate() {
        let value = value.as_str().ok_or_else(|| {
            AppError::Provider(format!(
                "model verification metadata entry {} is not text",
                index + 1
            ))
        })?;
        match value {
            "trusted_access_for_cyber" => {
                if !decoded.contains(&ModelVerification::TrustedAccessForCyber) {
                    decoded.push(ModelVerification::TrustedAccessForCyber);
                }
            }
            value => {
                return Err(AppError::Provider(format!(
                    "unsupported model verification `{value}`"
                )));
            }
        }
    }
    Ok(decoded)
}

fn decode_safety_buffering(
    value: Option<&Value>,
    safety_faster_model: Option<&str>,
) -> Result<Option<SafetyBuffering>, AppError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() || value == &Value::Bool(false) {
        return Ok(None);
    }
    let retry_model_present = value
        .as_object()
        .is_some_and(|object| object.contains_key("retry_model"));
    let wire: SafetyBufferingWire = serde_json::from_value(value.clone()).map_err(|error| {
        AppError::Provider(format!("invalid safety buffering metadata: {error}"))
    })?;
    validate_metadata_list(&wire.use_cases, "safety buffering use cases")?;
    validate_metadata_list(&wire.reasons, "safety buffering reasons")?;
    let faster_model = if retry_model_present {
        wire.faster_model
    } else {
        safety_faster_model.map(str::to_owned)
    }
    .map(|model| validated_metadata_text(&model, "safety fallback model", 256))
    .transpose()?;
    Ok(Some(SafetyBuffering {
        use_cases: wire.use_cases,
        reasons: wire.reasons,
        faster_model,
    }))
}

fn validate_metadata_list(values: &[String], field: &str) -> Result<(), AppError> {
    if values.len() > MAX_METADATA_LIST_ITEMS {
        return Err(AppError::Provider(format!(
            "{field} exceed {MAX_METADATA_LIST_ITEMS} entries"
        )));
    }
    for value in values {
        validated_metadata_text(value, field, MAX_METADATA_STRING_BYTES)?;
    }
    Ok(())
}

fn validated_metadata_text(value: &str, field: &str, maximum: usize) -> Result<String, AppError> {
    let value = value.trim();
    if value.is_empty() || value.len() > maximum {
        return Err(AppError::Provider(format!("{field} is invalid")));
    }
    Ok(value.to_owned())
}

fn json_header<'a>(headers: &'a Value, names: &[&str]) -> Option<&'a str> {
    let headers = headers.as_object()?;
    headers.iter().find_map(|(name, value)| {
        names
            .iter()
            .any(|expected| name.eq_ignore_ascii_case(expected))
            .then(|| match value {
                Value::String(value) => Some(value.as_str()),
                Value::Array(values) => values.first().and_then(Value::as_str),
                _ => None,
            })
            .flatten()
    })
}

fn response_header(
    response: &reqwest::Response,
    name: &str,
    maximum: usize,
) -> Result<Option<String>, AppError> {
    response
        .headers()
        .get(name)
        .map(|value| {
            value
                .to_str()
                .map_err(|_| AppError::Provider(format!("response header `{name}` is not text")))
                .and_then(|value| validated_metadata_text(value, name, maximum))
        })
        .transpose()
}

fn decode_completed_usage(
    response: Option<ResponseStateWire>,
) -> Result<Option<TokenUsage>, AppError> {
    let Some(usage) = response.and_then(|response| response.usage) else {
        return Ok(None);
    };
    let values = [
        usage.input_tokens,
        usage.input_tokens_details.cached_tokens,
        usage.output_tokens,
        usage.output_tokens_details.reasoning_tokens,
        usage.total_tokens,
    ];
    if values.into_iter().any(|value| value > MAX_USAGE_TOKENS) {
        return Err(AppError::Provider(format!(
            "response usage exceeds {MAX_USAGE_TOKENS} tokens"
        )));
    }
    if usage.input_tokens_details.cached_tokens > usage.input_tokens {
        return Err(AppError::Provider(
            "response cached tokens exceed input tokens".into(),
        ));
    }
    if usage.output_tokens_details.reasoning_tokens > usage.output_tokens {
        return Err(AppError::Provider(
            "response reasoning tokens exceed output tokens".into(),
        ));
    }
    let expected_total = usage
        .input_tokens
        .checked_add(usage.output_tokens)
        .ok_or_else(|| AppError::Provider("response token total overflowed".into()))?;
    if usage.total_tokens != expected_total {
        return Err(AppError::Provider(
            "response total tokens do not equal input plus output tokens".into(),
        ));
    }
    Ok(Some(TokenUsage {
        input_tokens: usage.input_tokens,
        cached_input_tokens: usage.input_tokens_details.cached_tokens,
        output_tokens: usage.output_tokens,
        reasoning_output_tokens: usage.output_tokens_details.reasoning_tokens,
        total_tokens: usage.total_tokens,
    }))
}

fn required_id(value: Option<String>, event: &str) -> Result<String, AppError> {
    let value = value.ok_or_else(|| AppError::Provider(format!("{event} is missing item_id")))?;
    if value.is_empty() || value.len() > 256 {
        return Err(AppError::Provider(format!(
            "{event} contains an invalid item_id"
        )));
    }
    Ok(value)
}

fn required_delta(value: Option<String>, event: &str) -> Result<String, AppError> {
    let value = value.ok_or_else(|| AppError::Provider(format!("{event} is missing delta")))?;
    if value.len() > MAX_DELTA_BYTES {
        return Err(AppError::Provider(format!(
            "{event} delta exceeds {MAX_DELTA_BYTES} bytes"
        )));
    }
    Ok(value)
}

fn stream_failure(event: StreamEventWire) -> AppError {
    let error = event
        .error
        .or_else(|| event.response.and_then(|response| response.error));
    let (code, message, retry_after_seconds) = error.map_or_else(
        || {
            (
                None,
                "response stream failed without a message".into(),
                None,
            )
        },
        |error| {
            let code = error.code.or(error.kind);
            let message = error
                .message
                .filter(|message| !message.trim().is_empty())
                .unwrap_or_else(|| "response stream failed without a message".into());
            (
                code,
                message,
                error.resets_in_seconds.filter(|seconds| *seconds > 0),
            )
        },
    );
    let message = match code.as_deref() {
        Some(code) => format!("{code}: {message}"),
        None => message,
    };
    AppError::from_provider_rejection(None, code.as_deref(), message, retry_after_seconds)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use crate::engine::ModelVerbosity;
    use crate::engine::ModelVerification;
    use crate::engine::ReasoningEffort;

    use super::ResponseEvent;
    use super::ResponseItem;
    use super::ResponseMessagePhase;
    use super::ResponseRequest;
    use super::ResponseRequestSettings;
    use super::SseParser;

    #[test]
    fn custom_tool_output_uses_the_responses_api_shape() {
        let value = serde_json::to_value(ResponseItem::custom_output(
            "call-1".into(),
            "patch applied".into(),
        ))
        .expect("custom output should serialize");

        assert_eq!(value["type"], "custom_tool_call_output");
        assert_eq!(value["call_id"], "call-1");
        assert_eq!(value["output"], "patch applied");
    }

    #[test]
    fn parses_fragmented_sse_without_unbounded_lines() {
        let mut parser = SseParser::default();
        let mut events = VecDeque::new();
        parser
            .push(
                b"data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg-1\",",
                &mut events,
            )
            .expect("first fragment should buffer");
        parser
            .push(b"\"delta\":\"hello\"}\r\n\r\n", &mut events)
            .expect("second fragment should decode");
        assert!(matches!(
            events.pop_front(),
            Some(ResponseEvent::OutputTextDelta { delta, .. }) if delta == "hello"
        ));
    }

    #[test]
    fn preserves_context_window_exceeded_from_sse() {
        let mut parser = SseParser::default();
        let mut events = VecDeque::new();
        let error = parser
            .push(
                br#"data: {"type":"response.failed","response":{"error":{"code":"context_length_exceeded","message":"too large"}}}

"#,
                &mut events,
            )
            .expect_err("context overflow should fail the stream");

        assert!(matches!(
            error,
            crate::error::AppError::ContextWindowExceeded(_)
        ));
        assert!(events.is_empty());
    }

    #[test]
    fn preserves_usage_limit_reset_delay_from_sse() {
        let mut parser = SseParser::default();
        let mut events = VecDeque::new();
        let error = parser
            .push(
                br#"data: {"type":"response.failed","response":{"error":{"type":"usage_limit_reached","message":"limit reached","resets_in_seconds":3600}}}

"#,
                &mut events,
            )
            .expect_err("usage limit should pause the stream");

        assert!(matches!(
            error,
            crate::error::AppError::RateLimited {
                retry_after_seconds: Some(3_600),
                ..
            }
        ));
        assert!(events.is_empty());
    }

    #[test]
    fn parses_and_validates_completed_response_usage() {
        let mut parser = SseParser::default();
        let mut events = VecDeque::new();
        parser
            .push(
                br#"data: {"type":"response.completed","response":{"usage":{"input_tokens":164000,"input_tokens_details":{"cached_tokens":120000},"output_tokens":10000,"output_tokens_details":{"reasoning_tokens":8000},"total_tokens":174000}}}

"#,
                &mut events,
            )
            .expect("completed usage should decode");
        let Some(ResponseEvent::Completed(Some(usage))) = events.pop_front() else {
            panic!("completed usage event should be emitted");
        };

        assert_eq!(usage.cached_input_tokens, 120_000);
        assert_eq!(usage.total_tokens, 174_000);
    }

    #[test]
    fn accepts_completed_response_without_usage() {
        let mut parser = SseParser::default();
        let mut events = VecDeque::new();
        parser
            .push(
                br#"data: {"type":"response.completed","response":{"id":"response-1"}}

"#,
                &mut events,
            )
            .expect("usage is optional on a completed response");

        assert!(matches!(
            events.pop_front(),
            Some(ResponseEvent::Completed(None))
        ));
    }

    #[test]
    fn emits_current_response_metadata_as_typed_events() {
        let mut parser = SseParser::default();
        let mut events = VecDeque::new();
        parser
            .push(
                br#"data: {"type":"response.metadata","headers":{"OpenAI-Model":"gpt-fallback","x-codex-turn-state":"route-1"},"metadata":{"openai_verification_recommendation":["trusted_access_for_cyber","trusted_access_for_cyber"],"openai_chatgpt_moderation_metadata":{"presentation":"inline"}}}

"#,
                &mut events,
            )
            .expect("response metadata should decode");

        assert!(matches!(
            events.pop_front(),
            Some(ResponseEvent::ServerModel(model)) if model == "gpt-fallback"
        ));
        assert!(matches!(
            events.pop_front(),
            Some(ResponseEvent::TurnState(state)) if state == "route-1"
        ));
        assert!(matches!(
            events.pop_front(),
            Some(ResponseEvent::ModelVerifications(verifications))
                if verifications == [ModelVerification::TrustedAccessForCyber]
        ));
        assert!(matches!(
            events.pop_front(),
            Some(ResponseEvent::TurnModerationMetadata(metadata))
                if matches!(
                    metadata.presentation,
                    crate::engine::ModerationPresentation::Inline
                )
        ));
        assert!(events.is_empty());
    }

    #[test]
    fn rejects_unknown_model_verification_metadata() {
        let mut parser = SseParser::default();
        let mut events = VecDeque::new();
        let error = parser
            .push(
                br#"data: {"type":"response.metadata","metadata":{"openai_verification_recommendation":["future_verification"]}}

"#,
                &mut events,
            )
            .expect_err("unknown verification metadata must fail explicitly");

        assert!(error.to_string().contains("future_verification"));
        assert!(events.is_empty());
    }

    #[test]
    fn emits_output_item_added_with_the_message_phase_before_text_deltas() {
        let mut parser = SseParser::default();
        let mut events = VecDeque::new();
        parser
            .push(
                br#"data: {"type":"response.output_item.added","item":{"type":"message","id":"message-1","role":"assistant","phase":"commentary","content":[]}}

"#,
                &mut events,
            )
            .expect("an added assistant message should decode");

        assert!(matches!(
            events.pop_front(),
            Some(ResponseEvent::OutputItemAdded(ResponseItem::Message {
                id: Some(id),
                phase: Some(ResponseMessagePhase::Commentary),
                ..
            })) if id == "message-1"
        ));
        assert!(events.is_empty());
    }

    #[test]
    fn emits_safety_buffering_before_the_underlying_response_event() {
        let mut parser = SseParser::new(Some("gpt-fast-header".into()));
        let mut events = VecDeque::new();
        parser
            .push(
                br#"data: {"type":"response.output_text.delta","item_id":"message-1","delta":"hello","safety_buffering":{"use_cases":["cyber"],"reasons":["policy-check"]}}

"#,
                &mut events,
            )
            .expect("safety metadata should not drop the response delta");

        assert!(matches!(
            events.pop_front(),
            Some(ResponseEvent::SafetyBuffering(buffering))
                if buffering.faster_model.as_deref() == Some("gpt-fast-header")
                    && buffering.use_cases == ["cyber"]
        ));
        assert!(matches!(
            events.pop_front(),
            Some(ResponseEvent::OutputTextDelta { delta, .. }) if delta == "hello"
        ));
        assert!(events.is_empty());
    }

    #[test]
    fn rejects_incoherent_completed_response_usage() {
        let mut parser = SseParser::default();
        let mut events = VecDeque::new();
        let result = parser.push(
            br#"data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":11},"output_tokens":2,"output_tokens_details":{"reasoning_tokens":1},"total_tokens":12}}}

"#,
            &mut events,
        );

        assert!(result.is_err());
        assert!(events.is_empty());
    }

    #[test]
    fn omits_reasoning_when_the_model_has_no_selected_effort() {
        let request = ResponseRequest::new(
            "gpt-test",
            "Be useful.",
            &[],
            &[],
            ResponseRequestSettings::default(),
        );
        let encoded = serde_json::to_value(request).expect("request should serialize");

        assert!(encoded.get("reasoning").is_none());
    }

    #[test]
    fn serializes_codex_reasoning_as_an_effort_without_a_mode() {
        let request = ResponseRequest::new(
            "gpt-5.6-sol",
            "Be useful.",
            &[],
            &[],
            ResponseRequestSettings {
                reasoning_effort: Some(ReasoningEffort::XHigh),
                ..ResponseRequestSettings::default()
            },
        );
        let encoded = serde_json::to_value(request).expect("request should serialize");

        assert_eq!(encoded["reasoning"]["effort"], "xhigh");
        assert!(encoded["reasoning"].get("mode").is_none());
        assert_eq!(encoded["reasoning"]["summary"], "auto");
    }

    #[test]
    fn omits_output_detail_when_the_model_default_is_selected() {
        let request = ResponseRequest::new(
            "gpt-test",
            "Be useful.",
            &[],
            &[],
            ResponseRequestSettings::default(),
        );
        let encoded = serde_json::to_value(request).expect("request should serialize");

        assert!(encoded.get("text").is_none());
    }

    #[test]
    fn serializes_an_explicit_output_detail_override() {
        let request = ResponseRequest::new(
            "gpt-test",
            "Be useful.",
            &[],
            &[],
            ResponseRequestSettings {
                verbosity: Some(ModelVerbosity::Low),
                ..ResponseRequestSettings::default()
            },
        );
        let encoded = serde_json::to_value(request).expect("request should serialize");

        assert_eq!(encoded["text"]["verbosity"], "low");
    }

    #[test]
    fn compaction_uses_the_current_streaming_trigger() {
        let input = [ResponseItem::compaction_trigger()];
        let request = ResponseRequest::new(
            "gpt-test",
            "Be useful.",
            &input,
            &[],
            ResponseRequestSettings::default(),
        );
        let encoded = serde_json::to_value(request).expect("request should serialize");

        assert_eq!(encoded["parallel_tool_calls"], false);
        assert_eq!(encoded["input"][0]["type"], "compaction_trigger");
        assert_eq!(encoded["stream"], true);
        assert_eq!(encoded["tool_choice"], "auto");
    }

    #[test]
    fn decodes_the_remote_compaction_checkpoint() {
        let item: ResponseItem = serde_json::from_str(
            r#"{"type":"compaction","encrypted_content":"encrypted","internal_chat_message_metadata_passthrough":{"turn_id":"turn-1"}}"#,
        )
        .expect("compaction output should decode");

        assert!(item.is_compaction_checkpoint());
        assert_eq!(
            item.compaction_checkpoint(),
            Some(("encrypted", Some("turn-1")))
        );
    }

    #[test]
    fn rejects_unknown_event_discriminators() {
        let mut parser = SseParser::default();
        let mut events = VecDeque::new();

        let error = parser
            .push(b"data: {\"type\":\"response.future\"}\n\n", &mut events)
            .expect_err("unknown response events must fail explicitly");

        assert!(events.is_empty());
        assert!(error.to_string().contains("response.future"));
    }

    #[test]
    fn keeps_streaming_across_keepalive_events() {
        let mut parser = SseParser::default();
        let mut events = VecDeque::new();

        for chunk in [
            br#"data: {"type":"response.output_text.delta","item_id":"message-1","delta":"antes"}

"#
            .as_slice(),
            br#"data: {"type":"keepalive"}

"#
            .as_slice(),
            br#"data: {"type":"response.output_text.delta","item_id":"message-1","delta":" depois"}

"#
            .as_slice(),
        ] {
            parser
                .push(chunk, &mut events)
                .expect("keepalive should not terminate a valid response stream");
        }

        assert_eq!(events.len(), 2);
        assert!(matches!(
            events.pop_front(),
            Some(ResponseEvent::OutputTextDelta { item_id, delta })
                if item_id == "message-1" && delta == "antes"
        ));
        assert!(matches!(
            events.pop_front(),
            Some(ResponseEvent::OutputTextDelta { item_id, delta })
                if item_id == "message-1" && delta == " depois"
        ));
    }

    #[test]
    fn accepts_reasoning_summary_part_completion_marker() {
        let mut parser = SseParser::default();
        let mut events = VecDeque::new();
        parser
            .push(
                br#"data: {"type":"response.reasoning_summary_part.done","item_id":"rs-1","summary_index":0}

"#,
                &mut events,
            )
            .expect("reasoning summary lifecycle marker should be accepted");

        assert!(events.is_empty());
    }

    #[test]
    fn accepts_web_search_lifecycle_markers() {
        let mut parser = SseParser::default();
        let mut events = VecDeque::new();

        for kind in [
            "response.web_search_call.in_progress",
            "response.web_search_call.searching",
            "response.web_search_call.completed",
        ] {
            let event = format!("data: {{\"type\":\"{kind}\",\"item_id\":\"search-1\"}}\n\n");
            parser
                .push(event.as_bytes(), &mut events)
                .expect("web search lifecycle marker should be accepted");
        }

        assert!(events.is_empty());
    }
}
