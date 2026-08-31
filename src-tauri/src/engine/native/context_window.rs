use std::collections::VecDeque;
use std::io::{self, Cursor, Write};
use std::sync::LazyLock;

use base64::{Engine as _, prelude::BASE64_STANDARD};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest as _, Sha256};

#[cfg(test)]
use super::provider::FunctionCallOutputPayload;
use super::provider::{FunctionCallOutputContent, ResponseContent, ResponseItem};
use super::text::truncate_utf8;
use crate::engine::{ImageDetail, ModelContextWindow, TokenUsage};

#[derive(Debug, Clone)]
pub(super) struct ContextUsageSnapshot {
    pub model: String,
    pub usage: TokenUsage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ContextWindowStatus {
    pub active_tokens: u64,
    pub should_compact: bool,
}

const BYTES_PER_TOKEN: u64 = 4;
const REQUEST_ESTIMATE_HEADROOM_PERCENT: u64 = 112;
const ENCRYPTED_PAYLOAD_OVERHEAD_BYTES: u64 = 650;
const RESIZED_IMAGE_BYTES_ESTIMATE: u64 = 7_373;
const RESIZED_IMAGE_TOKEN_ESTIMATE: u64 = RESIZED_IMAGE_BYTES_ESTIMATE.div_ceil(BYTES_PER_TOKEN);
const ORIGINAL_IMAGE_PATCH_SIZE: u64 = 32;
const ORIGINAL_IMAGE_MAX_PATCHES: u64 = 10_000;
const ORIGINAL_IMAGE_ESTIMATE_CACHE_SIZE: usize = 32;
const RETAINED_MESSAGE_TOKEN_BUDGET: usize = 64_000;
const COMPACTION_OUTPUT_TRUNCATION: &str =
    "Output exceeded the available model context and was truncated";
const MESSAGE_TRUNCATION_MARKER: &str = "\n[message truncated for context compaction]";

#[derive(Clone, Copy)]
struct OriginalImageEstimate {
    key: [u8; 32],
    tokens: Option<u64>,
}

static ORIGINAL_IMAGE_ESTIMATE_CACHE: LazyLock<Mutex<VecDeque<OriginalImageEstimate>>> =
    LazyLock::new(|| Mutex::new(VecDeque::with_capacity(ORIGINAL_IMAGE_ESTIMATE_CACHE_SIZE)));

pub(super) struct ContextWindowEvaluation<'a> {
    pub model_id: &'a str,
    pub base_instructions: &'a str,
    pub prompt_context: &'a [ResponseItem],
    pub history: &'a [ResponseItem],
    pub tools: &'a [Value],
    pub snapshot: Option<&'a ContextUsageSnapshot>,
    pub auto_compact_limit: Option<u64>,
    pub context_window: Option<&'a ModelContextWindow>,
}

pub(super) fn evaluate_context_window(
    evaluation: ContextWindowEvaluation<'_>,
) -> ContextWindowStatus {
    let estimated_request = add_request_estimate_headroom(estimate_request_tokens(
        evaluation.base_instructions,
        evaluation.prompt_context,
        evaluation.history,
        evaluation.tools,
    ));
    let measured_with_local_delta = evaluation
        .snapshot
        .filter(|snapshot| snapshot.model == evaluation.model_id)
        .map(|snapshot| {
            let local_tokens = evaluation
                .history
                .iter()
                .rposition(is_model_generated_item)
                .map(|last_model_item| {
                    evaluation.history[last_model_item.saturating_add(1)..]
                        .iter()
                        .map(estimate_item_tokens)
                        .fold(0, u64::saturating_add)
                })
                .unwrap_or_default();
            snapshot.usage.total_tokens.saturating_add(local_tokens)
        });
    let active_tokens = measured_with_local_delta.unwrap_or(estimated_request);
    let should_compact = evaluation
        .auto_compact_limit
        .is_some_and(|limit| active_tokens >= limit)
        || evaluation
            .context_window
            .is_some_and(|window| active_tokens >= window.usable_tokens);

    ContextWindowStatus {
        active_tokens,
        should_compact,
    }
}

pub(super) fn full_context_usage(window: &ModelContextWindow) -> TokenUsage {
    TokenUsage {
        input_tokens: window.tokens,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: window.tokens,
    }
}

pub(super) fn prepare_compaction_history(
    base_instructions: &str,
    prompt_context: &[ResponseItem],
    history: &[ResponseItem],
    tools: &[Value],
    hard_limit: Option<u64>,
) -> Vec<ResponseItem> {
    let mut prepared = history.to_vec();
    let Some(hard_limit) = hard_limit else {
        return prepared;
    };
    let mut estimated_tokens =
        estimate_request_tokens(base_instructions, prompt_context, &prepared, tools)
            .saturating_add(estimate_item_tokens(&ResponseItem::compaction_trigger()));

    for index in (0..prepared.len()).rev() {
        if add_request_estimate_headroom(estimated_tokens) <= hard_limit {
            break;
        }
        let replacement = match &prepared[index] {
            ResponseItem::FunctionCallOutput { call_id, .. } => {
                ResponseItem::function_output(call_id.clone(), COMPACTION_OUTPUT_TRUNCATION.into())
            }
            ResponseItem::CustomToolCallOutput { call_id, .. } => {
                ResponseItem::custom_output(call_id.clone(), COMPACTION_OUTPUT_TRUNCATION.into())
            }
            _ => continue,
        };
        estimated_tokens = estimated_tokens
            .saturating_sub(estimate_item_tokens(&prepared[index]))
            .saturating_add(estimate_item_tokens(&replacement));
        prepared[index] = replacement;
    }

    prepared
}

pub(super) fn build_compacted_history(
    prompt_input: &[ResponseItem],
    checkpoint: ResponseItem,
) -> Vec<ResponseItem> {
    let mut remaining_tokens = RETAINED_MESSAGE_TOKEN_BUDGET;
    let mut retained_reversed = Vec::new();
    for item in prompt_input.iter().rev() {
        if remaining_tokens == 0 {
            break;
        }
        if !matches!(item, ResponseItem::Message { role, .. } if role == "user") {
            continue;
        }
        let token_count = message_content_token_count(item).max(1);
        if token_count <= remaining_tokens {
            retained_reversed.push(item.clone());
            remaining_tokens = remaining_tokens.saturating_sub(token_count);
        } else {
            if let Some(truncated) = truncate_message_to_token_budget(item, remaining_tokens) {
                retained_reversed.push(truncated);
            }
            remaining_tokens = 0;
        }
    }
    retained_reversed.reverse();
    retained_reversed.push(checkpoint);
    retained_reversed
}

fn estimate_request_tokens(
    base_instructions: &str,
    prompt_context: &[ResponseItem],
    history: &[ResponseItem],
    tools: &[Value],
) -> u64 {
    estimate_text_tokens(base_instructions)
        .saturating_add(
            prompt_context
                .iter()
                .map(estimate_item_tokens)
                .fold(0, u64::saturating_add),
        )
        .saturating_add(
            history
                .iter()
                .map(estimate_item_tokens)
                .fold(0, u64::saturating_add),
        )
        .saturating_add(estimate_json_tokens(tools))
}

fn estimate_item_tokens(item: &ResponseItem) -> u64 {
    match item {
        ResponseItem::Reasoning {
            encrypted_content: Some(content),
            ..
        }
        | ResponseItem::Compaction {
            encrypted_content: content,
            ..
        } => bytes_to_tokens(estimate_encrypted_payload_bytes(content.len())),
        _ => {
            let serialized_bytes = serialized_json_len(item);
            let (image_payload_bytes, image_estimate_bytes) = image_estimate_adjustment(item);
            bytes_to_tokens(
                serialized_bytes
                    .saturating_sub(image_payload_bytes)
                    .saturating_add(image_estimate_bytes),
            )
        }
    }
}

fn estimate_json_tokens<T>(value: &T) -> u64
where
    T: Serialize + ?Sized,
{
    bytes_to_tokens(serialized_json_len(value))
}

fn serialized_json_len<T>(value: &T) -> u64
where
    T: Serialize + ?Sized,
{
    let mut counter = SerializedByteCounter::default();
    serde_json::to_writer(&mut counter, value)
        .map(|()| counter.bytes)
        .unwrap_or(u64::MAX)
}

#[derive(Default)]
struct SerializedByteCounter {
    bytes: u64,
}

impl Write for SerializedByteCounter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.bytes = self.bytes.saturating_add(usize_to_u64(buffer.len()));
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn estimate_text_tokens(value: &str) -> u64 {
    bytes_to_tokens(usize_to_u64(value.len()))
}

fn add_request_estimate_headroom(tokens: u64) -> u64 {
    tokens
        .saturating_mul(REQUEST_ESTIMATE_HEADROOM_PERCENT)
        .div_ceil(100)
}

fn message_content_token_count(item: &ResponseItem) -> usize {
    let ResponseItem::Message { content, .. } = item else {
        return 0;
    };
    content
        .iter()
        .map(|part| match part {
            ResponseContent::InputText { text } | ResponseContent::OutputText { text } => {
                text.len().div_ceil(BYTES_PER_TOKEN as usize)
            }
            ResponseContent::Refusal { refusal } => {
                refusal.len().div_ceil(BYTES_PER_TOKEN as usize)
            }
            ResponseContent::InputImage { image_url, detail } => {
                usize::try_from(estimate_image_tokens(image_url, *detail)).unwrap_or(usize::MAX)
            }
        })
        .fold(0, usize::saturating_add)
}

fn truncate_message_to_token_budget(
    item: &ResponseItem,
    maximum_tokens: usize,
) -> Option<ResponseItem> {
    let ResponseItem::Message {
        id,
        role,
        content,
        phase,
        internal_chat_message_metadata_passthrough,
    } = item
    else {
        return None;
    };
    let mut remaining_tokens = maximum_tokens;
    let mut retained_reversed = Vec::with_capacity(content.len());
    for (index, part) in content.iter().enumerate().rev() {
        match part {
            ResponseContent::InputText { text } => {
                if let Some(text) = retain_text_within_budget(text, &mut remaining_tokens) {
                    retained_reversed.push((index, ResponseContent::InputText { text }));
                }
            }
            ResponseContent::OutputText { text } => {
                if let Some(text) = retain_text_within_budget(text, &mut remaining_tokens) {
                    retained_reversed.push((index, ResponseContent::OutputText { text }));
                }
            }
            ResponseContent::Refusal { refusal } => {
                if let Some(refusal) = retain_text_within_budget(refusal, &mut remaining_tokens) {
                    retained_reversed.push((index, ResponseContent::Refusal { refusal }));
                }
            }
            ResponseContent::InputImage { image_url, detail } => {
                let token_count = usize::try_from(estimate_image_tokens(image_url, *detail))
                    .unwrap_or(usize::MAX);
                if token_count <= remaining_tokens {
                    remaining_tokens = remaining_tokens.saturating_sub(token_count);
                    retained_reversed.push((
                        index,
                        ResponseContent::InputImage {
                            image_url: image_url.clone(),
                            detail: *detail,
                        },
                    ));
                } else {
                    // Images are atomic. Once a boundary image does not fit, do not
                    // backfill its budget with older content.
                    remaining_tokens = 0;
                }
            }
        }
    }
    if retained_reversed.is_empty() {
        return None;
    }
    retained_reversed.reverse();
    let retained_indices = retained_reversed
        .iter()
        .map(|(index, _)| *index)
        .collect::<Vec<_>>();
    let retained_content = retained_reversed
        .into_iter()
        .map(|(_, part)| part)
        .collect();
    let retained_metadata = internal_chat_message_metadata_passthrough
        .as_ref()
        .and_then(|metadata| metadata.retaining_content_indices(content.len(), &retained_indices));
    Some(ResponseItem::Message {
        id: id.clone(),
        role: role.clone(),
        content: retained_content,
        phase: *phase,
        internal_chat_message_metadata_passthrough: retained_metadata,
    })
}

fn retain_text_within_budget(text: &str, remaining_tokens: &mut usize) -> Option<String> {
    if *remaining_tokens == 0 {
        return None;
    }
    let token_count = text.len().div_ceil(BYTES_PER_TOKEN as usize);
    if token_count <= *remaining_tokens {
        *remaining_tokens = remaining_tokens.saturating_sub(token_count);
        return Some(text.to_string());
    }

    let maximum_bytes = remaining_tokens.saturating_mul(BYTES_PER_TOKEN as usize);
    let truncated = truncate_text_to_bytes(text, maximum_bytes);
    *remaining_tokens = 0;
    (!truncated.is_empty()).then_some(truncated)
}

fn truncate_text_to_bytes(text: &str, maximum_bytes: usize) -> String {
    if text.len() <= maximum_bytes {
        return text.to_string();
    }
    if maximum_bytes == 0 {
        return String::new();
    }
    if maximum_bytes <= MESSAGE_TRUNCATION_MARKER.len() {
        return truncate_utf8(text, maximum_bytes);
    }
    let prefix_bytes = maximum_bytes.saturating_sub(MESSAGE_TRUNCATION_MARKER.len());
    let mut output = truncate_utf8(text, prefix_bytes);
    output.push_str(MESSAGE_TRUNCATION_MARKER);
    output
}

fn bytes_to_tokens(bytes: u64) -> u64 {
    bytes.div_ceil(BYTES_PER_TOKEN)
}

fn estimate_encrypted_payload_bytes(encoded_len: usize) -> u64 {
    usize_to_u64(encoded_len)
        .saturating_mul(3)
        .checked_div(4)
        .unwrap_or_default()
        .saturating_sub(ENCRYPTED_PAYLOAD_OVERHEAD_BYTES)
}

fn image_estimate_adjustment(item: &ResponseItem) -> (u64, u64) {
    let mut adjustment = (0_u64, 0_u64);
    let mut add_image = |image_url: &str, detail: Option<ImageDetail>| {
        if let Some(payload) = inline_image_payload_len(image_url) {
            adjustment.0 = adjustment.0.saturating_add(payload);
            adjustment.1 = adjustment.1.saturating_add(
                estimate_image_tokens(image_url, detail).saturating_mul(BYTES_PER_TOKEN),
            );
        }
    };
    match item {
        ResponseItem::Message { content, .. } => {
            for part in content {
                if let ResponseContent::InputImage { image_url, detail } = part {
                    add_image(image_url, *detail);
                }
            }
        }
        ResponseItem::FunctionCallOutput { output, .. } => {
            if let Some(content) = output.content() {
                for part in content {
                    if let FunctionCallOutputContent::InputImage { image_url, detail } = part {
                        add_image(image_url, *detail);
                    }
                }
            }
        }
        _ => {}
    }
    adjustment
}

fn inline_image_payload_len(image_url: &str) -> Option<u64> {
    inline_image_payload(image_url).map(|payload| usize_to_u64(payload.len()))
}

fn inline_image_payload(image_url: &str) -> Option<&str> {
    let (prefix, payload) = image_url.split_once(',')?;
    let prefix = prefix.to_ascii_lowercase();
    if !prefix.starts_with("data:image/") || !prefix.ends_with(";base64") {
        return None;
    }
    Some(payload)
}

fn estimate_image_tokens(image_url: &str, detail: Option<ImageDetail>) -> u64 {
    match detail {
        Some(ImageDetail::Original) => {
            estimate_original_image_tokens(image_url).unwrap_or(RESIZED_IMAGE_TOKEN_ESTIMATE)
        }
        _ => RESIZED_IMAGE_TOKEN_ESTIMATE,
    }
}

fn estimate_original_image_tokens(image_url: &str) -> Option<u64> {
    let key: [u8; 32] = Sha256::digest(image_url.as_bytes()).into();
    {
        let mut cache = ORIGINAL_IMAGE_ESTIMATE_CACHE.lock();
        if let Some(index) = cache.iter().position(|candidate| candidate.key == key) {
            let entry = cache.remove(index)?;
            let estimate = entry.tokens;
            cache.push_front(entry);
            return estimate;
        }
    }

    let estimate = decode_original_image_tokens(image_url);
    let mut cache = ORIGINAL_IMAGE_ESTIMATE_CACHE.lock();
    cache.push_front(OriginalImageEstimate {
        key,
        tokens: estimate,
    });
    cache.truncate(ORIGINAL_IMAGE_ESTIMATE_CACHE_SIZE);
    estimate
}

fn decode_original_image_tokens(image_url: &str) -> Option<u64> {
    let payload = inline_image_payload(image_url)?;
    let bytes = BASE64_STANDARD.decode(payload).ok()?;
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let (width, height) = reader.into_dimensions().ok()?;
    let patches_wide = u64::from(width).div_ceil(ORIGINAL_IMAGE_PATCH_SIZE);
    let patches_high = u64::from(height).div_ceil(ORIGINAL_IMAGE_PATCH_SIZE);
    Some(
        patches_wide
            .saturating_mul(patches_high)
            .min(ORIGINAL_IMAGE_MAX_PATCHES),
    )
}

fn is_model_generated_item(item: &ResponseItem) -> bool {
    match item {
        ResponseItem::Message { role, .. } => role == "assistant",
        ResponseItem::Reasoning { .. }
        | ResponseItem::FunctionCall { .. }
        | ResponseItem::CustomToolCall { .. }
        | ResponseItem::WebSearchCall { .. }
        | ResponseItem::Compaction { .. } => true,
        ResponseItem::FunctionCallOutput { .. }
        | ResponseItem::CustomToolCallOutput { .. }
        | ResponseItem::CompactionTrigger { .. } => false,
    }
}

fn usize_to_u64(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(role: &str, value: &str) -> ResponseItem {
        ResponseItem::Message {
            id: None,
            role: role.into(),
            content: vec![ResponseContent::InputText { text: value.into() }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }
    }

    fn usage(total_tokens: u64) -> TokenUsage {
        TokenUsage {
            input_tokens: total_tokens,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens,
        }
    }

    #[test]
    fn adds_local_items_after_the_last_model_item() {
        let history = vec![text("assistant", "done"), text("user", &"x".repeat(400))];
        let snapshot = ContextUsageSnapshot {
            model: "gpt-test".into(),
            usage: usage(900),
        };
        let status = evaluate_context_window(ContextWindowEvaluation {
            model_id: "gpt-test",
            base_instructions: "",
            prompt_context: &[],
            history: &history,
            tools: &[],
            snapshot: Some(&snapshot),
            auto_compact_limit: Some(1_000),
            context_window: None,
        });

        assert!(status.active_tokens >= 1_000);
        assert!(status.should_compact);
    }

    #[test]
    fn provider_measurement_remains_authoritative_after_a_completed_response() {
        let history = vec![text("assistant", "done")];
        let snapshot = ContextUsageSnapshot {
            model: "gpt-test".into(),
            usage: usage(10),
        };
        let status = evaluate_context_window(ContextWindowEvaluation {
            model_id: "gpt-test",
            base_instructions: &"i".repeat(4_000),
            prompt_context: &[],
            history: &history,
            tools: &[],
            snapshot: Some(&snapshot),
            auto_compact_limit: Some(900),
            context_window: None,
        });

        assert_eq!(status.active_tokens, 10);
        assert!(!status.should_compact);
    }

    #[test]
    fn provider_measurement_prevents_premature_compaction_from_a_larger_request_estimate() {
        let history = vec![text("assistant", "done")];
        let snapshot = ContextUsageSnapshot {
            model: "gpt-5.6-sol".into(),
            usage: usage(200_340),
        };
        let status = evaluate_context_window(ContextWindowEvaluation {
            model_id: "gpt-5.6-sol",
            base_instructions: &"i".repeat(900_000),
            prompt_context: &[],
            history: &history,
            tools: &[],
            snapshot: Some(&snapshot),
            auto_compact_limit: Some(244_800),
            context_window: None,
        });

        assert_eq!(status.active_tokens, 200_340);
        assert!(!status.should_compact);
    }

    #[test]
    fn incompatible_model_uses_the_current_request_only() {
        let snapshot = ContextUsageSnapshot {
            model: "gpt-large".into(),
            usage: usage(900_000),
        };
        let status = evaluate_context_window(ContextWindowEvaluation {
            model_id: "gpt-small",
            base_instructions: "short",
            prompt_context: &[],
            history: &[text("user", "hello")],
            tools: &[],
            snapshot: Some(&snapshot),
            auto_compact_limit: Some(1_000),
            context_window: None,
        });

        assert!(!status.should_compact);
    }

    #[test]
    fn either_available_limit_can_trigger_compaction() {
        let window = ModelContextWindow {
            tokens: 2_000,
            usable_tokens: 100,
            usable_percent: 95,
            maximum_tokens: None,
        };
        let status = evaluate_context_window(ContextWindowEvaluation {
            model_id: "gpt-test",
            base_instructions: &"x".repeat(400),
            prompt_context: &[],
            history: &[],
            tools: &[],
            snapshot: None,
            auto_compact_limit: Some(10_000),
            context_window: Some(&window),
        });

        assert!(status.should_compact);
    }

    #[test]
    fn function_output_after_the_last_model_item_is_counted() {
        let history = vec![
            ResponseItem::FunctionCall {
                id: Some("call-item-1".into()),
                namespace: None,
                name: "read".into(),
                arguments: "{}".into(),
                call_id: "call-1".into(),
            },
            ResponseItem::function_output("call-1".into(), "x".repeat(400)),
        ];
        let snapshot = ContextUsageSnapshot {
            model: "gpt-test".into(),
            usage: usage(900),
        };
        let status = evaluate_context_window(ContextWindowEvaluation {
            model_id: "gpt-test",
            base_instructions: "",
            prompt_context: &[],
            history: &history,
            tools: &[],
            snapshot: Some(&snapshot),
            auto_compact_limit: Some(1_000),
            context_window: None,
        });

        assert!(status.should_compact);
    }

    #[test]
    fn inline_image_uses_a_fixed_estimate_instead_of_base64_size() {
        let item = ResponseItem::user_content(vec![ResponseContent::InputImage {
            image_url: format!("data:image/png;base64,{}", "a".repeat(400_000)),
            detail: None,
        }]);
        let estimate = estimate_item_tokens(&item);

        assert!(estimate >= RESIZED_IMAGE_TOKEN_ESTIMATE);
        assert!(estimate < 2_000);
    }

    #[test]
    fn function_output_image_uses_the_same_fixed_estimate() {
        let item = ResponseItem::function_output_with_image(
            "call-1".into(),
            Some("browser snapshot".into()),
            format!("data:image/jpeg;base64,{}", "a".repeat(400_000)),
            None,
        );
        let estimate = estimate_item_tokens(&item);

        assert!(estimate >= RESIZED_IMAGE_TOKEN_ESTIMATE);
        assert!(estimate < 2_100);
    }

    #[test]
    fn original_image_detail_uses_the_bounded_patch_count() {
        let image = image::DynamicImage::new_rgb8(64, 32);
        let mut bytes = Cursor::new(Vec::new());
        image
            .write_to(&mut bytes, image::ImageFormat::Png)
            .expect("test image should encode");
        let image_url = format!(
            "data:image/png;base64,{}",
            BASE64_STANDARD.encode(bytes.into_inner())
        );

        assert_eq!(
            estimate_image_tokens(&image_url, Some(ImageDetail::Original)),
            2
        );
    }

    #[test]
    fn encrypted_checkpoint_has_a_bounded_visible_estimate() {
        let item = ResponseItem::Compaction {
            id: Some("compact-1".into()),
            encrypted_content: "x".repeat(4_000),
            internal_chat_message_metadata_passthrough: None,
        };

        assert_eq!(estimate_item_tokens(&item), (3_000_u64 - 650).div_ceil(4));
    }

    #[test]
    fn rewrites_tool_outputs_when_compaction_needs_headroom() {
        let history = vec![
            text("user", "keep"),
            ResponseItem::function_output("call-1".into(), "x".repeat(4_000)),
        ];
        let prepared = prepare_compaction_history("", &[], &history, &[], Some(200));

        assert!(matches!(
            prepared.last(),
            Some(ResponseItem::FunctionCallOutput { output, .. })
                if matches!(
                    output,
                    FunctionCallOutputPayload::Text(text)
                        if text == "Output exceeded the available model context and was truncated"
                )
        ));
        assert_ne!(
            serde_json::to_string(&history).expect("original history should encode"),
            serde_json::to_string(&prepared).expect("prepared history should encode")
        );
    }

    #[test]
    fn rewrites_older_tool_outputs_past_non_output_items() {
        let history = vec![
            ResponseItem::function_output("call-1".into(), "x".repeat(4_000)),
            text("user", "newest"),
        ];
        let prepared = prepare_compaction_history("", &[], &history, &[], Some(200));

        assert!(matches!(
            prepared.first(),
            Some(ResponseItem::FunctionCallOutput { output, .. })
                if matches!(
                    output,
                    FunctionCallOutputPayload::Text(text)
                        if text == "Output exceeded the available model context and was truncated"
                )
        ));
        assert_eq!(
            serde_json::to_value(prepared.last()).expect("prepared item should encode"),
            serde_json::to_value(history.last()).expect("original item should encode")
        );
    }

    #[test]
    fn request_estimates_reserve_headroom_for_tokenization_variance() {
        let history = vec![text("user", &"x".repeat(3_500))];
        let raw_estimate = estimate_request_tokens("", &[], &history, &[]);
        let status = evaluate_context_window(ContextWindowEvaluation {
            model_id: "gpt-test",
            base_instructions: "",
            prompt_context: &[],
            history: &history,
            tools: &[],
            snapshot: None,
            auto_compact_limit: Some(raw_estimate.saturating_add(1)),
            context_window: None,
        });

        assert!(status.active_tokens > raw_estimate);
        assert!(status.should_compact);
    }

    #[test]
    fn truncates_an_oversized_newest_user_message_instead_of_skipping_it() {
        let newest_text = "n".repeat((64_000 + 10) * 4);
        let newest = text("user", &newest_text);
        let checkpoint = ResponseItem::Compaction {
            id: Some("checkpoint-1".into()),
            encrypted_content: "encrypted".into(),
            internal_chat_message_metadata_passthrough: None,
        };
        let compacted = build_compacted_history(&[text("user", "old"), newest], checkpoint);

        assert_eq!(compacted.len(), 2);
        let ResponseItem::Message { role, content, .. } = &compacted[0] else {
            panic!("the retained item should be a message");
        };
        assert_eq!(role, "user");
        let retained_text = content
            .iter()
            .find_map(|part| match part {
                ResponseContent::InputText { text } => Some(text),
                _ => None,
            })
            .expect("truncated text should be retained");
        assert!(retained_text.len() < newest_text.len());
        assert!(matches!(
            compacted.last(),
            Some(ResponseItem::Compaction { .. })
        ));
    }

    #[test]
    fn keeps_images_in_a_text_truncated_user_message() {
        let message = ResponseItem::user_content(vec![
            ResponseContent::InputText {
                text: "x".repeat((64_000 + 10) * 4),
            },
            ResponseContent::InputImage {
                image_url: "data:image/png;base64,aGVsbG8=".into(),
                detail: None,
            },
        ]);
        let checkpoint = ResponseItem::Compaction {
            id: Some("checkpoint-image".into()),
            encrypted_content: "encrypted".into(),
            internal_chat_message_metadata_passthrough: None,
        };
        let compacted = build_compacted_history(&[message], checkpoint);

        let ResponseItem::Message { content, .. } = &compacted[0] else {
            panic!("the retained item should be a message");
        };
        assert!(
            content
                .iter()
                .any(|part| matches!(part, ResponseContent::InputImage { .. }))
        );
    }

    #[test]
    fn retained_images_are_charged_to_the_compaction_budget() {
        let image = || {
            ResponseItem::user_content(vec![ResponseContent::InputImage {
                image_url: "data:image/png;base64,aGVsbG8=".into(),
                detail: None,
            }])
        };
        let checkpoint = ResponseItem::Compaction {
            id: Some("checkpoint-images".into()),
            encrypted_content: "encrypted".into(),
            internal_chat_message_metadata_passthrough: None,
        };
        let compacted = build_compacted_history(&vec![image(); 40], checkpoint);
        let retained_images = compacted
            .iter()
            .filter(|item| {
                matches!(
                    item,
                    ResponseItem::Message { content, .. }
                        if content.iter().any(|part| matches!(part, ResponseContent::InputImage { .. }))
                )
            })
            .count();

        assert_eq!(
            retained_images,
            RETAINED_MESSAGE_TOKEN_BUDGET / RESIZED_IMAGE_TOKEN_ESTIMATE as usize
        );
    }

    #[test]
    fn an_image_that_does_not_fit_prevents_backfilling_older_messages() {
        let image = ResponseItem::user_content(vec![ResponseContent::InputImage {
            image_url: "data:image/png;base64,aGVsbG8=".into(),
            detail: None,
        }]);
        let newer_text_tokens = RETAINED_MESSAGE_TOKEN_BUDGET
            .saturating_sub(RESIZED_IMAGE_TOKEN_ESTIMATE as usize)
            .saturating_add(1);
        let newest = text("user", &"n".repeat(newer_text_tokens.saturating_mul(4)));
        let checkpoint = ResponseItem::Compaction {
            id: Some("checkpoint-boundary".into()),
            encrypted_content: "encrypted".into(),
            internal_chat_message_metadata_passthrough: None,
        };
        let compacted = build_compacted_history(&[text("user", "old"), image, newest], checkpoint);

        assert_eq!(compacted.len(), 2);
        assert!(matches!(
            compacted.first(),
            Some(ResponseItem::Message { content, .. })
                if content.iter().any(|part| matches!(part, ResponseContent::InputText { text } if text.starts_with('n')))
        ));
        assert!(matches!(
            compacted.last(),
            Some(ResponseItem::Compaction { .. })
        ));
    }

    #[test]
    fn streaming_json_length_matches_the_encoded_request_shape() {
        let item = text("user", "quoted: \\\"value\\\" and newline:\\nnext");
        let encoded = serde_json::to_vec(&item).expect("test item should encode");

        assert_eq!(serialized_json_len(&item), usize_to_u64(encoded.len()));
    }

    #[test]
    fn full_context_usage_forces_the_next_preflight_to_compact() {
        let window = ModelContextWindow {
            tokens: 272_000,
            usable_tokens: 258_400,
            usable_percent: 95,
            maximum_tokens: Some(400_000),
        };
        let usage = full_context_usage(&window);
        assert_eq!(usage.input_tokens, 272_000);
        assert_eq!(usage.total_tokens, 272_000);

        let snapshot = ContextUsageSnapshot {
            model: "gpt-test".into(),
            usage,
        };
        let status = evaluate_context_window(ContextWindowEvaluation {
            model_id: "gpt-test",
            base_instructions: "",
            prompt_context: &[],
            history: &[text("user", "request that overflowed before model output")],
            tools: &[],
            snapshot: Some(&snapshot),
            auto_compact_limit: Some(244_800),
            context_window: Some(&window),
        });

        assert!(status.should_compact);
    }
}
