use std::collections::{BTreeMap, VecDeque};
use std::time::Duration;

use serde_json::{Map, Value};
use tokio::sync::watch;

use crate::error::AppError;

const MAX_SSE_LINE_BYTES: usize = 1_048_576;
const MAX_SSE_EVENT_BYTES: usize = 4 * 1_048_576;
pub(super) const MAX_MESSAGE_TEXT_BYTES: usize = 8 * 1_048_576;
const MAX_IDENTIFIER_BYTES: usize = 256;
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ChatMessageSnapshot {
    pub conversation_id: Option<String>,
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ChatMessageDelta {
    pub conversation_id: Option<String>,
    pub id: String,
    pub delta: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ChatStreamEvent {
    Message(ChatMessageSnapshot),
    MessageDelta(ChatMessageDelta),
    ConversationId(String),
    Completed,
    Interrupted,
}

pub(super) struct ChatStream {
    response: reqwest::Response,
    parser: ChatSseParser,
    pending: VecDeque<ChatStreamEvent>,
    ended: bool,
}

impl ChatStream {
    pub fn new(response: reqwest::Response) -> Self {
        Self {
            response,
            parser: ChatSseParser::default(),
            pending: VecDeque::new(),
            ended: false,
        }
    }

    pub async fn next_event(
        &mut self,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<Option<ChatStreamEvent>, AppError> {
        loop {
            if let Some(event) = self.pending.pop_front() {
                return Ok(Some(event));
            }
            if self.ended {
                return Ok(None);
            }
            if *cancellation.borrow() {
                self.ended = true;
                return Ok(Some(ChatStreamEvent::Interrupted));
            }

            let next_chunk = tokio::time::timeout(STREAM_IDLE_TIMEOUT, self.response.chunk());
            let chunk = tokio::select! {
                changed = cancellation.changed() => {
                    if changed.is_err() || *cancellation.borrow() {
                        self.ended = true;
                        return Ok(Some(ChatStreamEvent::Interrupted));
                    }
                    continue;
                }
                result = next_chunk => {
                    result.map_err(|_| AppError::Timeout { operation: "ChatGPT response stream" })?
                        .map_err(|error| AppError::Provider(error.to_string()))?
                }
            };
            match chunk {
                Some(chunk) => self.parser.push(&chunk, &mut self.pending)?,
                None => {
                    self.parser.finish(&mut self.pending)?;
                    if !self
                        .pending
                        .iter()
                        .any(|event| matches!(event, ChatStreamEvent::Completed))
                    {
                        self.pending.push_back(ChatStreamEvent::Completed);
                    }
                    self.ended = true;
                }
            }
        }
    }
}

#[derive(Default)]
struct ChatSseParser {
    line: Vec<u8>,
    event: Option<String>,
    data: Vec<String>,
    event_bytes: usize,
    payload_decoder: PayloadDecoder,
}

impl ChatSseParser {
    fn push(
        &mut self,
        chunk: &[u8],
        output: &mut VecDeque<ChatStreamEvent>,
    ) -> Result<(), AppError> {
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
                        "ChatGPT SSE line exceeds {MAX_SSE_LINE_BYTES} bytes"
                    )));
                }
                self.line.push(*byte);
            }
        }
        Ok(())
    }

    fn finish(&mut self, output: &mut VecDeque<ChatStreamEvent>) -> Result<(), AppError> {
        if !self.line.is_empty() {
            let line = std::mem::take(&mut self.line);
            self.process_line(&line, output)?;
        }
        self.dispatch(output)
    }

    fn process_line(
        &mut self,
        line: &[u8],
        output: &mut VecDeque<ChatStreamEvent>,
    ) -> Result<(), AppError> {
        if line.is_empty() {
            return self.dispatch(output);
        }
        if line.first() == Some(&b':') {
            return Ok(());
        }
        let line = std::str::from_utf8(line)
            .map_err(|error| AppError::Provider(format!("ChatGPT SSE is not UTF-8: {error}")))?;
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => self.event = Some(value.to_string()),
            "data" => {
                self.event_bytes = self.event_bytes.saturating_add(value.len());
                if self.event_bytes > MAX_SSE_EVENT_BYTES {
                    return Err(AppError::Provider(format!(
                        "ChatGPT SSE event exceeds {MAX_SSE_EVENT_BYTES} bytes"
                    )));
                }
                self.data.push(value.to_string());
            }
            "id" | "retry" => {}
            _ => {}
        }
        Ok(())
    }

    fn dispatch(&mut self, output: &mut VecDeque<ChatStreamEvent>) -> Result<(), AppError> {
        self.event_bytes = 0;
        let event = self.event.take();
        if self.data.is_empty() {
            return Ok(());
        }
        let data = std::mem::take(&mut self.data).join("\n");
        if data == "[DONE]" {
            output.push_back(ChatStreamEvent::Completed);
            return Ok(());
        }
        self.payload_decoder
            .decode_into(event.as_deref(), &data, output)
    }
}

#[derive(Default)]
struct PayloadDecoder {
    delta: Option<DeltaDecoder>,
}

impl PayloadDecoder {
    fn decode_into(
        &mut self,
        event: Option<&str>,
        data: &str,
        output: &mut VecDeque<ChatStreamEvent>,
    ) -> Result<(), AppError> {
        match event {
            Some("delta_encoding") => {
                let encoding = serde_json::from_str::<Value>(data)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_string))
                    .unwrap_or_else(|| data.trim_matches('"').to_string());
                if encoding != "v1" {
                    return Err(AppError::Provider(format!(
                        "ChatGPT selected unknown delta encoding `{encoding}`"
                    )));
                }
                self.delta = Some(DeltaDecoder::default());
                Ok(())
            }
            Some("delta") => {
                let delta: Value = serde_json::from_str(data).map_err(|error| {
                    AppError::Provider(format!("invalid ChatGPT delta event: {error}"))
                })?;
                let decoder = self.delta.as_mut().ok_or_else(|| {
                    AppError::Provider("ChatGPT sent a delta before declaring its encoding".into())
                })?;
                decoder.apply(delta, output)
            }
            _ => {
                let payload = serde_json::from_str(data).map_err(|error| {
                    AppError::Provider(format!("invalid ChatGPT SSE event: {error}"))
                })?;
                decode_payload(&payload, output)
            }
        }
    }
}

#[derive(Debug, Clone)]
struct Delta {
    channel: u64,
    path: String,
    operation: DeltaOperation,
    value: Option<Value>,
}

#[derive(Debug, Clone, Copy)]
enum DeltaOperation {
    Add,
    Append,
    Patch,
    Remove,
    Replace,
    Truncate,
}

struct DeltaDecoder {
    previous: Option<Delta>,
    value_by_channel: BTreeMap<u64, Value>,
}

impl Default for DeltaDecoder {
    fn default() -> Self {
        Self {
            previous: Some(Delta {
                channel: 0,
                path: String::new(),
                operation: DeltaOperation::Add,
                value: None,
            }),
            value_by_channel: BTreeMap::new(),
        }
    }
}

impl DeltaDecoder {
    fn apply(
        &mut self,
        value: Value,
        output: &mut VecDeque<ChatStreamEvent>,
    ) -> Result<(), AppError> {
        let delta = decode_delta(value, self.previous.as_ref())?;
        let root = self
            .value_by_channel
            .entry(delta.channel)
            .or_insert(Value::Null);
        apply_delta(root, &delta)?;
        if let Some(event) = decode_appended_message_delta(root, &delta)? {
            output.push_back(ChatStreamEvent::MessageDelta(event));
        } else {
            decode_payload(root, output)?;
        }
        self.previous = Some(delta);
        Ok(())
    }
}

fn decode_delta(value: Value, previous: Option<&Delta>) -> Result<Delta, AppError> {
    let object = value.as_object().ok_or_else(delta_error)?;
    let channel = object
        .get("c")
        .or_else(|| object.get("channel"))
        .and_then(Value::as_u64)
        .or_else(|| previous.map(|delta| delta.channel))
        .ok_or_else(delta_error)?;
    let path = object
        .get("p")
        .or_else(|| object.get("path"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| previous.map(|delta| delta.path.clone()))
        .ok_or_else(delta_error)?;
    let operation = object
        .get("o")
        .or_else(|| object.get("op"))
        .and_then(Value::as_str)
        .map(parse_delta_operation)
        .transpose()?
        .or_else(|| previous.map(|delta| delta.operation))
        .ok_or_else(delta_error)?;
    let value = object.get("v").or_else(|| object.get("value")).cloned();
    match operation {
        DeltaOperation::Add
        | DeltaOperation::Append
        | DeltaOperation::Replace
        | DeltaOperation::Truncate
            if value.is_none() =>
        {
            return Err(delta_error());
        }
        DeltaOperation::Patch if !value.as_ref().is_some_and(Value::is_array) => {
            return Err(delta_error());
        }
        DeltaOperation::Remove | DeltaOperation::Patch => {}
        _ => {}
    }
    Ok(Delta {
        channel,
        path,
        operation,
        value,
    })
}

fn parse_delta_operation(value: &str) -> Result<DeltaOperation, AppError> {
    match value {
        "add" => Ok(DeltaOperation::Add),
        "append" => Ok(DeltaOperation::Append),
        "patch" => Ok(DeltaOperation::Patch),
        "remove" => Ok(DeltaOperation::Remove),
        "replace" => Ok(DeltaOperation::Replace),
        "truncate" => Ok(DeltaOperation::Truncate),
        _ => Err(delta_error()),
    }
}

#[derive(Debug, Clone)]
enum PathSegment {
    Key(String),
    Index(usize),
}

fn apply_delta(root: &mut Value, delta: &Delta) -> Result<(), AppError> {
    let segments = parse_pointer(&delta.path)?;
    apply_at(root, &segments, delta.operation, delta.value.as_ref())
}

fn apply_at(
    current: &mut Value,
    path: &[PathSegment],
    operation: DeltaOperation,
    value: Option<&Value>,
) -> Result<(), AppError> {
    if path.is_empty() {
        return apply_to_value(current, operation, value);
    }
    ensure_container(current, &path[0]);
    if path.len() == 1 {
        return apply_to_member(current, &path[0], operation, value);
    }
    let child = child_mut(current, &path[0], &path[1])?;
    apply_at(child, &path[1..], operation, value)
}

fn apply_to_value(
    target: &mut Value,
    operation: DeltaOperation,
    value: Option<&Value>,
) -> Result<(), AppError> {
    match operation {
        DeltaOperation::Add | DeltaOperation::Replace => {
            *target = value.cloned().ok_or_else(delta_error)?;
        }
        DeltaOperation::Remove => *target = Value::Null,
        DeltaOperation::Append => append_value(target, value.ok_or_else(delta_error)?)?,
        DeltaOperation::Truncate => truncate_value(target, value.ok_or_else(delta_error)?)?,
        DeltaOperation::Patch => {
            let nested_defaults = Delta {
                channel: 0,
                path: String::new(),
                operation: DeltaOperation::Add,
                value: None,
            };
            for nested in value.and_then(Value::as_array).ok_or_else(delta_error)? {
                let nested = decode_delta(nested.clone(), Some(&nested_defaults))?;
                apply_delta(target, &nested)?;
            }
        }
    }
    Ok(())
}

fn apply_to_member(
    parent: &mut Value,
    segment: &PathSegment,
    operation: DeltaOperation,
    value: Option<&Value>,
) -> Result<(), AppError> {
    match (parent, segment) {
        (Value::Object(object), PathSegment::Key(key)) => {
            if matches!(operation, DeltaOperation::Remove) {
                object.remove(key);
                return Ok(());
            }
            let target = object.entry(key.clone()).or_insert(Value::Null);
            apply_to_value(target, operation, value)
        }
        (Value::Array(array), PathSegment::Index(index)) => match operation {
            DeltaOperation::Add => {
                if *index > array.len() {
                    return Err(delta_error());
                }
                array.insert(*index, value.cloned().ok_or_else(delta_error)?);
                Ok(())
            }
            DeltaOperation::Remove => {
                if *index >= array.len() {
                    return Err(delta_error());
                }
                array.remove(*index);
                Ok(())
            }
            _ => {
                let target = array.get_mut(*index).ok_or_else(delta_error)?;
                apply_to_value(target, operation, value)
            }
        },
        _ => Err(delta_error()),
    }
}

fn child_mut<'a>(
    parent: &'a mut Value,
    segment: &PathSegment,
    next: &PathSegment,
) -> Result<&'a mut Value, AppError> {
    match (parent, segment) {
        (Value::Object(object), PathSegment::Key(key)) => {
            let child = object.entry(key.clone()).or_insert_with(|| empty_for(next));
            ensure_container(child, next);
            Ok(child)
        }
        (Value::Array(array), PathSegment::Index(index)) => {
            if *index >= array.len() {
                array.resize(index.saturating_add(1), Value::Null);
            }
            let child = &mut array[*index];
            ensure_container(child, next);
            Ok(child)
        }
        _ => Err(delta_error()),
    }
}

fn ensure_container(value: &mut Value, segment: &PathSegment) {
    if value.is_null() {
        *value = empty_for(segment);
    }
}

fn empty_for(segment: &PathSegment) -> Value {
    match segment {
        PathSegment::Key(_) => Value::Object(Map::new()),
        PathSegment::Index(_) => Value::Array(Vec::new()),
    }
}

fn append_value(target: &mut Value, value: &Value) -> Result<(), AppError> {
    match target {
        Value::String(current) => {
            current.push_str(value.as_str().unwrap_or(&value.to_string()));
            Ok(())
        }
        Value::Array(current) => {
            if let Some(values) = value.as_array() {
                current.extend(values.iter().cloned());
            } else {
                current.push(value.clone());
            }
            Ok(())
        }
        Value::Object(current) => {
            let values = value.as_object().ok_or_else(delta_error)?;
            current.extend(
                values
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone())),
            );
            Ok(())
        }
        _ => {
            *target = value.clone();
            Ok(())
        }
    }
}

fn truncate_value(target: &mut Value, value: &Value) -> Result<(), AppError> {
    let length = value
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(delta_error)?;
    match target {
        Value::String(current) => {
            let byte_index = current
                .char_indices()
                .nth(length)
                .map(|(index, _)| index)
                .unwrap_or(current.len());
            current.truncate(byte_index);
            Ok(())
        }
        Value::Array(current) => {
            current.truncate(length);
            Ok(())
        }
        _ => Err(delta_error()),
    }
}

fn parse_pointer(value: &str) -> Result<Vec<PathSegment>, AppError> {
    if value.is_empty() {
        return Ok(Vec::new());
    }
    let pointer = value.strip_prefix('/').unwrap_or(value);
    pointer
        .split('/')
        .map(|part| {
            let decoded = part.replace("~1", "/").replace("~0", "~");
            let index = decoded
                .parse::<usize>()
                .ok()
                .filter(|_| decoded == "0" || !decoded.starts_with('0'));
            Ok(index.map_or(PathSegment::Key(decoded), PathSegment::Index))
        })
        .collect()
}

fn decode_payload(payload: &Value, output: &mut VecDeque<ChatStreamEvent>) -> Result<(), AppError> {
    let Some(object) = payload.as_object() else {
        return Ok(());
    };
    if let Some(error) = object.get("error").filter(|value| !value.is_null()) {
        return Err(AppError::Provider(format!(
            "ChatGPT stream failed: {}",
            provider_error_message(error)
        )));
    }
    let conversation_id = object
        .get("conversation_id")
        .and_then(Value::as_str)
        .map(validate_identifier)
        .transpose()?;
    if let Some(conversation_id) = conversation_id.as_ref() {
        output.push_back(ChatStreamEvent::ConversationId(conversation_id.clone()));
    }
    if let Some(message) = object.get("message")
        && let Some(message) = decode_message(message, conversation_id.clone())?
    {
        output.push_back(ChatStreamEvent::Message(message));
    }
    if object.get("type").and_then(Value::as_str) == Some("input_message")
        && let Some(message) = object.get("input_message")
        && let Some(message) = decode_message(message, conversation_id.clone())?
    {
        output.push_back(ChatStreamEvent::Message(message));
    }
    Ok(())
}

fn decode_appended_message_delta(
    payload: &Value,
    delta: &Delta,
) -> Result<Option<ChatMessageDelta>, AppError> {
    if !matches!(delta.operation, DeltaOperation::Append) {
        return Ok(None);
    }
    let Some(text) = delta.value.as_ref().and_then(Value::as_str) else {
        return Ok(None);
    };
    let segments = parse_pointer(&delta.path)?;
    let message_key = match segments.as_slice() {
        [
            PathSegment::Key(message),
            PathSegment::Key(content),
            PathSegment::Key(parts),
            PathSegment::Index(_),
        ] if content == "content" && parts == "parts" => message,
        [
            PathSegment::Key(message),
            PathSegment::Key(content),
            PathSegment::Key(text_key),
        ] if content == "content" && text_key == "text" => message,
        _ => return Ok(None),
    };
    if message_key != "message" && message_key != "input_message" {
        return Ok(None);
    }
    let Some(object) = payload.as_object() else {
        return Ok(None);
    };
    let conversation_id = object
        .get("conversation_id")
        .and_then(Value::as_str)
        .map(validate_identifier)
        .transpose()?;
    let Some(message) = object.get(message_key) else {
        return Ok(None);
    };
    let Some(id) = decode_message_id(message)? else {
        return Ok(None);
    };
    Ok(Some(ChatMessageDelta {
        conversation_id,
        id,
        delta: text.into(),
    }))
}

fn decode_message(
    value: &Value,
    conversation_id: Option<String>,
) -> Result<Option<ChatMessageSnapshot>, AppError> {
    let Some(id) = decode_message_id(value)? else {
        return Ok(None);
    };
    let object = value
        .as_object()
        .ok_or_else(|| AppError::Provider("ChatGPT assistant message is invalid".into()))?;
    let text = message_text(object.get("content"))?;
    Ok(Some(ChatMessageSnapshot {
        conversation_id,
        id,
        text,
    }))
}

fn decode_message_id(value: &Value) -> Result<Option<String>, AppError> {
    let Some(object) = value.as_object() else {
        return Ok(None);
    };
    if object
        .get("author")
        .and_then(Value::as_object)
        .and_then(|author| author.get("role"))
        .and_then(Value::as_str)
        != Some("assistant")
    {
        return Ok(None);
    }
    if !matches!(
        object.get("channel").and_then(Value::as_str),
        None | Some("final")
    ) {
        return Ok(None);
    }
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Provider("ChatGPT assistant message has no id".into()))
        .and_then(validate_identifier)?;
    Ok(Some(id))
}

fn message_text(content: Option<&Value>) -> Result<String, AppError> {
    let Some(content) = content.and_then(Value::as_object) else {
        return Ok(String::new());
    };
    let mut output = String::new();
    if let Some(parts) = content.get("parts").and_then(Value::as_array) {
        for part in parts {
            if let Some(text) = part.as_str() {
                output.push_str(text);
            }
        }
    } else if let Some(text) = content.get("text").and_then(Value::as_str) {
        output.push_str(text);
    }
    if output.len() > MAX_MESSAGE_TEXT_BYTES {
        return Err(AppError::Provider(format!(
            "ChatGPT assistant message exceeds {MAX_MESSAGE_TEXT_BYTES} bytes"
        )));
    }
    Ok(output)
}

fn validate_identifier(value: &str) -> Result<String, AppError> {
    if value.is_empty() || value.len() > MAX_IDENTIFIER_BYTES || value.chars().any(char::is_control)
    {
        return Err(AppError::Provider(
            "ChatGPT returned an invalid conversation identifier".into(),
        ));
    }
    Ok(value.to_string())
}

fn provider_error_message(value: &Value) -> String {
    value
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| value.as_str())
        .unwrap_or("the provider returned an unspecified stream error")
        .chars()
        .take(2_000)
        .collect()
}

fn delta_error() -> AppError {
    AppError::Provider("ChatGPT returned an invalid v1 delta payload".into())
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::{ChatSseParser, ChatStreamEvent};

    #[test]
    fn decodes_v1_delta_updates_without_cloning_the_accumulated_message() {
        let mut parser = ChatSseParser::default();
        let mut events = VecDeque::new();
        let frames = concat!(
            "event: delta_encoding\n",
            "data: \"v1\"\n\n",
            "event: delta\n",
            "data: {\"v\":{\"conversation_id\":\"conv_1\",\"message\":{\"id\":\"msg_1\",\"author\":{\"role\":\"assistant\"},\"channel\":\"final\",\"content\":{\"content_type\":\"text\",\"parts\":[\"Ol\"]}}}}\n\n",
            "event: delta\n",
            "data: {\"o\":\"append\",\"p\":\"/message/content/parts/0\",\"v\":\"á\"}\n\n",
            "data: {\"type\":\"message_stream_complete\",\"conversation_id\":\"conv_1\"}\n\n",
            "data: [DONE]\n\n"
        );

        parser
            .push(frames.as_bytes(), &mut events)
            .expect("stream should decode");

        let updates = events
            .iter()
            .filter_map(|event| match event {
                ChatStreamEvent::Message(message) => Some(message.text.as_str()),
                ChatStreamEvent::MessageDelta(message) => Some(message.delta.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(updates, ["Ol", "á"]);
        assert!(
            events
                .iter()
                .any(|event| matches!(event, ChatStreamEvent::Completed))
        );
    }

    #[test]
    fn rejects_delta_before_encoding_negotiation() {
        let mut parser = ChatSseParser::default();
        let mut events = VecDeque::new();
        let error = parser
            .push(
                b"event: delta\ndata: {\"c\":0,\"o\":\"add\",\"p\":\"\",\"v\":{}}\n\n",
                &mut events,
            )
            .expect_err("stream should be rejected");
        assert!(error.to_string().contains("before declaring"));
    }

    #[test]
    fn ignores_standard_sse_comments_and_extension_fields() {
        let mut parser = ChatSseParser::default();
        let mut events = VecDeque::new();
        parser
            .push(
                b": heartbeat\nx-provider-trace: opaque\ndata: [DONE]\n\n",
                &mut events,
            )
            .expect("standard SSE extensions should be ignored");
        assert_eq!(events.pop_front(), Some(ChatStreamEvent::Completed));
    }
}
