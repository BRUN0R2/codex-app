use std::borrow::Cow;
use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::time::Duration;

use serde::Deserialize;
use serde::Serialize;
use serde::ser::SerializeSeq as _;
use serde::ser::SerializeStruct as _;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio::time::Instant;
use uuid::Uuid;

use crate::engine::ImageDetail;
use crate::engine::ModelVerbosity;
use crate::engine::ModelVerification;
use crate::engine::ReasoningEffort;
use crate::engine::TokenUsage;
use crate::error::AppError;

const MAX_SSE_LINE_BYTES: usize = 1_048_576;
pub(super) const MAX_RESPONSE_EVENT_BYTES: usize = 2_097_152;
const MAX_DELTA_BYTES: usize = 262_144;
const MAX_HEADER_VALUE_BYTES: usize = 4_096;
const MAX_ITEM_ID_BYTES: usize = 256;
const MAX_METADATA_LIST_ITEMS: usize = 64;
const MAX_METADATA_STRING_BYTES: usize = 1_024;
const MAX_SERVER_MODEL_NAME_BYTES: usize = 256;
const MAX_USAGE_TOKENS: u64 = 1_000_000_000;
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
pub(crate) const DEFAULT_FUNCTION_NAMESPACE: &str = "functions";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ResponseProtocol {
    #[default]
    Standard,
    Lite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningSummarySetting {
    #[default]
    Auto,
    Concise,
    Detailed,
    None,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResponseRequest<'a> {
    pub model: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    pub instructions: &'a str,
    pub input: ResponseRequestInput<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<&'a [Value]>,
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
    pub protocol: ResponseProtocol,
    pub parallel_tool_calls: bool,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub reasoning_summary: Option<ReasoningSummarySetting>,
    pub service_tier: Option<&'a str>,
    pub prompt_cache_key: Option<&'a str>,
    pub verbosity: Option<ModelVerbosity>,
}

impl<'a> ResponseRequest<'a> {
    pub fn new(
        model: &'a str,
        base_instructions: &'a str,
        context: &'a [ResponseItem],
        input: &'a [ResponseItem],
        tools: &'a [Value],
        settings: ResponseRequestSettings<'a>,
    ) -> Result<Self, AppError> {
        Self::new_with_tail(
            model,
            base_instructions,
            context,
            input,
            &[],
            tools,
            settings,
        )
    }

    pub(in crate::engine::native) fn new_with_tail(
        model: &'a str,
        base_instructions: &'a str,
        context: &'a [ResponseItem],
        input: &'a [ResponseItem],
        tail: &'a [ResponseItem],
        tools: &'a [Value],
        settings: ResponseRequestSettings<'a>,
    ) -> Result<Self, AppError> {
        let lite_prefix = match settings.protocol {
            ResponseProtocol::Standard => None,
            ResponseProtocol::Lite => Some(LitePrefix::new(
                settings.prompt_cache_key.ok_or_else(|| {
                    AppError::Protocol("Responses Lite requires a stable prompt cache key".into())
                })?,
                base_instructions,
                tools,
            )?),
        };
        let reasoning = ReasoningOptions {
            effort: settings.reasoning_effort,
            summary: settings.reasoning_summary,
            context: (settings.protocol == ResponseProtocol::Lite)
                .then_some(ReasoningContext::AllTurns),
        };
        Ok(Self {
            model,
            instructions: match settings.protocol {
                ResponseProtocol::Standard => base_instructions,
                ResponseProtocol::Lite => "",
            },
            input: ResponseRequestInput {
                lite_prefix,
                context,
                history: input,
                tail,
                strip_image_detail: settings.protocol == ResponseProtocol::Lite,
            },
            tools: (settings.protocol == ResponseProtocol::Standard).then_some(tools),
            tool_choice: "auto",
            parallel_tool_calls: settings.parallel_tool_calls
                && settings.protocol == ResponseProtocol::Standard,
            reasoning: reasoning.has_values().then_some(reasoning),
            store: false,
            stream: true,
            include: ["reasoning.encrypted_content"],
            service_tier: settings.service_tier,
            prompt_cache_key: settings.prompt_cache_key,
            text: settings
                .verbosity
                .map(|verbosity| TextOptions { verbosity }),
        })
    }

    pub const fn uses_responses_lite(&self) -> bool {
        self.input.lite_prefix.is_some()
    }

    pub(super) fn prepare_websocket_request(
        &self,
        previous_request: Option<ResponseRequestBaseline>,
        previous_response: Option<CompletedWebSocketResponse>,
        thread_id: &str,
        turn_state: Option<&str>,
    ) -> Result<PreparedWebSocketRequest, AppError> {
        self.prepare_websocket_request_with_baseline(
            previous_request,
            previous_response,
            thread_id,
            turn_state,
            true,
            None,
        )
    }

    pub(super) fn prepare_websocket_compaction_request(
        &self,
        previous_request: Option<ResponseRequestBaseline>,
        previous_response: Option<CompletedWebSocketResponse>,
        thread_id: &str,
        turn_state: Option<&str>,
    ) -> Result<PreparedWebSocketRequest, AppError> {
        self.prepare_websocket_request_with_baseline(
            previous_request,
            previous_response,
            thread_id,
            turn_state,
            false,
            None,
        )
    }

    pub(super) fn prepare_websocket_prewarm_request(
        &self,
        thread_id: &str,
        turn_state: Option<&str>,
    ) -> Result<PreparedWebSocketRequest, AppError> {
        self.prepare_websocket_request_with_baseline(
            None,
            None,
            thread_id,
            turn_state,
            true,
            Some(false),
        )
    }

    fn prepare_websocket_request_with_baseline(
        &self,
        previous_request: Option<ResponseRequestBaseline>,
        previous_response: Option<CompletedWebSocketResponse>,
        thread_id: &str,
        turn_state: Option<&str>,
        retain_baseline: bool,
        generate: Option<bool>,
    ) -> Result<PreparedWebSocketRequest, AppError> {
        let continuation =
            previous_request
                .zip(previous_response)
                .and_then(|(request, response)| {
                    self.continuation_input_start(&request, &response)
                        .map(|input_start| (request, response, input_start))
                });
        let (previous_response_id, input_start, baseline) = match continuation {
            Some((mut request, response, input_start)) => {
                let previous_response_id = response.response_id;
                let baseline = if retain_baseline {
                    request.input.extend(
                        response
                            .output_items
                            .into_iter()
                            .map(OwnedResponseRequestInput::Response),
                    );
                    request
                        .input
                        .extend(self.input.clone_owned_range(input_start)?);
                    Some(request)
                } else {
                    None
                };
                (Some(previous_response_id), input_start, baseline)
            }
            None => (
                None,
                0,
                retain_baseline
                    .then(|| self.to_owned_baseline())
                    .transpose()?,
            ),
        };
        let envelope = WebSocketResponseRequest {
            request: self,
            previous_response_id,
            input_start,
            generate,
            client_metadata: websocket_client_metadata(thread_id, turn_state),
        };
        let payload = serde_json::to_string(&envelope).map_err(|error| {
            AppError::Protocol(format!(
                "websocket response request could not be encoded: {error}"
            ))
        })?;
        Ok(PreparedWebSocketRequest { payload, baseline })
    }

    fn continuation_input_start(
        &self,
        previous_request: &ResponseRequestBaseline,
        previous_response: &CompletedWebSocketResponse,
    ) -> Option<usize> {
        if previous_response.response_id.is_empty()
            || !self.properties_match(&previous_request.properties)
        {
            return None;
        }
        let input_start = previous_request
            .input
            .len()
            .checked_add(previous_response.output_items.len())?;
        if input_start > self.input.len() {
            return None;
        }
        let request_matches = previous_request
            .input
            .iter()
            .enumerate()
            .all(|(index, item)| self.input.matches_owned(index, item));
        let response_matches =
            previous_response
                .output_items
                .iter()
                .enumerate()
                .all(|(index, item)| {
                    self.input
                        .matches_response(previous_request.input.len() + index, item)
                });
        (request_matches && response_matches).then_some(input_start)
    }

    fn properties_match(&self, previous: &OwnedResponseRequestProperties) -> bool {
        self.model == previous.model
            && self.instructions == previous.instructions
            && self.tools == previous.tools.as_deref()
            && self.tool_choice == previous.tool_choice
            && self.parallel_tool_calls == previous.parallel_tool_calls
            && self.reasoning == previous.reasoning
            && self.store == previous.store
            && self.stream == previous.stream
            && self.include == previous.include
            && self.service_tier == previous.service_tier.as_deref()
            && self.prompt_cache_key == previous.prompt_cache_key.as_deref()
            && self.text == previous.text
    }

    fn to_owned_baseline(&self) -> Result<ResponseRequestBaseline, AppError> {
        Ok(ResponseRequestBaseline {
            properties: OwnedResponseRequestProperties {
                model: self.model.to_string(),
                instructions: self.instructions.to_string(),
                tools: self.tools.map(<[Value]>::to_vec),
                tool_choice: self.tool_choice,
                parallel_tool_calls: self.parallel_tool_calls,
                reasoning: self.reasoning.clone(),
                store: self.store,
                stream: self.stream,
                include: self.include,
                service_tier: self.service_tier.map(str::to_string),
                prompt_cache_key: self.prompt_cache_key.map(str::to_string),
                text: self.text.clone(),
            },
            input: self.input.clone_owned_range(0)?,
        })
    }
}

#[derive(Debug, Clone)]
pub(super) struct ResponseRequestBaseline {
    properties: OwnedResponseRequestProperties,
    input: Vec<OwnedResponseRequestInput>,
}

#[derive(Debug, Clone)]
pub(super) struct CompletedWebSocketResponse {
    pub response_id: String,
    pub output_items: Vec<ResponseItem>,
}

#[derive(Debug)]
pub(super) struct PreparedWebSocketRequest {
    pub payload: String,
    pub baseline: Option<ResponseRequestBaseline>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OwnedResponseRequestProperties {
    model: String,
    instructions: String,
    tools: Option<Vec<Value>>,
    tool_choice: &'static str,
    parallel_tool_calls: bool,
    reasoning: Option<ReasoningOptions>,
    store: bool,
    stream: bool,
    include: [&'static str; 1],
    service_tier: Option<String>,
    prompt_cache_key: Option<String>,
    text: Option<TextOptions>,
}

#[derive(Debug, Clone)]
enum OwnedResponseRequestInput {
    AdditionalTools(AdditionalTools),
    BaseInstructions { id: String, text: String },
    Response(ResponseItem),
}

struct WebSocketResponseRequest<'input, 'request> {
    request: &'input ResponseRequest<'request>,
    previous_response_id: Option<String>,
    input_start: usize,
    generate: Option<bool>,
    client_metadata: BTreeMap<String, String>,
}

impl Serialize for WebSocketResponseRequest<'_, '_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let request = self.request;
        let mut state = serializer.serialize_struct("WebSocketResponseRequest", 18)?;
        state.serialize_field("type", "response.create")?;
        state.serialize_field("model", request.model)?;
        if !request.instructions.is_empty() {
            state.serialize_field("instructions", request.instructions)?;
        }
        if let Some(previous_response_id) = &self.previous_response_id {
            state.serialize_field("previous_response_id", previous_response_id)?;
        }
        state.serialize_field(
            "input",
            &ResponseRequestInputRange {
                input: &request.input,
                start: self.input_start,
            },
        )?;
        if let Some(generate) = self.generate {
            state.serialize_field("generate", &generate)?;
        }
        if let Some(tools) = request.tools {
            state.serialize_field("tools", tools)?;
        }
        state.serialize_field("tool_choice", request.tool_choice)?;
        state.serialize_field("parallel_tool_calls", &request.parallel_tool_calls)?;
        if let Some(reasoning) = &request.reasoning {
            state.serialize_field("reasoning", reasoning)?;
        }
        state.serialize_field("store", &request.store)?;
        state.serialize_field("stream", &request.stream)?;
        state.serialize_field("include", &request.include)?;
        if let Some(service_tier) = request.service_tier {
            state.serialize_field("service_tier", service_tier)?;
        }
        if let Some(prompt_cache_key) = request.prompt_cache_key {
            state.serialize_field("prompt_cache_key", prompt_cache_key)?;
        }
        if let Some(text) = &request.text {
            state.serialize_field("text", text)?;
        }
        state.serialize_field("client_metadata", &self.client_metadata)?;
        state.end()
    }
}

fn websocket_client_metadata(
    thread_id: &str,
    turn_state: Option<&str>,
) -> BTreeMap<String, String> {
    let mut metadata = BTreeMap::from([
        ("session_id".into(), thread_id.into()),
        ("thread_id".into(), thread_id.into()),
    ]);
    if let Some(turn_state) = turn_state {
        metadata.insert("x-codex-turn-state".into(), turn_state.into());
    }
    metadata
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReasoningOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<ReasoningEffort>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<ReasoningSummarySetting>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<ReasoningContext>,
}

impl ReasoningOptions {
    const fn has_values(&self) -> bool {
        self.effort.is_some() || self.summary.is_some() || self.context.is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ReasoningContext {
    AllTurns,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TextOptions {
    verbosity: ModelVerbosity,
}

#[derive(Debug, Clone)]
pub struct ResponseRequestInput<'a> {
    lite_prefix: Option<LitePrefix<'a>>,
    context: &'a [ResponseItem],
    history: &'a [ResponseItem],
    tail: &'a [ResponseItem],
    strip_image_detail: bool,
}

impl Serialize for ResponseRequestInput<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        ResponseRequestInputRange {
            input: self,
            start: 0,
        }
        .serialize(serializer)
    }
}

impl ResponseRequestInput<'_> {
    fn len(&self) -> usize {
        self.lite_prefix
            .as_ref()
            .map_or(0, LitePrefix::serialized_item_count)
            .saturating_add(self.context.len())
            .saturating_add(self.history.len())
            .saturating_add(self.tail.len())
    }

    fn response_item(&self, index: usize) -> Option<&ResponseItem> {
        let prefix_len = self
            .lite_prefix
            .as_ref()
            .map_or(0, LitePrefix::serialized_item_count);
        let response_index = index.checked_sub(prefix_len)?;
        if let Some(item) = self.context.get(response_index) {
            return Some(item);
        }
        let history_index = response_index.checked_sub(self.context.len())?;
        if let Some(item) = self.history.get(history_index) {
            return Some(item);
        }
        self.tail
            .get(history_index.checked_sub(self.history.len())?)
    }

    fn matches_owned(&self, index: usize, owned: &OwnedResponseRequestInput) -> bool {
        if let Some(prefix) = &self.lite_prefix {
            if index == 0 {
                return matches!(
                    owned,
                    OwnedResponseRequestInput::AdditionalTools(candidate)
                        if candidate == &prefix.additional_tools
                );
            }
            if let Some(base_instructions) = &prefix.base_instructions
                && index == 1
            {
                return matches!(
                    owned,
                    OwnedResponseRequestInput::BaseInstructions { id, text }
                        if id == &base_instructions.id
                            && text == base_instructions.content[0].text()
                );
            }
        }
        let OwnedResponseRequestInput::Response(previous) = owned else {
            return false;
        };
        self.matches_response(index, previous)
    }

    fn matches_response(&self, index: usize, previous: &ResponseItem) -> bool {
        let Some(current) = self.response_item(index) else {
            return false;
        };
        current
            .for_request(self.strip_image_detail)
            .equivalent_for_continuation(previous)
    }

    fn clone_owned(&self, index: usize) -> Option<OwnedResponseRequestInput> {
        if let Some(prefix) = &self.lite_prefix {
            if index == 0 {
                return Some(OwnedResponseRequestInput::AdditionalTools(
                    prefix.additional_tools.clone(),
                ));
            }
            if let Some(base_instructions) = &prefix.base_instructions
                && index == 1
            {
                return Some(OwnedResponseRequestInput::BaseInstructions {
                    id: base_instructions.id.clone(),
                    text: base_instructions.content[0].text().to_string(),
                });
            }
        }
        self.response_item(index).map(|item| {
            OwnedResponseRequestInput::Response(
                item.for_request(self.strip_image_detail).into_owned(),
            )
        })
    }

    fn clone_owned_range(&self, start: usize) -> Result<Vec<OwnedResponseRequestInput>, AppError> {
        (start..self.len())
            .map(|index| {
                self.clone_owned(index).ok_or_else(|| {
                    AppError::State("response input range exceeded the request".into())
                })
            })
            .collect()
    }

    fn serialize_item<S>(&self, sequence: &mut S, index: usize) -> Result<(), S::Error>
    where
        S: serde::ser::SerializeSeq,
    {
        if let Some(prefix) = &self.lite_prefix {
            if index == 0 {
                return sequence.serialize_element(&prefix.additional_tools);
            }
            if let Some(base_instructions) = &prefix.base_instructions
                && index == 1
            {
                return sequence.serialize_element(base_instructions);
            }
        }
        let item = self.response_item(index).ok_or_else(|| {
            serde::ser::Error::custom("response input index is outside the request")
        })?;
        sequence.serialize_element(&RequestResponseItem {
            item,
            strip_image_detail: self.strip_image_detail,
        })
    }
}

struct ResponseRequestInputRange<'input, 'request> {
    input: &'input ResponseRequestInput<'request>,
    start: usize,
}

impl Serialize for ResponseRequestInputRange<'_, '_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let count = self.input.len().saturating_sub(self.start);
        let mut sequence = serializer.serialize_seq(Some(count))?;
        for index in self.start..self.input.len() {
            self.input.serialize_item(&mut sequence, index)?;
        }
        sequence.end()
    }
}

#[derive(Debug, Clone)]
struct LitePrefix<'a> {
    additional_tools: AdditionalTools,
    base_instructions: Option<BaseInstructions<'a>>,
}

impl<'a> LitePrefix<'a> {
    fn new(
        prompt_cache_key: &str,
        base_instructions: &'a str,
        tools: &[Value],
    ) -> Result<Self, AppError> {
        let namespace = Uuid::new_v5(&Uuid::NAMESPACE_OID, prompt_cache_key.as_bytes());
        let tools = tools_for_responses_lite(tools)?;
        let encoded_tools = serde_json::to_vec(&tools).map_err(|error| {
            AppError::Protocol(format!("tool definitions could not be encoded: {error}"))
        })?;
        let additional_tools = AdditionalTools::new(
            format!("at_{}", Uuid::new_v5(&namespace, &encoded_tools)),
            tools,
        );
        let base_instructions = (!base_instructions.is_empty()).then(|| BaseInstructions {
            kind: "message",
            id: format!(
                "msg_{}",
                Uuid::new_v5(&namespace, base_instructions.as_bytes())
            ),
            role: "developer",
            content: [ResponseContentRef::InputText {
                text: base_instructions,
            }],
            internal_chat_message_metadata_passthrough: ContentItemKinds::single(
                "model.base_instructions",
            ),
        });
        Ok(Self {
            additional_tools,
            base_instructions,
        })
    }

    fn serialized_item_count(&self) -> usize {
        1 + usize::from(self.base_instructions.is_some())
    }
}

fn tools_for_responses_lite(tools: &[Value]) -> Result<Vec<Value>, AppError> {
    let mut functions = Vec::new();
    let mut functions_description = String::new();
    let mut functions_index = None;
    let mut converted = Vec::with_capacity(tools.len());

    for tool in tools {
        let object = tool
            .as_object()
            .ok_or_else(|| AppError::Protocol("tool definition must be a JSON object".into()))?;
        let kind = object.get("type").and_then(Value::as_str).ok_or_else(|| {
            AppError::Protocol("tool definition must contain a string `type`".into())
        })?;
        match kind {
            "function" | "custom" => {
                functions_index.get_or_insert(converted.len());
                functions.push(tool.clone());
            }
            "namespace" => {
                let name = object.get("name").and_then(Value::as_str).ok_or_else(|| {
                    AppError::Protocol("tool namespace must contain a string `name`".into())
                })?;
                if name != DEFAULT_FUNCTION_NAMESPACE {
                    return Err(AppError::Protocol(format!(
                        "Responses Lite cannot advertise the unexecutable `{name}` tool namespace"
                    )));
                }
                functions_index.get_or_insert(converted.len());
                if let Some(description) = object.get("description").and_then(Value::as_str)
                    && !description.trim().is_empty()
                {
                    functions_description = description.to_string();
                }
                let children = object
                    .get("tools")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        AppError::Protocol(
                            "default tool namespace must contain a `tools` array".into(),
                        )
                    })?;
                for child in children {
                    let child_kind = child
                        .as_object()
                        .and_then(|child| child.get("type"))
                        .and_then(Value::as_str);
                    if !matches!(child_kind, Some("function" | "custom")) {
                        return Err(AppError::Protocol(
                            "default tool namespace contains an unsupported tool".into(),
                        ));
                    }
                    functions.push(child.clone());
                }
            }
            "tool_search" => {
                return Err(AppError::Protocol(
                    "Responses Lite cannot advertise tool search without a local namespace loader"
                        .into(),
                ));
            }
            "web_search" | "image_generation" => {
                return Err(AppError::Protocol(format!(
                    "Responses Lite does not accept hosted `{kind}` tools"
                )));
            }
            _ => {
                return Err(AppError::Protocol(format!(
                    "Responses Lite does not support tool type `{kind}`"
                )));
            }
        }
    }

    if let Some(index) = functions_index
        && !functions.is_empty()
    {
        converted.insert(
            index,
            serde_json::json!({
                "type": "namespace",
                "name": DEFAULT_FUNCTION_NAMESPACE,
                "description": functions_description,
                "tools": functions,
            }),
        );
    }
    Ok(converted)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct AdditionalTools {
    #[serde(rename = "type")]
    kind: &'static str,
    id: String,
    role: &'static str,
    tools: Vec<Value>,
}

impl AdditionalTools {
    fn new(id: String, tools: Vec<Value>) -> Self {
        Self {
            kind: "additional_tools",
            id,
            role: "developer",
            tools,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct BaseInstructions<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    id: String,
    role: &'static str,
    content: [ResponseContentRef<'a>; 1],
    internal_chat_message_metadata_passthrough: ContentItemKinds<'static>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ResponseContentRef<'a> {
    InputText { text: &'a str },
}

impl ResponseContentRef<'_> {
    const fn text(&self) -> &str {
        match self {
            Self::InputText { text } => text,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct ContentItemKinds<'a> {
    content_item_kinds: [&'a str; 1],
}

impl<'a> ContentItemKinds<'a> {
    const fn single(kind: &'a str) -> Self {
        Self {
            content_item_kinds: [kind],
        }
    }
}

struct RequestResponseItem<'a> {
    item: &'a ResponseItem,
    strip_image_detail: bool,
}

impl Serialize for RequestResponseItem<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.item
            .for_request(self.strip_image_detail)
            .serialize(serializer)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResponseItem {
    Message {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        role: String,
        content: Vec<ResponseContent>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<ResponseMessagePhase>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        internal_chat_message_metadata_passthrough: Option<InternalChatMessageMetadataPassthrough>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        namespace: Option<String>,
        name: String,
        arguments: String,
        call_id: String,
    },
    FunctionCallOutput {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        call_id: String,
        output: FunctionCallOutputPayload,
    },
    CustomToolCall {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        namespace: Option<String>,
        call_id: String,
        name: String,
        input: String,
    },
    CustomToolCallOutput {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        output: FunctionCallOutputPayload,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FunctionCallOutputPayload {
    Text(String),
    Content(Vec<FunctionCallOutputContent>),
}

impl FunctionCallOutputPayload {
    pub(crate) fn content(&self) -> Option<&[FunctionCallOutputContent]> {
        match self {
            Self::Text(_) => None,
            Self::Content(content) => Some(content),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[expect(
    clippy::enum_variant_names,
    reason = "Responses API wire names are input_text, input_image, and input_audio"
)]
pub enum FunctionCallOutputContent {
    InputText {
        text: String,
    },
    InputImage {
        image_url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<ImageDetail>,
    },
    InputAudio {
        audio_url: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct InternalChatMessageMetadataPassthrough {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_item_kinds: Option<Vec<String>>,
}

impl InternalChatMessageMetadataPassthrough {
    pub(in crate::engine::native) fn retaining_content_indices(
        &self,
        original_content_len: usize,
        retained_indices: &[usize],
    ) -> Option<Self> {
        let mut retained = self.clone();
        let Some(kinds) = retained.content_item_kinds.as_mut() else {
            return Some(retained);
        };
        if kinds.len() != original_content_len {
            return None;
        }
        *kinds = retained_indices
            .iter()
            .map(|index| kinds[*index].clone())
            .collect();
        Some(retained)
    }
}

impl ResponseItem {
    #[cfg(test)]
    pub fn user_content(content: Vec<ResponseContent>) -> Self {
        Self::Message {
            id: None,
            role: "user".into(),
            content,
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }
    }

    pub fn user_content_with_id(stable_seed: &str, content: Vec<ResponseContent>) -> Self {
        Self::Message {
            id: Some(stable_item_id("msg", [stable_seed])),
            role: "user".into(),
            content,
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }
    }

    pub fn context_text(role: impl Into<String>, text: String, content_kind: &str) -> Self {
        let role = role.into();
        Self::Message {
            id: Some(stable_item_id(
                "msg",
                [role.as_str(), content_kind, text.as_str()],
            )),
            role,
            content: vec![ResponseContent::InputText { text }],
            phase: None,
            internal_chat_message_metadata_passthrough: Some(
                InternalChatMessageMetadataPassthrough {
                    turn_id: None,
                    content_item_kinds: Some(vec![content_kind.into()]),
                },
            ),
        }
    }

    pub fn context_text_with_seed(
        role: impl Into<String>,
        text: String,
        content_kind: &str,
        stable_seed: &str,
    ) -> Self {
        let role = role.into();
        Self::Message {
            id: Some(stable_item_id(
                "msg",
                [role.as_str(), content_kind, stable_seed, text.as_str()],
            )),
            role,
            content: vec![ResponseContent::InputText { text }],
            phase: None,
            internal_chat_message_metadata_passthrough: Some(
                InternalChatMessageMetadataPassthrough {
                    turn_id: None,
                    content_item_kinds: Some(vec![content_kind.into()]),
                },
            ),
        }
    }

    pub fn function_output(call_id: String, output: String) -> Self {
        Self::function_output_payload(call_id, FunctionCallOutputPayload::Text(output))
    }

    pub fn function_output_payload(call_id: String, output: FunctionCallOutputPayload) -> Self {
        let id = stable_item_id("fco", [call_id.as_str()]);
        Self::FunctionCallOutput {
            id: Some(id),
            call_id,
            output,
        }
    }

    pub fn function_output_with_image(
        call_id: String,
        text: Option<String>,
        image_url: String,
        detail: Option<ImageDetail>,
    ) -> Self {
        let mut output = Vec::with_capacity(2);
        if let Some(text) = text.filter(|text| !text.is_empty()) {
            output.push(FunctionCallOutputContent::InputText { text });
        }
        output.push(FunctionCallOutputContent::InputImage { image_url, detail });
        let id = stable_item_id("fco", [call_id.as_str()]);
        Self::FunctionCallOutput {
            id: Some(id),
            call_id,
            output: FunctionCallOutputPayload::Content(output),
        }
    }

    pub fn custom_output(call_id: String, output: String) -> Self {
        Self::custom_output_payload(call_id, FunctionCallOutputPayload::Text(output))
    }

    pub fn custom_output_payload(call_id: String, output: FunctionCallOutputPayload) -> Self {
        let id = stable_item_id("ctco", [call_id.as_str()]);
        Self::CustomToolCallOutput {
            id: Some(id),
            call_id,
            name: None,
            output,
        }
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
            | Self::Compaction { id, .. }
            | Self::FunctionCallOutput { id, .. }
            | Self::CustomToolCallOutput { id, .. } => id.as_deref(),
            Self::CompactionTrigger { .. } => None,
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

    fn for_request(&self, strip_image_detail: bool) -> Cow<'_, Self> {
        if !strip_image_detail || !self.has_image_detail() {
            return Cow::Borrowed(self);
        }
        let mut item = self.clone();
        match &mut item {
            Self::Message { content, .. } => {
                for part in content {
                    if let ResponseContent::InputImage { detail, .. } = part {
                        *detail = None;
                    }
                }
            }
            Self::FunctionCallOutput {
                output: FunctionCallOutputPayload::Content(content),
                ..
            } => {
                for part in content {
                    if let FunctionCallOutputContent::InputImage { detail, .. } = part {
                        *detail = None;
                    }
                }
            }
            _ => {}
        }
        Cow::Owned(item)
    }

    fn equivalent_for_continuation(&self, other: &Self) -> bool {
        match (self, other) {
            (
                Self::Message {
                    id: left_id,
                    role: left_role,
                    content: left_content,
                    phase: left_phase,
                    ..
                },
                Self::Message {
                    id: right_id,
                    role: right_role,
                    content: right_content,
                    phase: right_phase,
                    ..
                },
            ) => {
                left_id == right_id
                    && left_role == right_role
                    && left_content == right_content
                    && left_phase == right_phase
            }
            (
                Self::Compaction {
                    id: left_id,
                    encrypted_content: left_content,
                    ..
                },
                Self::Compaction {
                    id: right_id,
                    encrypted_content: right_content,
                    ..
                },
            ) => left_id == right_id && left_content == right_content,
            _ => self == other,
        }
    }

    fn has_image_detail(&self) -> bool {
        match self {
            Self::Message { content, .. } => content.iter().any(|part| {
                matches!(
                    part,
                    ResponseContent::InputImage {
                        detail: Some(_),
                        ..
                    }
                )
            }),
            Self::FunctionCallOutput { output, .. } => output.content().is_some_and(|content| {
                content.iter().any(|part| {
                    matches!(
                        part,
                        FunctionCallOutputContent::InputImage {
                            detail: Some(_),
                            ..
                        }
                    )
                })
            }),
            _ => false,
        }
    }
}

fn stable_item_id<'a>(prefix: &str, segments: impl IntoIterator<Item = &'a str>) -> String {
    let namespace = segments
        .into_iter()
        .fold(Uuid::NAMESPACE_OID, |namespace, segment| {
            Uuid::new_v5(&namespace, segment.as_bytes())
        });
    format!("{prefix}_{namespace}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseCallStatus {
    InProgress,
    Searching,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseMessagePhase {
    Commentary,
    FinalAnswer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReasoningSummary {
    #[serde(rename = "type")]
    kind: ReasoningSummaryType,
    text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ReasoningSummaryType {
    SummaryText,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReasoningContent {
    #[serde(rename = "type")]
    kind: ReasoningContentType,
    text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
    ModelsEtag(String),
    TurnState(String),
    ModelVerifications(Vec<ModelVerification>),
    SafetyBuffering(SafetyBuffering),
    TransportFallback(String),
    OutputItemDone(ResponseItem),
    Completed(ResponseCompleted),
    Interrupted,
}

#[derive(Debug)]
pub struct ResponseCompleted {
    pub response_id: Option<String>,
    pub usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafetyBuffering {
    pub use_cases: Vec<String>,
    pub reasons: Vec<String>,
    pub faster_model: Option<String>,
}

pub struct ResponseStream {
    source: ResponseStreamSource,
    pending: VecDeque<ResponseEvent>,
    ended: bool,
}

enum ResponseStreamSource {
    Sse {
        response: Box<reqwest::Response>,
        parser: SseParser,
    },
    Events(mpsc::Receiver<Result<ResponseEvent, AppError>>),
}

impl ResponseStream {
    pub(super) fn new(response: reqwest::Response) -> Result<Self, AppError> {
        let (pending, safety_faster_model) = initial_response_events(response.headers())?;
        Ok(Self {
            source: ResponseStreamSource::Sse {
                response: Box::new(response),
                parser: SseParser::new(safety_faster_model),
            },
            pending,
            ended: false,
        })
    }

    pub(super) fn from_events(
        receiver: mpsc::Receiver<Result<ResponseEvent, AppError>>,
        pending: VecDeque<ResponseEvent>,
    ) -> Self {
        Self {
            source: ResponseStreamSource::Events(receiver),
            pending,
            ended: false,
        }
    }

    pub(super) fn push_pending(&mut self, event: ResponseEvent) {
        self.pending.push_back(event);
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

            match &mut self.source {
                ResponseStreamSource::Sse { response, parser } => {
                    let next_chunk = tokio::time::timeout_at(event_deadline, response.chunk());
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
                        Some(chunk) => parser.push(&chunk, &mut self.pending)?,
                        None => {
                            parser.finish(&mut self.pending)?;
                            self.ended = true;
                        }
                    }
                }
                ResponseStreamSource::Events(receiver) => {
                    let next_event = tokio::time::timeout_at(event_deadline, receiver.recv());
                    let event = tokio::select! {
                        changed = cancellation.changed() => {
                            if changed.is_err() || *cancellation.borrow() {
                                self.ended = true;
                                return Ok(Some(ResponseEvent::Interrupted));
                            }
                            continue;
                        }
                        result = next_event => {
                            result.map_err(|_| AppError::Timeout { operation: "response stream" })?
                        }
                    };
                    match event {
                        Some(Ok(event)) => return Ok(Some(event)),
                        Some(Err(error)) => {
                            self.ended = true;
                            return Err(error);
                        }
                        None => self.ended = true,
                    }
                }
            }
        }
    }
}

pub(super) fn decode_websocket_event(
    data: &str,
    safety_faster_model: Option<&str>,
) -> Result<VecDeque<ResponseEvent>, AppError> {
    let mut events = VecDeque::new();
    decode_event(data, safety_faster_model, &mut events)?;
    Ok(events)
}

pub(super) fn initial_response_events(
    headers: &reqwest::header::HeaderMap,
) -> Result<(VecDeque<ResponseEvent>, Option<String>), AppError> {
    let mut pending = VecDeque::new();
    if let Some(model) = response_header(headers, "openai-model", MAX_SERVER_MODEL_NAME_BYTES)? {
        pending.push_back(ResponseEvent::ServerModel(model));
    }
    if let Some(etag) = response_header(headers, "x-models-etag", MAX_HEADER_VALUE_BYTES)? {
        pending.push_back(ResponseEvent::ModelsEtag(etag));
    }
    if let Some(turn_state) =
        response_header(headers, "x-codex-turn-state", MAX_HEADER_VALUE_BYTES)?
    {
        pending.push_back(ResponseEvent::TurnState(turn_state));
    }
    let safety_faster_model = response_header(
        headers,
        "x-codex-safety-buffering-faster-model",
        MAX_SERVER_MODEL_NAME_BYTES,
    )?;
    Ok((pending, safety_faster_model))
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
            if self.event_bytes > MAX_RESPONSE_EVENT_BYTES {
                return Err(AppError::Provider(format!(
                    "SSE event exceeds {MAX_RESPONSE_EVENT_BYTES} bytes"
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
    #[serde(default, alias = "status_code")]
    status: Option<u16>,
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
    id: Option<String>,
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
        "response.completed" => Some(ResponseEvent::Completed(decode_completed_response(
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
            MAX_SERVER_MODEL_NAME_BYTES,
        )?));
    }

    if event.kind == "response.metadata" {
        if let Some(etag) = event
            .headers
            .as_ref()
            .and_then(|headers| json_header(headers, &["x-models-etag"]))
        {
            output.push_back(ResponseEvent::ModelsEtag(validated_metadata_text(
                etag,
                "models ETag",
                MAX_HEADER_VALUE_BYTES,
            )?));
        }
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
    }

    if let Some(buffering) =
        decode_safety_buffering(event.safety_buffering.as_ref(), safety_faster_model)?
    {
        output.push_back(ResponseEvent::SafetyBuffering(buffering));
    }
    Ok(())
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
    .map(|model| {
        validated_metadata_text(&model, "safety fallback model", MAX_SERVER_MODEL_NAME_BYTES)
    })
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
    headers: &reqwest::header::HeaderMap,
    name: &str,
    maximum: usize,
) -> Result<Option<String>, AppError> {
    headers
        .get(name)
        .map(|value| {
            value
                .to_str()
                .map_err(|_| AppError::Provider(format!("response header `{name}` is not text")))
                .and_then(|value| validated_metadata_text(value, name, maximum))
        })
        .transpose()
}

fn decode_completed_response(
    response: Option<ResponseStateWire>,
) -> Result<ResponseCompleted, AppError> {
    let response_id = response
        .as_ref()
        .and_then(|response| response.id.as_deref())
        .map(|response_id| validated_metadata_text(response_id, "response id", MAX_ITEM_ID_BYTES))
        .transpose()?;
    let Some(usage) = response.and_then(|response| response.usage) else {
        return Ok(ResponseCompleted {
            response_id,
            usage: None,
        });
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
    Ok(ResponseCompleted {
        response_id,
        usage: Some(TokenUsage {
            input_tokens: usage.input_tokens,
            cached_input_tokens: usage.input_tokens_details.cached_tokens,
            output_tokens: usage.output_tokens,
            reasoning_output_tokens: usage.output_tokens_details.reasoning_tokens,
            total_tokens: usage.total_tokens,
        }),
    })
}

fn required_id(value: Option<String>, event: &str) -> Result<String, AppError> {
    let value = value.ok_or_else(|| AppError::Provider(format!("{event} is missing item_id")))?;
    if value.is_empty() || value.len() > MAX_ITEM_ID_BYTES {
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
    let status = event.status;
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
    AppError::from_provider_rejection(status, code.as_deref(), message, retry_after_seconds)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use crate::engine::ImageDetail;
    use crate::engine::ModelVerbosity;
    use crate::engine::ModelVerification;
    use crate::engine::ReasoningEffort;

    use super::DEFAULT_FUNCTION_NAMESPACE;
    use super::FunctionCallOutputContent;
    use super::FunctionCallOutputPayload;
    use super::ReasoningSummarySetting;
    use super::ResponseContent;
    use super::ResponseEvent;
    use super::ResponseItem;
    use super::ResponseMessagePhase;
    use super::ResponseProtocol;
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
        assert!(
            value["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("ctco_"))
        );
        assert_eq!(value["call_id"], "call-1");
        assert_eq!(value["output"], "patch applied");
    }

    #[test]
    fn custom_tool_output_supports_structured_code_mode_content() {
        let output = FunctionCallOutputPayload::Content(vec![
            FunctionCallOutputContent::InputText {
                text: "preview".into(),
            },
            FunctionCallOutputContent::InputImage {
                image_url: "data:image/png;base64,AA==".into(),
                detail: Some(ImageDetail::High),
            },
            FunctionCallOutputContent::InputAudio {
                audio_url: "data:audio/wav;base64,AA==".into(),
            },
        ]);
        let first = serde_json::to_value(ResponseItem::custom_output_payload(
            "call-code".into(),
            output.clone(),
        ))
        .expect("structured custom output should serialize");
        let retried = serde_json::to_value(ResponseItem::custom_output_payload(
            "call-code".into(),
            output,
        ))
        .expect("retried custom output should serialize");

        assert_eq!(first["id"], retried["id"]);
        assert_eq!(first["output"][0]["type"], "input_text");
        assert_eq!(first["output"][1]["type"], "input_image");
        assert_eq!(first["output"][2]["type"], "input_audio");
    }

    #[test]
    fn function_tool_output_can_return_text_and_image_content() {
        let value = serde_json::to_value(ResponseItem::function_output_with_image(
            "call-1".into(),
            Some("browser snapshot".into()),
            "data:image/jpeg;base64,AA==".into(),
            Some(ImageDetail::High),
        ))
        .expect("multimodal function output should serialize");

        assert_eq!(value["type"], "function_call_output");
        assert!(
            value["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("fco_"))
        );
        assert_eq!(value["call_id"], "call-1");
        assert_eq!(value["output"][0]["type"], "input_text");
        assert_eq!(value["output"][0]["text"], "browser snapshot");
        assert_eq!(value["output"][1]["type"], "input_image");
        assert_eq!(
            value["output"][1]["image_url"],
            "data:image/jpeg;base64,AA=="
        );
        assert_eq!(value["output"][1]["detail"], "high");
    }

    #[test]
    fn view_image_output_can_return_only_multimodal_image_content() {
        let value = serde_json::to_value(ResponseItem::function_output_with_image(
            "call-view-image".into(),
            None,
            "data:image/png;base64,AA==".into(),
            Some(ImageDetail::Original),
        ))
        .expect("image-only function output should serialize");

        assert_eq!(value["output"].as_array().map(Vec::len), Some(1));
        assert_eq!(value["output"][0]["type"], "input_image");
        assert_eq!(value["output"][0]["detail"], "original");
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
    fn classifies_stream_server_errors_as_transient() {
        let mut parser = SseParser::default();
        let mut events = VecDeque::new();
        let error = parser
            .push(
                br#"data: {"type":"response.failed","response":{"error":{"code":"server_error","message":"temporary failure"}}}

"#,
                &mut events,
            )
            .expect_err("server errors should retry outside the parser");

        assert!(matches!(
            &error,
            crate::error::AppError::ProviderTransient { .. }
        ));
        assert!(error.is_transient());
        assert!(events.is_empty());
    }

    #[test]
    fn preserves_server_overload_as_a_distinct_user_facing_condition() {
        let mut parser = SseParser::default();
        let mut events = VecDeque::new();
        let error = parser
            .push(
                br#"data: {"type":"response.failed","response":{"error":{"code":"server_is_overloaded","message":"high load"}}}

"#,
                &mut events,
            )
            .expect_err("server overload should end with a warning");

        assert!(matches!(
            &error,
            crate::error::AppError::ServerOverloaded { .. }
        ));
        assert!(!error.is_transient());
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
        let Some(ResponseEvent::Completed(completed)) = events.pop_front() else {
            panic!("completed usage event should be emitted");
        };
        let usage = completed
            .usage
            .expect("completed response should contain usage");

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

        let Some(ResponseEvent::Completed(completed)) = events.pop_front() else {
            panic!("completed response should be emitted");
        };
        assert_eq!(completed.response_id.as_deref(), Some("response-1"));
        assert!(completed.usage.is_none());
    }

    #[test]
    fn emits_current_response_metadata_as_typed_events() {
        let mut parser = SseParser::default();
        let mut events = VecDeque::new();
        parser
            .push(
                br#"data: {"type":"response.metadata","headers":{"OpenAI-Model":"gpt-fallback","x-models-etag":"catalog-v2","x-codex-turn-state":"route-1"},"metadata":{"openai_verification_recommendation":["trusted_access_for_cyber","trusted_access_for_cyber"],"openai_chatgpt_moderation_metadata":{"presentation":"inline"}}}

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
            Some(ResponseEvent::ModelsEtag(etag)) if etag == "catalog-v2"
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
        // Unknown metadata fields such as moderation metadata are ignored by the contract.
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
            &[],
            ResponseRequestSettings::default(),
        )
        .expect("request should build");
        let encoded = serde_json::to_value(request).expect("request should serialize");

        assert!(encoded.get("reasoning").is_none());
    }

    #[test]
    fn locally_generated_messages_keep_stable_prefixed_ids() {
        let first = ResponseItem::user_content_with_id(
            "client-message-1",
            vec![ResponseContent::InputText {
                text: "hello".into(),
            }],
        );
        let retried = ResponseItem::user_content_with_id(
            "client-message-1",
            vec![ResponseContent::InputText {
                text: "hello".into(),
            }],
        );
        let other = ResponseItem::user_content_with_id(
            "client-message-2",
            vec![ResponseContent::InputText {
                text: "hello".into(),
            }],
        );
        let context = ResponseItem::context_text("developer", "context".into(), "context.kind");
        let rebuilt_context =
            ResponseItem::context_text("developer", "context".into(), "context.kind");

        assert_eq!(first.id(), retried.id());
        assert_ne!(first.id(), other.id());
        assert_eq!(context.id(), rebuilt_context.id());
        for id in [first.id(), other.id(), context.id()] {
            assert!(id.is_some_and(|id| id.starts_with("msg_")));
        }
    }

    #[test]
    fn serializes_codex_reasoning_as_an_effort_without_a_mode() {
        let request = ResponseRequest::new(
            "gpt-5.6-sol",
            "Be useful.",
            &[],
            &[],
            &[],
            ResponseRequestSettings {
                reasoning_effort: Some(ReasoningEffort::XHigh),
                reasoning_summary: Some(ReasoningSummarySetting::Auto),
                ..ResponseRequestSettings::default()
            },
        )
        .expect("request should build");
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
            &[],
            ResponseRequestSettings::default(),
        )
        .expect("request should build");
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
            &[],
            ResponseRequestSettings {
                verbosity: Some(ModelVerbosity::Low),
                ..ResponseRequestSettings::default()
            },
        )
        .expect("request should build");
        let encoded = serde_json::to_value(request).expect("request should serialize");

        assert_eq!(encoded["text"]["verbosity"], "low");
    }

    #[test]
    fn compaction_uses_the_current_streaming_trigger() {
        let input = [ResponseItem::compaction_trigger()];
        let request = ResponseRequest::new(
            "gpt-test",
            "Be useful.",
            &[],
            &input,
            &[],
            ResponseRequestSettings::default(),
        )
        .expect("request should build");
        let encoded = serde_json::to_value(request).expect("request should serialize");

        assert_eq!(encoded["parallel_tool_calls"], false);
        assert_eq!(encoded["input"][0]["type"], "compaction_trigger");
        assert_eq!(encoded["stream"], true);
        assert_eq!(encoded["tool_choice"], "auto");
    }

    #[test]
    fn websocket_prewarm_disables_generation_and_retains_a_continuation_baseline() {
        let request = ResponseRequest::new(
            "gpt-test",
            "Be useful.",
            &[],
            &[],
            &[],
            ResponseRequestSettings {
                prompt_cache_key: Some("thread-1"),
                ..ResponseRequestSettings::default()
            },
        )
        .expect("prewarm request should build")
        .prepare_websocket_prewarm_request("thread-1", None)
        .expect("prewarm request should encode");
        let payload: serde_json::Value =
            serde_json::from_str(&request.payload).expect("prewarm payload should be JSON");

        assert_eq!(payload["type"], "response.create");
        assert_eq!(payload["generate"], false);
        assert_eq!(payload["input"].as_array().map(Vec::len), Some(0));
        assert!(payload.get("previous_response_id").is_none());
        assert!(request.baseline.is_some());
    }

    #[test]
    fn first_turn_continues_from_a_completed_startup_prewarm() {
        let settings = ResponseRequestSettings {
            prompt_cache_key: Some("thread-1"),
            ..ResponseRequestSettings::default()
        };
        let prewarm =
            ResponseRequest::new("gpt-test", "Be useful.", &[], &[], &[], settings.clone())
                .expect("prewarm request should build")
                .prepare_websocket_prewarm_request("thread-1", None)
                .expect("prewarm request should encode");
        let input = [ResponseItem::user_content(vec![
            ResponseContent::InputText {
                text: "Inspect the repository.".into(),
            },
        ])];
        let first_turn = ResponseRequest::new("gpt-test", "Be useful.", &[], &input, &[], settings)
            .expect("first-turn request should build")
            .prepare_websocket_request(
                prewarm.baseline,
                Some(super::CompletedWebSocketResponse {
                    response_id: "response-prewarm".into(),
                    output_items: Vec::new(),
                }),
                "thread-1",
                None,
            )
            .expect("first-turn request should continue from prewarm");
        let payload: serde_json::Value =
            serde_json::from_str(&first_turn.payload).expect("first-turn payload should be JSON");

        assert_eq!(payload["previous_response_id"], "response-prewarm");
        assert_eq!(payload["input"].as_array().map(Vec::len), Some(1));
        assert_eq!(payload["input"][0]["role"], "user");
    }

    #[test]
    fn websocket_compaction_sends_only_the_strict_input_extension() {
        let initial_history = [ResponseItem::user_content(vec![
            ResponseContent::InputText {
                text: "inspect the repository".into(),
            },
        ])];
        let initial = ResponseRequest::new(
            "gpt-test",
            "Be useful.",
            &[],
            &initial_history,
            &[],
            ResponseRequestSettings {
                prompt_cache_key: Some("thread-1"),
                ..ResponseRequestSettings::default()
            },
        )
        .expect("initial request should build")
        .prepare_websocket_request(None, None, "thread-1", None)
        .expect("initial websocket request should encode");
        let assistant_output = ResponseItem::Message {
            id: Some("message-1".into()),
            role: "assistant".into(),
            content: vec![ResponseContent::OutputText {
                text: "I will inspect it.".into(),
            }],
            phase: Some(ResponseMessagePhase::Commentary),
            internal_chat_message_metadata_passthrough: None,
        };
        let compaction_history = [initial_history[0].clone(), assistant_output.clone()];
        let compaction_trigger = [ResponseItem::compaction_trigger()];
        let compact = ResponseRequest::new_with_tail(
            "gpt-test",
            "Be useful.",
            &[],
            &compaction_history,
            &compaction_trigger,
            &[],
            ResponseRequestSettings {
                prompt_cache_key: Some("thread-1"),
                ..ResponseRequestSettings::default()
            },
        )
        .expect("compaction request should build")
        .prepare_websocket_compaction_request(
            Some(
                initial
                    .baseline
                    .expect("initial request should retain its baseline"),
            ),
            Some(super::CompletedWebSocketResponse {
                response_id: "response-1".into(),
                output_items: vec![assistant_output],
            }),
            "thread-1",
            Some("route-1"),
        )
        .expect("incremental websocket request should encode");
        let payload: serde_json::Value =
            serde_json::from_str(&compact.payload).expect("websocket payload should be JSON");

        assert_eq!(payload["type"], "response.create");
        assert_eq!(payload["previous_response_id"], "response-1");
        assert_eq!(payload["input"].as_array().map(Vec::len), Some(1));
        assert_eq!(payload["input"][0]["type"], "compaction_trigger");
        assert_eq!(payload["client_metadata"]["session_id"], "thread-1");
        assert_eq!(payload["client_metadata"]["x-codex-turn-state"], "route-1");
        assert!(compact.baseline.is_none());
    }

    #[test]
    fn websocket_continuation_resets_when_request_properties_change() {
        let history = [ResponseItem::user_content(vec![
            ResponseContent::InputText {
                text: "hello".into(),
            },
        ])];
        let initial = ResponseRequest::new(
            "gpt-a",
            "Be useful.",
            &[],
            &history,
            &[],
            ResponseRequestSettings::default(),
        )
        .expect("initial request should build")
        .prepare_websocket_request(None, None, "thread-1", None)
        .expect("initial websocket request should encode");
        let changed = ResponseRequest::new(
            "gpt-b",
            "Be useful.",
            &[],
            &history,
            &[],
            ResponseRequestSettings::default(),
        )
        .expect("changed request should build")
        .prepare_websocket_request(
            Some(
                initial
                    .baseline
                    .expect("initial request should retain its baseline"),
            ),
            Some(super::CompletedWebSocketResponse {
                response_id: "response-1".into(),
                output_items: Vec::new(),
            }),
            "thread-1",
            None,
        )
        .expect("changed websocket request should encode");
        let payload: serde_json::Value =
            serde_json::from_str(&changed.payload).expect("websocket payload should be JSON");

        assert!(payload.get("previous_response_id").is_none());
        assert_eq!(payload["input"].as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn websocket_continuation_ignores_only_internal_message_metadata() {
        let user = ResponseItem::user_content(vec![ResponseContent::InputText {
            text: "hello".into(),
        }]);
        let initial = ResponseRequest::new(
            "gpt-test",
            "Be useful.",
            &[],
            std::slice::from_ref(&user),
            &[],
            ResponseRequestSettings::default(),
        )
        .expect("initial request should build")
        .prepare_websocket_request(None, None, "thread-1", None)
        .expect("initial websocket request should encode");
        let provider_output = ResponseItem::Message {
            id: Some("message-1".into()),
            role: "assistant".into(),
            content: vec![ResponseContent::OutputText {
                text: "done".into(),
            }],
            phase: Some(ResponseMessagePhase::FinalAnswer),
            internal_chat_message_metadata_passthrough: None,
        };
        let persisted_output = ResponseItem::Message {
            id: Some("message-1".into()),
            role: "assistant".into(),
            content: vec![ResponseContent::OutputText {
                text: "done".into(),
            }],
            phase: Some(ResponseMessagePhase::FinalAnswer),
            internal_chat_message_metadata_passthrough: Some(
                super::InternalChatMessageMetadataPassthrough {
                    turn_id: Some("turn-1".into()),
                    content_item_kinds: None,
                },
            ),
        };
        let continued_history = [
            user,
            persisted_output,
            ResponseItem::function_output("call-1".into(), "result".into()),
        ];
        let continued = ResponseRequest::new(
            "gpt-test",
            "Be useful.",
            &[],
            &continued_history,
            &[],
            ResponseRequestSettings::default(),
        )
        .expect("continued request should build")
        .prepare_websocket_request(
            Some(
                initial
                    .baseline
                    .expect("initial request should retain its baseline"),
            ),
            Some(super::CompletedWebSocketResponse {
                response_id: "response-1".into(),
                output_items: vec![provider_output],
            }),
            "thread-1",
            None,
        )
        .expect("continued websocket request should encode");
        let payload: serde_json::Value =
            serde_json::from_str(&continued.payload).expect("payload should be JSON");

        assert_eq!(payload["previous_response_id"], "response-1");
        assert_eq!(payload["input"].as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn websocket_continuation_resets_when_any_prior_content_changes() {
        let original = ResponseItem::user_content(vec![ResponseContent::InputText {
            text: "original".into(),
        }]);
        let initial = ResponseRequest::new(
            "gpt-test",
            "Be useful.",
            &[],
            std::slice::from_ref(&original),
            &[],
            ResponseRequestSettings::default(),
        )
        .expect("initial request should build")
        .prepare_websocket_request(None, None, "thread-1", None)
        .expect("initial websocket request should encode");
        let changed = [ResponseItem::user_content(vec![
            ResponseContent::InputText {
                text: "changed".into(),
            },
        ])];
        let continued = ResponseRequest::new(
            "gpt-test",
            "Be useful.",
            &[],
            &changed,
            &[],
            ResponseRequestSettings::default(),
        )
        .expect("changed request should build")
        .prepare_websocket_request(
            Some(
                initial
                    .baseline
                    .expect("initial request should retain its baseline"),
            ),
            Some(super::CompletedWebSocketResponse {
                response_id: "response-1".into(),
                output_items: Vec::new(),
            }),
            "thread-1",
            None,
        )
        .expect("changed websocket request should encode");
        let payload: serde_json::Value =
            serde_json::from_str(&continued.payload).expect("payload should be JSON");

        assert!(payload.get("previous_response_id").is_none());
        assert_eq!(payload["input"][0]["content"][0]["text"], "changed");
    }

    #[test]
    #[ignore = "performance benchmark; run through `pnpm measure:response-transport`"]
    fn benchmark_incremental_compaction_payload() {
        use std::hint::black_box;
        use std::time::Instant;

        const HISTORY_BYTES: usize = 3 * 1_024 * 1_024;
        const SAMPLES: usize = 5;

        let initial_history = [ResponseItem::user_content(vec![
            ResponseContent::InputText {
                text: "x".repeat(HISTORY_BYTES),
            },
        ])];
        let initial_request = ResponseRequest::new(
            "gpt-benchmark",
            "Benchmark instructions",
            &[],
            &initial_history,
            &[],
            ResponseRequestSettings {
                prompt_cache_key: Some("benchmark-thread"),
                ..ResponseRequestSettings::default()
            },
        )
        .expect("initial benchmark request should build");
        let assistant_output = ResponseItem::Message {
            id: Some("benchmark-message".into()),
            role: "assistant".into(),
            content: vec![ResponseContent::OutputText {
                text: "done".into(),
            }],
            phase: Some(ResponseMessagePhase::FinalAnswer),
            internal_chat_message_metadata_passthrough: None,
        };
        let compaction_history = [initial_history[0].clone(), assistant_output.clone()];
        let compaction_trigger = [ResponseItem::compaction_trigger()];
        let compaction_request = ResponseRequest::new_with_tail(
            "gpt-benchmark",
            "Benchmark instructions",
            &[],
            &compaction_history,
            &compaction_trigger,
            &[],
            ResponseRequestSettings {
                prompt_cache_key: Some("benchmark-thread"),
                ..ResponseRequestSettings::default()
            },
        )
        .expect("compaction benchmark request should build");
        let full_started_at = Instant::now();
        let full = (0..SAMPLES)
            .map(|_| {
                black_box(
                    serde_json::to_string(&compaction_request)
                        .expect("full compaction payload should encode"),
                )
            })
            .collect::<Vec<_>>();
        let full_elapsed = full_started_at.elapsed();
        let full_payload_bytes = full[0].len();
        let baselines = (0..SAMPLES)
            .map(|_| {
                initial_request
                    .prepare_websocket_request(None, None, "benchmark-thread", None)
                    .expect("benchmark baseline should encode")
                    .baseline
                    .expect("initial request should retain its baseline")
            })
            .collect::<Vec<_>>();

        let incremental_started_at = Instant::now();
        let incremental = baselines
            .into_iter()
            .map(|baseline| {
                black_box(
                    compaction_request
                        .prepare_websocket_compaction_request(
                            Some(baseline),
                            Some(super::CompletedWebSocketResponse {
                                response_id: "benchmark-response".into(),
                                output_items: vec![assistant_output.clone()],
                            }),
                            "benchmark-thread",
                            None,
                        )
                        .expect("incremental benchmark payload should encode"),
                )
            })
            .collect::<Vec<_>>();
        let incremental_elapsed = incremental_started_at.elapsed();
        let incremental_payload_bytes = incremental[0].payload.len();
        let reduction = 1.0 - incremental_payload_bytes as f64 / full_payload_bytes as f64;

        assert!(
            incremental
                .iter()
                .all(|sample| sample.payload.contains("\"previous_response_id\""))
        );
        assert!(incremental.iter().all(|sample| sample.baseline.is_none()));
        assert!(reduction > 0.999);
        let encoding_speedup =
            full_elapsed.as_secs_f64() / incremental_elapsed.as_secs_f64().max(f64::EPSILON);
        println!(
            "incremental_compaction history_mib={:.3} full_payload_bytes={full_payload_bytes} incremental_payload_bytes={incremental_payload_bytes} payload_reduction_percent={:.5} samples={SAMPLES} full_total_ms={:.3} full_per_request_ms={:.3} incremental_total_ms={:.3} incremental_per_request_ms={:.3} encoding_speedup={encoding_speedup:.3}x",
            HISTORY_BYTES as f64 / (1_024.0 * 1_024.0),
            reduction * 100.0,
            full_elapsed.as_secs_f64() * 1_000.0,
            full_elapsed.as_secs_f64() * 1_000.0 / SAMPLES as f64,
            incremental_elapsed.as_secs_f64() * 1_000.0,
            incremental_elapsed.as_secs_f64() * 1_000.0 / SAMPLES as f64,
        );
    }

    #[test]
    fn responses_lite_moves_tools_and_base_instructions_into_stable_prefix_items() {
        let tools = [serde_json::json!({
            "type": "function",
            "name": "read_file",
            "parameters": {"type": "object"}
        })];
        let context = [ResponseItem::context_text(
            "user",
            "<environment_context />".into(),
            "environments.environment_context",
        )];
        let history = [ResponseItem::user_content(vec![
            ResponseContent::InputImage {
                image_url: "data:image/png;base64,AA==".into(),
                detail: Some(ImageDetail::High),
            },
        ])];
        let settings = ResponseRequestSettings {
            protocol: ResponseProtocol::Lite,
            parallel_tool_calls: true,
            reasoning_effort: Some(ReasoningEffort::Ultra),
            reasoning_summary: Some(ReasoningSummarySetting::Auto),
            prompt_cache_key: Some("thread-1"),
            ..ResponseRequestSettings::default()
        };
        let first = ResponseRequest::new(
            "gpt-5.6-sol",
            "Base instructions",
            &context,
            &history,
            &tools,
            settings.clone(),
        )
        .expect("Lite request should build");
        let second = ResponseRequest::new(
            "gpt-5.6-sol",
            "Base instructions",
            &context,
            &history,
            &tools,
            settings.clone(),
        )
        .expect("repeated Lite request should build");
        let changed_instructions = ResponseRequest::new(
            "gpt-5.6-sol",
            "Updated base instructions",
            &context,
            &history,
            &tools,
            settings.clone(),
        )
        .expect("updated Lite instructions should build");
        let changed_tools = [serde_json::json!({
            "type": "function",
            "name": "read_file",
            "description": "Read one file",
            "parameters": {"type": "object"}
        })];
        let changed_tool_request = ResponseRequest::new(
            "gpt-5.6-sol",
            "Base instructions",
            &context,
            &history,
            &changed_tools,
            settings.clone(),
        )
        .expect("updated Lite tools should build");
        let independent_thread = ResponseRequest::new(
            "gpt-5.6-sol",
            "Base instructions",
            &context,
            &history,
            &tools,
            ResponseRequestSettings {
                prompt_cache_key: Some("thread-2"),
                ..settings
            },
        )
        .expect("Lite request for an independent thread should build");
        let first = serde_json::to_value(first).expect("Lite request should serialize");
        let second = serde_json::to_value(second).expect("Lite request should serialize");
        let changed_instructions = serde_json::to_value(changed_instructions)
            .expect("updated Lite instructions should serialize");
        let changed_tool_request = serde_json::to_value(changed_tool_request)
            .expect("updated Lite tools should serialize");
        let independent_thread = serde_json::to_value(independent_thread)
            .expect("independent Lite request should serialize");

        assert!(first.get("instructions").is_none());
        assert!(first.get("tools").is_none());
        assert_eq!(first["parallel_tool_calls"], false);
        assert_eq!(first["reasoning"]["context"], "all_turns");
        assert_eq!(first["reasoning"]["summary"], "auto");
        assert_eq!(first["input"][0]["type"], "additional_tools");
        assert_eq!(first["input"][0]["role"], "developer");
        assert_eq!(first["input"][0]["tools"][0]["type"], "namespace");
        assert_eq!(first["input"][0]["tools"][0]["name"], "functions");
        assert_eq!(first["input"][0]["tools"][0]["description"], "");
        assert_eq!(
            first["input"][0]["tools"][0]["tools"],
            serde_json::json!(tools)
        );
        assert_eq!(first["input"][1]["type"], "message");
        assert_eq!(first["input"][1]["role"], "developer");
        assert_eq!(first["input"][1]["content"][0]["text"], "Base instructions");
        assert_eq!(
            first["input"][1]["internal_chat_message_metadata_passthrough"]["content_item_kinds"]
                [0],
            "model.base_instructions"
        );
        assert_eq!(
            first["input"][2]["internal_chat_message_metadata_passthrough"]["content_item_kinds"]
                [0],
            "environments.environment_context"
        );
        assert!(first["input"][3]["content"][0].get("detail").is_none());
        assert_eq!(first["input"][0]["id"], second["input"][0]["id"]);
        assert_eq!(first["input"][1]["id"], second["input"][1]["id"]);
        assert!(
            first["input"][0]["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("at_"))
        );
        assert!(
            first["input"][1]["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("msg_"))
        );
        assert_eq!(
            changed_instructions["input"][0]["id"],
            first["input"][0]["id"]
        );
        assert_ne!(
            changed_instructions["input"][1]["id"],
            first["input"][1]["id"]
        );
        assert_ne!(
            changed_tool_request["input"][0]["id"],
            first["input"][0]["id"]
        );
        assert_eq!(
            changed_tool_request["input"][1]["id"],
            first["input"][1]["id"]
        );
        assert_ne!(
            independent_thread["input"][0]["id"],
            first["input"][0]["id"]
        );
        assert_ne!(
            independent_thread["input"][1]["id"],
            first["input"][1]["id"]
        );
    }

    #[test]
    fn standard_responses_keep_top_level_contract_and_image_detail() {
        let tools = [serde_json::json!({"type": "web_search"})];
        let history = [ResponseItem::user_content(vec![
            ResponseContent::InputImage {
                image_url: "data:image/png;base64,AA==".into(),
                detail: Some(ImageDetail::High),
            },
        ])];
        let request = ResponseRequest::new(
            "gpt-standard",
            "Base instructions",
            &[],
            &history,
            &tools,
            ResponseRequestSettings {
                protocol: ResponseProtocol::Standard,
                parallel_tool_calls: true,
                prompt_cache_key: Some("thread-1"),
                ..ResponseRequestSettings::default()
            },
        )
        .expect("standard request should build");
        let encoded = serde_json::to_value(request).expect("request should serialize");

        assert_eq!(encoded["instructions"], "Base instructions");
        assert_eq!(encoded["tools"], serde_json::json!(tools));
        assert_eq!(encoded["parallel_tool_calls"], true);
        assert_eq!(encoded["input"][0]["content"][0]["detail"], "high");
        assert!(encoded.get("reasoning").is_none());
    }

    #[test]
    fn responses_lite_rejects_an_unstable_request_identity() {
        let error = ResponseRequest::new(
            "gpt-lite",
            "Base instructions",
            &[],
            &[],
            &[],
            ResponseRequestSettings {
                protocol: ResponseProtocol::Lite,
                ..ResponseRequestSettings::default()
            },
        )
        .expect_err("Lite requests require a cache identity");

        assert!(error.to_string().contains("stable prompt cache key"));
    }

    #[test]
    fn responses_lite_rejects_hosted_tools_before_sending_a_request() {
        let tools = [serde_json::json!({"type": "web_search"})];
        let error = ResponseRequest::new(
            "gpt-lite",
            "Base instructions",
            &[],
            &[],
            &tools,
            ResponseRequestSettings {
                protocol: ResponseProtocol::Lite,
                prompt_cache_key: Some("thread-1"),
                ..ResponseRequestSettings::default()
            },
        )
        .expect_err("Lite requests must reject hosted tools");

        assert!(error.to_string().contains("hosted `web_search`"));
    }

    #[test]
    fn responses_lite_rejects_tools_the_local_runtime_cannot_execute() {
        for (tool, expected) in [
            (
                serde_json::json!({
                    "type": "namespace",
                    "name": "remote",
                    "description": "Unavailable remote tools",
                    "tools": []
                }),
                "unexecutable `remote` tool namespace",
            ),
            (
                serde_json::json!({
                    "type": "tool_search",
                    "execution": "client"
                }),
                "without a local namespace loader",
            ),
        ] {
            let error = ResponseRequest::new(
                "gpt-lite",
                "Base instructions",
                &[],
                &[],
                &[tool],
                ResponseRequestSettings {
                    protocol: ResponseProtocol::Lite,
                    prompt_cache_key: Some("thread-1"),
                    ..ResponseRequestSettings::default()
                },
            )
            .expect_err("unexecutable Lite tools must be rejected before transport");

            assert!(error.to_string().contains(expected));
        }
    }

    #[test]
    fn function_call_namespace_survives_provider_history_round_trips() {
        let item: ResponseItem = serde_json::from_str(
            r#"{"type":"function_call","id":"item-1","namespace":"functions","name":"read_file","arguments":"{}","call_id":"call-1"}"#,
        )
        .expect("namespaced function call should decode");
        let encoded = serde_json::to_value(&item).expect("function call should serialize");

        assert_eq!(encoded["namespace"], DEFAULT_FUNCTION_NAMESPACE);
        assert!(matches!(
            item,
            ResponseItem::FunctionCall {
                namespace: Some(namespace),
                ..
            } if namespace == DEFAULT_FUNCTION_NAMESPACE
        ));
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
