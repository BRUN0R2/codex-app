use std::collections::VecDeque;
use std::time::Duration;

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::watch;

use crate::engine::ImageDetail;
use crate::engine::ModelVerbosity;
use crate::engine::ReasoningEffort;
use crate::error::AppError;

const MAX_SSE_LINE_BYTES: usize = 1_048_576;
const MAX_SSE_EVENT_BYTES: usize = 2_097_152;
const MAX_DELTA_BYTES: usize = 262_144;
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize)]
pub struct ResponseRequest {
    pub model: String,
    pub instructions: String,
    pub input: Vec<ResponseItem>,
    pub tools: Vec<Value>,
    pub tool_choice: String,
    pub parallel_tool_calls: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningOptions>,
    pub store: bool,
    pub stream: bool,
    pub include: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<TextOptions>,
}

impl ResponseRequest {
    pub fn new(
        model: String,
        instructions: String,
        input: Vec<ResponseItem>,
        tools: Vec<Value>,
        reasoning_effort: Option<ReasoningEffort>,
        service_tier: Option<String>,
        verbosity: Option<ModelVerbosity>,
    ) -> Self {
        Self {
            model,
            instructions,
            input,
            tools,
            tool_choice: "auto".into(),
            parallel_tool_calls: false,
            reasoning: reasoning_effort.map(|effort| ReasoningOptions {
                effort,
                summary: "auto",
            }),
            store: false,
            stream: true,
            include: vec!["reasoning.encrypted_content".into()],
            service_tier,
            text: verbosity.map(|verbosity| TextOptions { verbosity }),
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

    pub fn id(&self) -> Option<&str> {
        match self {
            Self::Message { id, .. }
            | Self::Reasoning { id, .. }
            | Self::FunctionCall { id, .. }
            | Self::CustomToolCall { id, .. }
            | Self::WebSearchCall { id, .. } => id.as_deref(),
            Self::FunctionCallOutput { .. } | Self::CustomToolCallOutput { .. } => None,
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
    OutputItemDone(ResponseItem),
    Completed,
    Interrupted,
}

pub struct ResponseStream {
    response: reqwest::Response,
    parser: SseParser,
    pending: VecDeque<ResponseEvent>,
    ended: bool,
}

impl ResponseStream {
    pub(super) fn new(response: reqwest::Response) -> Self {
        Self {
            response,
            parser: SseParser::default(),
            pending: VecDeque::new(),
            ended: false,
        }
    }

    pub async fn next_event(
        &mut self,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<Option<ResponseEvent>, AppError> {
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

            let next_chunk = tokio::time::timeout(STREAM_IDLE_TIMEOUT, self.response.chunk());
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
                        .map_err(|error| AppError::Provider(error.to_string()))?
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
}

impl SseParser {
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
        if let Some(event) = decode_event(&data)? {
            output.push_back(event);
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct StreamEventWire {
    #[serde(rename = "type")]
    kind: String,
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
    error: Option<ResponseErrorWire>,
    #[serde(default)]
    incomplete_details: Option<IncompleteDetailsWire>,
}

#[derive(Debug, Deserialize)]
struct ResponseErrorWire {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IncompleteDetailsWire {
    #[serde(default)]
    reason: Option<String>,
}

fn decode_event(data: &str) -> Result<Option<ResponseEvent>, AppError> {
    let event: StreamEventWire = serde_json::from_str(data)
        .map_err(|error| AppError::Provider(format!("invalid SSE event: {error}")))?;
    match event.kind.as_str() {
        "response.output_text.delta" => Ok(Some(ResponseEvent::OutputTextDelta {
            item_id: required_id(event.item_id, &event.kind)?,
            delta: required_delta(event.delta, &event.kind)?,
        })),
        "response.reasoning_summary_text.delta" => Ok(Some(ResponseEvent::ReasoningSummaryDelta {
            item_id: required_id(event.item_id, &event.kind)?,
            summary_index: event.summary_index.ok_or_else(|| {
                AppError::Provider(format!("{} is missing summary_index", event.kind))
            })?,
            delta: required_delta(event.delta, &event.kind)?,
        })),
        "response.reasoning_text.delta" => Ok(Some(ResponseEvent::ReasoningContentDelta {
            item_id: required_id(event.item_id, &event.kind)?,
            content_index: event.content_index.ok_or_else(|| {
                AppError::Provider(format!("{} is missing content_index", event.kind))
            })?,
            delta: required_delta(event.delta, &event.kind)?,
        })),
        "response.output_item.done" => {
            let item = event.item.ok_or_else(|| {
                AppError::Provider("response.output_item.done is missing item".into())
            })?;
            let item = serde_json::from_value(item).map_err(|error| {
                AppError::Provider(format!("unsupported response output item: {error}"))
            })?;
            Ok(Some(ResponseEvent::OutputItemDone(item)))
        }
        "response.completed" => Ok(Some(ResponseEvent::Completed)),
        "response.failed" | "error" => Err(stream_failure(event)),
        "response.incomplete" => {
            let reason = event
                .response
                .and_then(|response| response.incomplete_details)
                .and_then(|details| details.reason)
                .unwrap_or_else(|| "unknown reason".into());
            Err(AppError::Provider(format!(
                "provider returned an incomplete response: {reason}"
            )))
        }
        "response.created"
        | "response.in_progress"
        | "response.metadata"
        | "response.output_item.added"
        | "response.content_part.added"
        | "response.content_part.done"
        | "response.output_text.done"
        | "response.reasoning_summary_part.added"
        | "response.reasoning_summary_text.done"
        | "response.reasoning_text.done"
        | "response.function_call_arguments.delta"
        | "response.function_call_arguments.done"
        | "response.custom_tool_call_input.delta"
        | "response.custom_tool_call_input.done" => Ok(None),
        unknown => Err(AppError::Provider(format!(
            "provider returned unsupported SSE event `{unknown}`"
        ))),
    }
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
    let (code, message) = error.map_or_else(
        || (None, "response stream failed without a message".into()),
        |error| {
            let message = error
                .message
                .filter(|message| !message.trim().is_empty())
                .unwrap_or_else(|| "response stream failed without a message".into());
            (error.code, message)
        },
    );
    AppError::Provider(match code {
        Some(code) => format!("{code}: {message}"),
        None => message,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::ResponseEvent;
    use super::ResponseRequest;
    use super::SseParser;

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
    fn omits_reasoning_when_the_model_has_no_selected_effort() {
        let request = ResponseRequest::new(
            "gpt-test".into(),
            "Be useful.".into(),
            Vec::new(),
            Vec::new(),
            None,
            None,
            None,
        );
        let encoded = serde_json::to_value(request).expect("request should serialize");

        assert!(encoded.get("reasoning").is_none());
    }

    #[test]
    fn rejects_unknown_event_discriminators() {
        let mut parser = SseParser::default();
        let mut events = VecDeque::new();
        let result = parser.push(b"data: {\"type\":\"response.future\"}\n\n", &mut events);
        assert!(result.is_err());
    }
}
